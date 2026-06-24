'use strict';

const GtfsRt = require('gtfs-realtime-bindings');
const { getTripInfo, getStopSchedule, isServiceActive } = require('./gtfs-static');

const POLL_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 120_000;
const MAX_LOOKAHEAD_SECS = 90 * 60;

let cache = {};
let lastUpdated = null;
let stale = false;
let lastSuccessMs = Date.now();
let feedDiag = { entityCount: 0, rtOverridesApplied: 0 };

let config = null;

/**
 * Returns seconds-since-Melbourne-midnight for the current moment.
 * Also derives the YYYYMMDD date string and JS weekday (0=Sun) in Melbourne time.
 */
function getMelbourneTimeInfo(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(nowMs));

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const dateStr = `${p.year}${p.month}${p.day}`;          // "20260622"
  const secsSinceMidnight = parseInt(p.hour) * 3600 + parseInt(p.minute) * 60 + parseInt(p.second);
  const midnightEpoch = Math.floor(nowMs / 1000) - secsSinceMidnight;

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const jsDay = dayMap[p.weekday] ?? 0;

  return { dateStr, jsDay, midnightEpoch, secsSinceMidnight };
}

// Parse GTFS time string "HH:MM:SS" (H may exceed 23 for post-midnight trips)
function parseGtfsTime(t) {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function protoToNumber(v) {
  return typeof v === 'object' && v?.toNumber ? v.toNumber() : Number(v);
}

async function poll() {
  const url = process.env.GTFS_RT_URL;
  const key = process.env.GTFS_RT_KEY;

  if (!url || !key) {
    console.error('[poller] GTFS_RT_URL or GTFS_RT_KEY not set — skipping poll');
    return;
  }

  let feed;
  try {
    const res = await fetch(url, {
      headers: key.startsWith('eyJ')
        ? { 'Authorization': `Bearer ${key}` }
        : { 'KeyID': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.error(`[poller] Auth error ${res.status} — check GTFS_RT_KEY`);
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    feed = GtfsRt.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    const staleSec = Math.round((Date.now() - lastSuccessMs) / 1000);
    stale = Date.now() - lastSuccessMs > STALE_THRESHOLD_MS;
    console.error(`[poller] fetch/decode error (${staleSec}s since last success): ${err.message}`);
    return;
  }

  // Build RT override map: `${tripId}:${stopId}` → absolute epoch
  // For sparse feeds (delay only), also store delay seconds as fallback.
  const rtMap = {};
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const tripId = tu.trip?.tripId;
    if (!tripId) continue;

    for (const stu of tu.stopTimeUpdate ?? []) {
      const stopId = stu.stopId;
      if (!stopId) continue;

      const timeProto = stu.departure?.time ?? stu.arrival?.time;
      if (timeProto != null) {
        const epoch = protoToNumber(timeProto);
        if (epoch > 1_000_000_000) { // sanity: valid Unix epoch (post-2001)
          rtMap[`${tripId}:${stopId}`] = { epoch };
          continue;
        }
      }
      const delay = stu.departure?.delay ?? stu.arrival?.delay;
      if (delay != null) {
        rtMap[`${tripId}:${stopId}`] = { delay: protoToNumber(delay) };
      }
    }
  }

  const nowMs = Date.now();
  const nowSec = nowMs / 1000;
  const { dateStr, jsDay, midnightEpoch } = getMelbourneTimeInfo(nowMs);

  const newCache = {};
  let rtOverrides = 0;

  for (const stopCfg of config.stops) {
    const stopId = stopCfg.gtfs_stop_id;
    const schedule = getStopSchedule(stopId);
    const departures = [];

    for (const { trip_id, time } of schedule) {
      const info = getTripInfo(trip_id);

      if (!isServiceActive(info.service_id, dateStr, jsDay)) continue;

      // Base scheduled arrival epoch
      let epoch = midnightEpoch + parseGtfsTime(time);

      // Apply RT override if the feed has data for this trip/stop
      const rt = rtMap[`${trip_id}:${stopId}`];
      if (rt) {
        if (rt.epoch)  { epoch = rt.epoch; rtOverrides++; }
        else if (rt.delay != null) { epoch += rt.delay; rtOverrides++; }
      }

      if (epoch < nowSec - 60) continue;             // already departed
      if (epoch > nowSec + MAX_LOOKAHEAD_SECS) continue; // too far ahead

      departures.push({ route: info.route_short_name, destination: info.trip_headsign, arrivalEpoch: epoch });
    }

    // Route filter (optional per-stop)
    let filtered = departures;
    if (stopCfg.routes?.length > 0) {
      const allowed = new Set(stopCfg.routes.map(String));
      filtered = departures.filter((d) => allowed.has(d.route));
    }

    filtered.sort((a, b) => a.arrivalEpoch - b.arrivalEpoch);
    newCache[stopId] = filtered.slice(0, stopCfg.max_rows ?? 8);
  }

  cache = newCache;
  lastUpdated = Date.now();
  lastSuccessMs = Date.now();
  stale = false;
  feedDiag = { entityCount: feed.entity.length, rtOverridesApplied: rtOverrides };

  const total = Object.values(cache).reduce((n, arr) => n + arr.length, 0);
  console.log(`[poller] updated — ${total} departure(s) across ${config.stops.length} stop(s), ${rtOverrides} RT override(s)`);
}

function start(appConfig) {
  config = appConfig;
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

function getCacheForStop(stopId) {
  return { departures: cache[stopId] ?? [], lastUpdated, stale };
}

function getFeedDiag() { return feedDiag; }

module.exports = { start, getCacheForStop, getFeedDiag };
