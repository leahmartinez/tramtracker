'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJson(filename, required = true) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    if (required) throw new Error(`${filename} not found. Run \`npm run refresh-gtfs\` first.`);
    return null;
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

const stops = loadJson('stops.json');
const trips = loadJson('trips.json');

// Optional — built when config.json is present at refresh time
const stopScheduleData = loadJson('stop_schedule.json', false) ?? {};
const calendarData = loadJson('calendar.json', false) ?? { services: {}, exceptions: {} };

function getStopName(stopId) {
  return stops[stopId] ?? `Stop ${stopId}`;
}

function getTripInfo(tripId) {
  const t = trips[tripId];
  return {
    route_short_name: t?.route_short_name ?? '?',
    trip_headsign:    t?.trip_headsign   ?? 'Unknown',
    service_id:       t?.service_id      ?? '',
  };
}

function getStopSchedule(stopId) {
  return stopScheduleData[stopId] ?? [];
}

// calendar.json days[]: index 0=Monday … 5=Saturday, 6=Sunday (GTFS column order)
// jsDay: JS Date.getDay() — 0=Sunday, 1=Monday … 6=Saturday
// Conversion: (jsDay + 6) % 7 maps JS → GTFS index
function isServiceActive(serviceId, dateStr, jsDay) {
  const { services, exceptions } = calendarData;

  const exc = exceptions[dateStr]?.[serviceId];
  if (exc === 2) return false; // removed for this date
  if (exc === 1) return true;  // added for this date

  const svc = services[serviceId];
  if (!svc) return false;
  if (dateStr < svc.start || dateStr > svc.end) return false;

  return svc.days[(jsDay + 6) % 7] === 1;
}

module.exports = { getStopName, getTripInfo, getStopSchedule, isServiceActive };
