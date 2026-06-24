# TramTracker — Melbourne Tram Departure Board

A lightweight Node.js departure board for Yarra Trams, sized for a digital lift screen. One backend poller serves all screens. No framework, no heavy dependencies.

---

## Quick start

```bash
cp .env.example .env          # fill in your API key and URLs
cp config.example.json config.json   # configure your stops
npm install
npm run refresh-gtfs          # build static GTFS lookups (run once, then ~quarterly)
npm start
# open http://localhost:3000/?stop=<your_gtfs_stop_id>
```

---

## 1. Get an API key

Register at **https://opendata.transport.vic.gov.au/**. Create a free account and request access to the *"GTFS Realtime — Tram"* feed (and the static GTFS zip if you want to pull that from the same portal). Your API key is sent in the `Ocp-Apim-Subscription-Key` request header — the backend handles this; it never reaches the browser.

---

## 2. Find a stop's GTFS stop_id

> **Important:** The GTFS `stop_id` is **not** the 4-digit number on the tram pole (the "TramTracker" stop number). They are different identifiers.

To find the right `stop_id`:

1. Download (or generate) `data/stops.json` by running `npm run refresh-gtfs`.
2. Open `data/stops.json` and search for the stop name you recognise (e.g. `"Swanston St/Bourke St"` or `"Collins St/Swanston St"`). The key of each entry is the `stop_id`.
3. Alternatively, open the raw `stops.txt` from the GTFS zip and search by `stop_name`.

You can also cross-reference using the PTV Journey Planner or the TramTracker app to identify the street corner, then match it in `stops.txt`.

---

## 3. Configure stops

Edit `config.json` (copy from `config.example.json`):

```json
{
  "stops": [
    {
      "gtfs_stop_id": "19854",
      "label": "Swanston St / Flinders St",
      "routes": [],
      "max_rows": 6
    },
    {
      "gtfs_stop_id": "19870",
      "label": "Elizabeth St / Bourke St",
      "routes": ["57", "59"],
      "max_rows": 4
    }
  ],
  "layout": "portraitA",
  "refreshSeconds": 25,
  "branding": {
    "title": "Tram Departures",
    "logo": null
  }
}
```

| Field | Description |
|---|---|
| `gtfs_stop_id` | GTFS stop_id from stops.txt |
| `label` | Human-readable name shown on the board |
| `routes` | Array of route numbers to show (e.g. `["86","96"]`). Empty = all routes. |
| `max_rows` | Max departures to show for this stop |
| `layout` | `"portraitA"` = 1080×1440 (3:4), `"portraitB"` = 1024×576 (16:9) |
| `refreshSeconds` | How often the browser re-polls the API (10–60 recommended) |
| `branding.logo` | Path to a logo image served from `src/public/` (optional) |

Each screen URL is `http://localhost:3000/?stop=<gtfs_stop_id>`.

---

## 4. GTFS static data (refresh-gtfs)

The static GTFS data (stops, routes, timetables) is downloaded once and stored as JSON lookup files in `data/`. These are used to resolve route numbers and destination names from the realtime feed.

```bash
npm run refresh-gtfs
```

**Re-run this command after each major timetable update** (PTV typically updates timetables 2–4 times per year). The realtime feed will still work between updates but newly added routes or stops may appear with `?` for the route number until you refresh.

The `data/` folder is excluded from git (`.gitignore`). Re-run after cloning or deploying.

---

## 5. Running locally

```bash
npm install
cp .env.example .env && cp config.example.json config.json
# edit .env with your API key, edit config.json with your stop(s)
npm run refresh-gtfs
npm start
```

Open `http://localhost:3000/?stop=<gtfs_stop_id>` in a browser on the screen.

The server polls the GTFS-RT feed every 30 seconds. The browser re-polls the local API every `refreshSeconds` seconds (default 25). The API key never leaves the server.

---

## 6. Docker

```bash
# Build
docker build -t tramtracker .

# Build static data (first time, or after timetable change)
docker run --rm -v "$(pwd)/data:/app/data" --env-file .env tramtracker node scripts/refresh-gtfs.js

# Run
docker run -d \
  --name tramtracker \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/config.json:/app/config.json" \
  --env-file .env \
  tramtracker
```

---

## 7. Deploying to a VPS / Render / Railway

### VPS (e.g. Hetzner, DigitalOcean)

1. Copy files to the server (rsync or git clone).
2. Set env vars in `.env` or via systemd `EnvironmentFile`.
3. Run `npm run refresh-gtfs` once on the server.
4. Use `pm2 start src/server.js --name tramtracker` for process management.
5. Put nginx in front for HTTPS (`proxy_pass http://localhost:3000`).

### Render / Railway

1. Push repo to GitHub (ensure `data/` is in `.gitignore` — don't commit the JSON lookups).
2. Add env vars (`GTFS_RT_URL`, `GTFS_RT_KEY`, `GTFS_STATIC_URL`, `PORT`) in the dashboard.
3. Set the **start command** to: `node scripts/refresh-gtfs.js && node src/server.js`
   This rebuilds the GTFS lookups on each deploy (adds ~10–20s startup time but keeps the data current).
4. Alternatively, use a build command for `npm run refresh-gtfs` and keep start as `npm start`.

### Adapting to serverless (future)

The single-poller design doesn't fit traditional serverless well because there's no persistent process to hold the cache. To adapt:
- Move the poller to a **scheduled function** (e.g. Vercel Cron, AWS EventBridge → Lambda) that runs every 30s and writes results to a KV store (Redis, Upstash, Vercel KV).
- The API handler reads from KV rather than an in-memory cache.
- Static GTFS lookups can be bundled with the function or stored in an object store.

---

## Health check

`GET /healthz` returns `{ ok: true, stale: false, lastUpdated: <ms> }`. Wire this up to your uptime monitor (UptimeRobot, Better Uptime, etc.).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server exits with "stops.json not found" | Run `npm run refresh-gtfs` first |
| Board shows "Data delayed" banner | Feed is unreachable; last known data is still displayed. Check `GTFS_RT_URL`/`GTFS_RT_KEY`. |
| Route shows `?` | The trip_id isn't in `trips.json` — re-run `npm run refresh-gtfs` to pick up timetable changes |
| No departures for a stop | Check `gtfs_stop_id` is correct (see section 2). Also check the `routes` filter isn't excluding everything. |
