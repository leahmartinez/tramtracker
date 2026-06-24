'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');

function parseCsv(data) {
  // Strip UTF-8 BOM (﻿) that some GTFS files include at the start
  const clean = data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data;
  return parse(clean, { columns: true, skip_empty_lines: true, trim: true });
}

function makeReader(zip, prefix = '') {
  return function readCsv(filename) {
    const candidates = [prefix ? `${prefix}/${filename}` : null, filename].filter(Boolean);
    let entry = null;
    for (const name of candidates) {
      entry = zip.getEntry(name);
      if (entry) break;
    }
    if (!entry) throw new Error(`${filename} not found in zip (tried: ${candidates.join(', ')})`);
    return parseCsv(entry.getData().toString('utf8'));
  };
}

function getEntryBuffer(zip, prefix, filename) {
  const candidates = [prefix ? `${prefix}/${filename}` : null, filename].filter(Boolean);
  for (const name of candidates) {
    const entry = zip.getEntry(name);
    if (entry) return entry.getData();
  }
  return null;
}

// Strip surrounding double-quotes from a CSV field value (PTV GTFS quotes all values)
const unquote = (s) => (s ?? '').trim().replace(/^"|"$/g, '');

// Stream-parse a CSV buffer line by line — avoids loading huge files into memory at once.
// Only calls onRow for lines where the stop_id column matches stopIds.
function streamFilterCsv(buffer, stopIds, onRow) {
  return new Promise((resolve, reject) => {
    let header = null;
    let stopIdCol = -1;
    const rl = readline.createInterface({ input: Readable.from(buffer), crlfDelay: Infinity });
    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;
      if (!header) {
        // Strip BOM from first column name and unquote all header fields
        header = line.split(',').map((s, i) =>
          unquote(i === 0 ? s.replace(/^﻿/, '') : s)
        );
        stopIdCol = header.indexOf('stop_id');
        return;
      }
      // Quick pre-filter before full parse
      let match = false;
      for (const id of stopIds) { if (line.includes(id)) { match = true; break; } }
      if (!match) return;
      const fields = line.split(',');
      const stopId = unquote(fields[stopIdCol]);
      if (!stopIds.has(stopId)) return;
      const row = {};
      header.forEach((h, i) => { row[h] = unquote(fields[i]); });
      onRow(row);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// Identify Yarra Trams via agency.txt name; fallback to distinctive route numbers
const TRAM_AGENCY = /yarra.?trams|metropolitan.?tram/i;
const DISTINCTIVE_ROUTES = new Set(['86', '96', '109', '112', '75', '78', '79', '82']);

function getAgencyName(zip, prefix = '') {
  try {
    const rows = makeReader(zip, prefix)('agency.txt');
    return rows.map((r) => r.agency_name ?? r.agency_id ?? '').join(', ');
  } catch { return '(no agency.txt)'; }
}

function isTramZip(zip, prefix = '') {
  try {
    const reader = makeReader(zip, prefix);
    try {
      const agencies = reader('agency.txt');
      if (agencies.some((a) => TRAM_AGENCY.test(a.agency_name))) return true;
    } catch { /* fall through */ }
    const routes = reader('routes.txt');
    return routes.filter((r) => DISTINCTIVE_ROUTES.has(r.route_short_name)).length >= 3;
  } catch { return false; }
}

async function main() {
  let buffer;

  const localZip = process.env.GTFS_STATIC_ZIP;
  if (localZip) {
    console.log(`Loading static GTFS from local file: ${localZip}`);
    buffer = fs.readFileSync(localZip);
    console.log(`Loaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  } else {
    const url = process.env.GTFS_STATIC_URL;
    if (!url) {
      console.error('Error: set GTFS_STATIC_URL in .env (download URL), or GTFS_STATIC_ZIP (local file path).');
      process.exit(1);
    }
    const key = process.env.GTFS_RT_KEY;
    const headers = key ? { 'KeyID': key } : {};
    console.log(`Downloading static GTFS from ${url} ...`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`Download failed: HTTP ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    buffer = Buffer.from(await res.arrayBuffer());
    console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  }

  const outerZip = new AdmZip(buffer);
  const allEntries = outerZip.getEntries().map((e) => e.entryName);

  let workingZip = null;
  let foundVia = '';

  if (allEntries.includes('stops.txt')) {
    workingZip = outerZip;
    foundVia = 'root';
  }

  if (!workingZip) {
    const nestedZips = allEntries.filter((n) => /\.zip$/i.test(n));
    console.log(`  Scanning ${nestedZips.length} nested operator zip(s):`);
    for (const entry of nestedZips) {
      const inner = new AdmZip(outerZip.getEntry(entry).getData());
      const agency = getAgencyName(inner);
      const isTram = isTramZip(inner);
      console.log(`    ${entry}: ${agency}${isTram ? ' ← TRAM' : ''}`);
      if (isTram && !workingZip) {
        workingZip = inner;
        foundVia = entry;
      }
    }
  }

  if (!workingZip) {
    const subdirs = [...new Set(allEntries.map((n) => n.split(/[\/\\]/)[0]))];
    for (const dir of subdirs) {
      if (isTramZip(outerZip, dir)) {
        workingZip = outerZip;
        foundVia = `${dir}/ subdirectory`;
        console.log(`  Found tram data in subdirectory: ${dir}/`);
        break;
      }
    }
  }

  if (!workingZip) {
    const tops = [...new Set(allEntries.map((n) => n.split(/[\/\\]/)[0]))].slice(0, 30);
    console.error('Could not find Yarra Trams data. Top-level entries:');
    for (const t of tops) console.error('  ' + t);
    throw new Error('No tram operator zip found.');
  }

  console.log(`Using: ${foundVia}`);

  const prefix = foundVia.endsWith(' subdirectory')
    ? foundVia.replace(/ subdirectory$/, '').replace(/[\/\\]+$/, '')
    : '';
  const readCsv = makeReader(workingZip, prefix);

  // ── Core GTFS files ───────────────────────────────────────────────────────

  console.log('Parsing stops.txt ...');
  const stopsRows = readCsv('stops.txt');
  const stops = {};
  for (const row of stopsRows) stops[row.stop_id] = row.stop_name;
  console.log(`  ${Object.keys(stops).length} stops`);

  console.log('Parsing routes.txt ...');
  const routesRows = readCsv('routes.txt');
  const routeShortName = {};
  for (const row of routesRows) routeShortName[row.route_id] = row.route_short_name;
  console.log(`  ${Object.keys(routeShortName).length} routes — sample: ${Object.values(routeShortName).slice(0, 10).join(', ')}`);

  console.log('Parsing trips.txt ...');
  const tripsRows = readCsv('trips.txt');
  const trips = {};
  for (const row of tripsRows) {
    trips[row.trip_id] = {
      route_short_name: routeShortName[row.route_id] ?? row.route_id,
      trip_headsign: row.trip_headsign ?? '',
      service_id: row.service_id ?? '',
    };
  }
  console.log(`  ${Object.keys(trips).length} trips`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'stops.json'), JSON.stringify(stops));
  fs.writeFileSync(path.join(DATA_DIR, 'trips.json'), JSON.stringify(trips));

  // ── Calendar (service dates) ───────────────────────────────────────────────

  console.log('Parsing calendar.txt ...');
  const services = {};
  try {
    const calRows = readCsv('calendar.txt');
    for (const r of calRows) {
      // days array: index 0=Monday … 5=Saturday, 6=Sunday (matches GTFS column order)
      services[r.service_id] = {
        days: [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday].map(Number),
        start: r.start_date,
        end: r.end_date,
      };
    }
    console.log(`  ${Object.keys(services).length} service entries`);
  } catch (e) { console.warn(`  calendar.txt not found: ${e.message}`); }

  const exceptions = {};
  try {
    const cdRows = readCsv('calendar_dates.txt');
    for (const r of cdRows) {
      if (!exceptions[r.date]) exceptions[r.date] = {};
      exceptions[r.date][r.service_id] = Number(r.exception_type);
    }
    console.log(`  ${Object.keys(exceptions).length} exception date(s) in calendar_dates.txt`);
  } catch (e) { console.warn(`  calendar_dates.txt: ${e.message}`); }

  fs.writeFileSync(path.join(DATA_DIR, 'calendar.json'), JSON.stringify({ services, exceptions }));

  // ── Stop timetable (filtered to configured stops) ─────────────────────────

  const configPath = path.join(process.cwd(), 'config.json');
  let configuredStopIds = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const s of cfg.stops) configuredStopIds.add(String(s.gtfs_stop_id));
    console.log(`\nExtracting schedule for stop_ids: ${[...configuredStopIds].join(', ')}`);
  } catch {
    console.warn('\nconfig.json not found — skipping stop_times.txt extraction');
  }

  if (configuredStopIds.size > 0) {
    const stBuf = getEntryBuffer(workingZip, prefix, 'stop_times.txt');
    if (!stBuf) {
      console.warn('stop_times.txt not found in zip — departure board will show no schedule data');
    } else {
      const stopSchedule = {};
      for (const sid of configuredStopIds) stopSchedule[sid] = [];

      console.log('Parsing stop_times.txt (streaming, may take a moment) ...');
      await streamFilterCsv(stBuf, configuredStopIds, (row) => {
        // Prefer departure_time; fall back to arrival_time
        const t = row.departure_time || row.arrival_time;
        if (t && stopSchedule[row.stop_id]) {
          stopSchedule[row.stop_id].push({ trip_id: row.trip_id, time: t });
        }
      });

      for (const sid of configuredStopIds) {
        console.log(`  Stop ${sid}: ${stopSchedule[sid].length} scheduled trips`);
      }

      fs.writeFileSync(path.join(DATA_DIR, 'stop_schedule.json'), JSON.stringify(stopSchedule));
      console.log('  Written data/stop_schedule.json');
    }
  }

  console.log('\nDone. Written data/stops.json, trips.json, calendar.json' +
    (configuredStopIds.size > 0 ? ', stop_schedule.json' : '') + '.');
  console.log('Re-run after each major timetable update (roughly quarterly).');
}

main().catch((err) => {
  console.error('refresh-gtfs failed:', err.message);
  process.exit(1);
});
