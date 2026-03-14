# Di2va — Setup Guide

## Why Di2va?

I'm a keen cyclist — nothing serious, very much an amateur — but I find the tech side of riding genuinely interesting. I run a Shimano Di2 electronic groupset and was increasingly frustrated that **Strava still does not include Di2 electronic shifter data in its ride analysis**. The gear data is right there in the FIT file uploaded by my bike computer, but Strava just ignores it.

To me, understanding how I use my gears is really useful. Am I cross-chaining? Am I spending all my time in one gear when I could be shifting more? On a long climb, did I run out of gears or was I pacing my shifting well? These are exactly the kinds of questions a tool like this can answer.

I was inspired by [Di2Stats.com](https://di2stats.com) — it's a great service that does something similar. Check it out if you haven't already. Di2va takes a different approach by running entirely on your own machine and connecting directly to your Strava account via the API.

---

## How It Works — Data Processing & Privacy

**All data processing happens on your local machine.** Here's exactly what goes where:

| What | Where it's processed | Where it's sent |
|------|---------------------|-----------------|
| Your Strava credentials (Client ID, Secret) | Stored in `.env.local` on your machine (gitignored) | Sent to Strava's OAuth server (`strava.com`) to authenticate |
| OAuth access/refresh tokens | Stored in an Express session cookie in your browser | Sent to Strava's API with each request |
| Activity list, GPS streams, elevation, cadence, power | Fetched from Strava's API → processed in Node.js on your machine | Nowhere — stays on your machine |
| FIT files (Di2 gear shift data) | Parsed locally by `fit-file-parser` on your machine | Nowhere — stays on your machine |
| The Di2va web UI | Served from `localhost:3000` on your machine | Nowhere — it's a local web app |

**No data is sent to any third-party service.** The only network traffic is between your machine and Strava's API (which you already authorised when you created your Strava account). Map tiles are loaded from CARTO's CDN (standard OpenStreetMap tiles).

---

## Step-by-Step: Connecting to the Strava API

### Step 1 — Create a Strava API Application

You need your own Strava API "application" — this is free and takes about 60 seconds. It gives you a Client ID and Client Secret that Di2va uses to talk to Strava on your behalf.

1. **Log in to Strava** in your browser
2. Go to **[https://www.strava.com/settings/api](https://www.strava.com/settings/api)**

> ![Screenshot: Strava API Settings page](screenshots/01-strava-api-settings.png)
>
> *You'll see the "My API Application" page. If you've never created one, it will show a form.*

3. Fill in the application details:

| Field | Value |
|-------|-------|
| **Application Name** | `Di2va` (or anything you like) |
| **Category** | `Visualizer` |
| **Club** | *(leave blank)* |
| **Website** | `http://localhost:3000` |
| **Authorization Callback Domain** | `localhost` |
| **Description** | *(optional — e.g. "Di2 gear visualization")* |

> ![Screenshot: Strava API application form filled in](screenshots/02-strava-create-app.png)
>
> *The key field is **Authorization Callback Domain** — it must be exactly `localhost`.*

4. Click **Create** (or **Update** if editing an existing app)

5. You'll now see your **Client ID** (a number like `12345`) and **Client Secret** (a long hex string). **Keep this page open** — you'll need both values in the next step.

> ![Screenshot: Strava showing Client ID and Client Secret](screenshots/03-strava-credentials.png)
>
> *Your Client ID and Client Secret are shown on this page. The secret is hidden by default — click to reveal it.*

---

### Step 2 — Install Di2va

Make sure you have **Node.js 18+** installed. Then:

```bash
git clone https://github.com/vinfnet/Di2va.git
cd Di2va
npm install
```

---

### Step 3 — Start Di2va

```bash
npm start
```

You'll see:

```
🚴 Di2va running at http://localhost:3000

  ⚡ First-time setup required!
  → Open http://localhost:3000/setup to configure your Strava API credentials
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

### Step 4 — Enter Your Strava Credentials

On first run, Di2va redirects you to the setup page:

> ![Screenshot: Di2va setup page](screenshots/04-di2va-setup.png)
>
> *The setup page asks for your Client ID and Client Secret from Step 1.*

1. **Paste your Client ID** from the Strava API page
2. **Paste your Client Secret**
3. Leave **Session Secret** blank (it auto-generates a secure one)
4. Click **Save & Connect to Strava →**

Your credentials are saved to a `.env.local` file on your machine. This file is gitignored and never committed to the repository.

---

### Step 5 — Authorise with Strava

After saving your credentials, you'll be redirected to Strava's authorisation page:

> ![Screenshot: Strava OAuth authorisation page](screenshots/05-strava-authorize.png)
>
> *Strava asks you to confirm that Di2va can read your activity data. The permissions requested are `read` and `activity:read_all`.*

Click **Authorize** to grant Di2va access to your activities.

---

### Step 6 — Browse Your Rides

After authorising, you'll be taken to the main Di2va interface. Your recent cycling activities are listed on the left:

> ![Screenshot: Di2va main interface with activity list](screenshots/06-di2va-main.png)
>
> *Click any ride to load it. The map shows your route colored by gear, and the elevation profile shows gear usage over time.*

---

### Step 7 — View Di2 Gear Data

Click a ride to load it. If the ride has a FIT file with Di2 data, the gear information is automatically extracted and displayed:

- **Route map** — colored by gear combination (red = easy, blue = hard)
- **Elevation profile** — hover to see gear, speed, cadence, and gradient at any point
- **Gear statistics** — percentage of time in each gear, click any gear to see the interactive drivetrain visualization

> ![Screenshot: Di2va showing a ride with gear data](screenshots/07-di2va-ride.png)
>
> *A ride loaded with Di2 gear data. The map and elevation profile are colored by gear. Hover over the chart to see details.*

If no FIT file is available, Di2va estimates gears from cadence and speed data.

---

### Step 8 — Configure FIT File Library (Optional)

If Di2va can't automatically download the FIT file from Strava (this depends on how you upload rides), you can point it at a folder of FIT files:

1. Click the **⚙ Settings** icon
2. Enter the path to your FIT files folder (e.g. `~/Downloads`)
3. Di2va will scan this folder and match FIT files to Strava activities by timestamp

> ![Screenshot: Di2va settings for FIT library folder](screenshots/08-di2va-settings.png)
>
> *Point Di2va at your Downloads folder (or wherever your bike computer exports FIT files).*

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Not authenticated" error** | Make sure the Authorization Callback Domain in your Strava API app is set to exactly `localhost` |
| **No gear data shown** | The ride may not have a FIT file with Di2 data. Try configuring the FIT Library folder in Settings |
| **Activities not loading** | Check your Strava API credentials are correct. Try restarting with `npm start` |
| **"Token expired" errors** | Di2va auto-refreshes tokens, but if your session expired, click "Connect with Strava" to re-authenticate |
| **Can't see Di2 shifts** | Make sure your Di2 system is configured to record gear data in your bike computer's FIT output |

---

## Data Flow Diagram

```
┌─────────────────┐     OAuth      ┌──────────────────┐
│   Your Browser   │◄─────────────►│   Strava.com     │
│  localhost:3000  │   (HTTPS)     │   (OAuth + API)  │
└────────┬────────┘               └──────────────────┘
         │                                  ▲
         │ HTTP                             │ HTTPS
         ▼                                  │
┌─────────────────┐    API calls    ────────┘
│   Di2va Server   │───────────────►
│  (your machine)  │
│   Node.js/Express│
└────────┬────────┘
         │
         │ Reads FIT files
         ▼
┌─────────────────┐
│  Your FIT Files  │
│ (local disk)     │
└─────────────────┘
```

**Everything inside the dotted boundary runs on your machine. The only external service contacted is Strava's API.**

---

## Adding Screenshots

The `docs/screenshots/` folder is where you should place actual screenshots. The filenames referenced in this guide are:

| Filename | Description |
|----------|-------------|
| `01-strava-api-settings.png` | Strava API settings page |
| `02-strava-create-app.png` | Strava create application form |
| `03-strava-credentials.png` | Client ID and Secret displayed |
| `04-di2va-setup.png` | Di2va first-run setup page |
| `05-strava-authorize.png` | Strava OAuth consent screen |
| `06-di2va-main.png` | Di2va main interface with activity list |
| `07-di2va-ride.png` | A ride loaded with gear data |
| `08-di2va-settings.png` | FIT library settings dialog |

To add screenshots: take them while following the steps above and save them in `docs/screenshots/` with the filenames listed.

---

<sub>

**About this project:** This is entirely AI-generated code, built using [Visual Studio Code](https://code.visualstudio.com/download) with [GitHub Copilot](https://github.com/features/copilot) powered by the **Claude Opus 4.6** model by [Anthropic](https://www.anthropic.com/).

**Author:** [vinfnet](https://github.com/vinfnet) — This is a personal project and is not affiliated with, endorsed by, or connected to my employer in any way. I do not endorse any of the technologies, products, or services mentioned (Strava, Shimano, Di2, Garmin, etc.) — I simply find this a useful way to experiment with cycling data and AI-assisted development.

Download VS Code: [https://code.visualstudio.com/download](https://code.visualstudio.com/download)

</sub>
