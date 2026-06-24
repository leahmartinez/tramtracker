'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

// Fail fast if static GTFS data hasn't been built
let gtfsStatic;
try {
  gtfsStatic = require('./gtfs-static');
} catch (err) {
  console.error('[server] ' + err.message);
  process.exit(1);
}

// Load config
const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`[server] config.json not found at ${configPath}. Copy config.example.json to config.json and edit it.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Index stops by id for quick lookup
const stopIndex = {};
for (const s of config.stops) {
  stopIndex[s.gtfs_stop_id] = s;
}

// Start the poller
const poller = require('./poller');
poller.start(config);

const app = express();

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// Inject config subset into the page so the frontend knows layout/branding/stops
app.get('/api/config', (_req, res) => {
  res.json({
    stops: config.stops.map((s) => ({
      gtfs_stop_id: s.gtfs_stop_id,
      label: s.label,
      max_rows: s.max_rows ?? 2,
    })),
    layout: config.layout ?? 'portraitA',
    refreshSeconds: config.refreshSeconds ?? 25,
    branding: config.branding ?? { title: 'Tram Departures', logo: null },
  });
});

// Departures endpoint — ?stop=<id> for one stop, ?stop=all (or omitted) for all configured stops
app.get('/api/departures', (req, res) => {
  const stopParam = req.query.stop;

  if (!stopParam || stopParam === 'all') {
    const stopResults = config.stops.map((stopCfg) => {
      const { departures, lastUpdated, stale } = poller.getCacheForStop(stopCfg.gtfs_stop_id);
      return {
        stop: {
          id: stopCfg.gtfs_stop_id,
          label: stopCfg.label,
          name: gtfsStatic.getStopName(stopCfg.gtfs_stop_id),
        },
        departures,
        lastUpdated,
        stale,
      };
    });
    const overallStale = stopResults.some((r) => r.stale);
    const overallLastUpdated = stopResults.reduce((max, r) => Math.max(max, r.lastUpdated ?? 0), 0) || null;
    return res.json({ mode: 'all', stops: stopResults, lastUpdated: overallLastUpdated, stale: overallStale });
  }

  const stopCfg = stopIndex[stopParam];
  if (!stopCfg) {
    return res.status(404).json({ error: `Stop ${stopParam} is not in config.json` });
  }
  const { departures, lastUpdated, stale } = poller.getCacheForStop(stopParam);
  res.json({
    mode: 'single',
    stop: { id: stopParam, label: stopCfg.label, name: gtfsStatic.getStopName(stopParam) },
    departures,
    lastUpdated,
    stale,
  });
});

// Debug endpoint — shows raw cache for all stops plus feed diagnostics
app.get('/api/debug', (_req, res) => {
  const now = Date.now() / 1000;
  const diag = poller.getFeedDiag();
  const result = config.stops.map((stopCfg) => {
    const { departures, lastUpdated, stale } = poller.getCacheForStop(stopCfg.gtfs_stop_id);
    return {
      stop_id: stopCfg.gtfs_stop_id,
      label: stopCfg.label,
      departures: departures.map((d) => ({
        ...d,
        minsAway: Math.round((d.arrivalEpoch - now) / 60),
        departureTime: new Date(d.arrivalEpoch * 1000).toLocaleTimeString('en-AU', {
          timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      })),
      lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
      stale,
    };
  });
  res.json({
    serverTime: new Date().toISOString(),
    feed: {
      entityCount: diag.entityCount,
      sampleStopIds: diag.stopIdsInFeed,
    },
    stops: result,
  });
});

// Health check
app.get('/healthz', (_req, res) => {
  const { lastUpdated, stale } = poller.getCacheForStop(config.stops[0]?.gtfs_stop_id ?? '');
  res.json({ ok: true, stale, lastUpdated });
});

const port = parseInt(process.env.PORT ?? '3000', 10);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] configured stops: ${config.stops.map((s) => s.gtfs_stop_id).join(', ')}`);
});
