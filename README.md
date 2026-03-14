# Di2va

**Visualize your Shimano Di2 electronic gear shift data from Strava cycling activities** — see exactly what gear you were in at every point on a map and elevation profile, with interactive gear statistics and a drivetrain visualization.

![screenshot](https://img.shields.io/badge/status-development-orange)

![Di2va ride overview](docs/screenshots/di2va-ride-overview.png)

*A ride loaded in Di2va — map colored by gear, elevation profile with gear/gradient overlay, hover panel showing live data, and gear usage summary with clickable statistics.*

## Why?

I'm a keen cyclist — nothing serious, very much an amateur — but I'm genuinely interested in the tech side of riding. I run a Shimano Di2 electronic groupset on my bike and became increasingly frustrated that **Strava still does not include Di2 electronic shifter data in its ride analysis**. The gear data is right there in the FIT file uploaded by my bike computer, but Strava just ignores it.

Understanding how I use my gears is really useful to me. Am I cross-chaining? Am I spending all my time in one gear when I could be shifting more? On a long climb, did I run out of gears or was I pacing my shifting well?

I was inspired by **[Di2Stats.com](https://di2stats.com)** — a great service that does something similar. Check it out. Di2va takes a different approach: it runs entirely on your own machine and connects directly to your Strava account via the API.

> **See the [full setup guide with screenshots](docs/SETUP_GUIDE.md)** for step-by-step instructions on connecting to the Strava API, including details of where your data is processed and what is sent where.

## Features

- **Strava OAuth** — Securely connect your Strava account (credentials stored locally, never committed)
- **Activity Browser** — Browse your rides, filtered to cycling only
- **Map Overlay** — Route colored by gear selection (front/rear combo)
- **Elevation Profile** — Interactive Chart.js elevation chart with gear & gradient overlay, chart magnifier on hover
- **Auto-Download FIT Files** — Automatically fetches the original FIT file from Strava's export endpoint
- **FIT Library Matching** — Optionally point at a folder of FIT files to auto-match by timestamp
- **Di2 Data from FIT Files** — Parses `.FIT` files for actual Di2 gear shift events from your electronic groupset
- **Gear Estimation** — When no FIT file is available, estimates gears from cadence + speed
- **Gear Statistics** — Breakdown of time spent in each gear combination with colour-coded cards
- **Interactive Gear Popup** — Click any gear to see an animated SVG drivetrain visualization with the full Dura-Ace 9200 cassette and chainrings
- **Arrow Key Gear Cycling** — Use left/right arrow keys to step through all gears used in the ride, or click the nav bar chips
- **Interactive Hover** — Hover over the elevation chart to see gear, speed, cadence, power, and gradient at any point; synced with map marker
- **Units Switcher** — Toggle between metric and imperial

## Data Privacy

**All data processing happens on your local machine.** Di2va is a local web app running at `localhost:3000`. The only network traffic is between your machine and Strava's API (to fetch your activity data) and CARTO's tile CDN (for map tiles). No data is sent to any other third-party service. See the [setup guide](docs/SETUP_GUIDE.md) for a full data flow diagram.

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

---

<sub>**This code is AI-generated.** Built using <a href="https://code.visualstudio.com/download">Visual Studio Code</a> with <a href="https://github.com/features/copilot">GitHub Copilot</a> powered by the <b>Claude Opus 4.6</b> model by <a href="https://www.anthropic.com/">Anthropic</a>.<br>
Download VS Code: <a href="https://code.visualstudio.com/download">https://code.visualstudio.com/download</a><br><br>
<b>Author:</b> <a href="https://github.com/vinfnet">vinfnet</a> — This is a personal project and is not affiliated with, endorsed by, or connected to my employer in any way. I do not endorse any of the technologies, products, or services mentioned (Strava, Shimano, Di2, Garmin, etc.) — I simply find this a useful way to experiment with cycling data and AI-assisted development.</sub>
