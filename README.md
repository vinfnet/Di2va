# Di2va

Visualize your Shimano Di2 gear shift data from Strava cycling activities — see exactly what gear you were in at every point on a **map** and **elevation profile**.

![screenshot](https://img.shields.io/badge/status-development-orange)

## Features

- **Strava OAuth** — Securely connect your Strava account
- **Activity Browser** — Browse your rides, filtered to cycling only
- **Map Overlay** — Route colored by gear selection (front/rear combo)
- **Elevation Profile** — Interactive Chart.js elevation chart with gear & gradient overlay
- **Di2 Data from FIT Files** — Upload `.FIT` files from your bike computer for actual Di2 gear shift data
- **Gear Estimation** — When no FIT file is available, estimates gears from cadence + speed
- **Gear Statistics** — Breakdown of time spent in each gear combination
- **Interactive Hover** — Hover over the elevation chart to see gear, speed, cadence, power, and gradient at that point; synced with map marker

## Prerequisites

- **Node.js** 18+ and npm
- A **Strava API Application** (free)

## Setup

### 1. Create a Strava API App

1. Go to [https://www.strava.com/settings/api](https://www.strava.com/settings/api)
2. Create a new application:
   - **Application Name**: Di2va (or anything you like)
   - **Category**: Visualizer
   - **Authorization Callback Domain**: `localhost`
3. Note your **Client ID** and **Client Secret**

### 2. Configure Environment

On first run the application will prompt to connect to your Strava account and store the API keys on your device - ensure the .env file is secure - it contains credentials to your Strava account.

```bash
cp .env.example .env
```

Edit `.env` and fill in your Strava credentials:

```env
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=abc123...
SESSION_SECRET=any-random-string-here
```

### 3. Install & Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Development Mode

```bash
npm run dev
```

Uses `nodemon` for auto-restart on file changes.

## How It Works

### Data Sources

1. **Strava API Streams** — GPS coordinates, elevation, cadence, speed, power, gradient
2. **Gear Estimation** — Uses cadence and speed to mathematically estimate which gear combination is in use (assumes standard road bike gearing)
3. **FIT File Upload** — For actual Di2 data, upload the `.FIT` file from your bike computer (e.g. Garmin, Wahoo). This contains the real gear change events recorded by the Di2 system

### Gear Estimation Algorithm

When no FIT file is available, the app estimates gears using:

```
gear_ratio = speed / (cadence × wheel_circumference)
```

It then matches this against known chainring/cassette combinations:
- **Chainrings**: 34/50 (compact) or 39/53 (standard)
- **Cassette**: 11-28 (11-speed)

The confidence of each estimate is classified as high/medium/low based on how close the match is.

### Color Scheme

Gears are colored from **red (easiest)** → **blue/purple (hardest)** based on the rear cassette position:
- 🔴 Large cog (easier gears) — warm colors
- 🔵 Small cog (harder gears) — cool colors

## Architecture

```
di2va/
├── server.js              # Express server, Strava OAuth, API proxy, FIT parser
├── .env                   # Environment variables (not in git)
├── .env.example           # Template for .env
├── package.json
└── public/
    ├── index.html         # Single-page app shell
    ├── styles.css         # Dark theme UI
    └── app.js             # Frontend: map, chart, gear logic
```

### Tech Stack

- **Backend**: Node.js, Express, express-session, axios, multer, fit-file-parser
- **Frontend**: Vanilla JS (no framework), Leaflet.js (maps), Chart.js (elevation), CARTO dark tiles
- **APIs**: Strava V3 API

## Customizing Gearing

If your bike uses different gearing (e.g. 1x, different cassette), edit the constants in:

- `server.js` → `POST /api/estimate-gears` — `CHAINRINGS` and `CASSETTE` arrays
- `public/app.js` → `getGearColor()` — `CASSETTE` reference array

## Troubleshooting

| Issue | Solution |
|-------|---------|
| "Not authenticated" error | Make sure your Strava API callback domain is set to `localhost` |
| No gear data shown | Upload a `.FIT` file, or ensure the activity has cadence data for estimation |
| FIT file parsing fails | Ensure the file is a valid `.FIT` file from a compatible device |
| Activities not loading | Check that the Strava API scope includes `activity:read_all` |

## License

MIT
