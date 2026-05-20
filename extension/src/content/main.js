/**
 * Di2va — Content Script Entry Point
 *
 * Injected on https://www.strava.com/activities/* pages.
 * Detects the activity, fetches stream data, attempts FIT download,
 * estimates gears, runs shift analysis, then injects the UI panel.
 */

import { estimateGearsForActivity } from '../gear-estimator.js';
import { analyseShifting, computeOptimalGears } from '../shift-analyzer.js';
import { getGearColor, formatGear, GEAR_COLORS } from '../gear-colors.js';
import { renderElevationChart } from './elevation-chart.js';
import { injectUnitDetector, detectUnits, distFromMetres, distUnit } from './units.js';
import { initReplay, updateDrivetrainOnHover, replayPosPlugin, syncReplayToZoom } from './playback.js';
import { safeSetHTML } from './safe-html.js';

// ─── Unit Detection (must happen early, before DOM is fully parsed) ─────────────

injectUnitDetector();

// ─── Dark Mode Detection ───────────────────────────────────────────────────────────

function isDarkMode() {
  return document.documentElement.dataset.theme === 'dark' ||
         !!document.querySelector('.sauce-theme-dark');
}

// ─── Activity Detection ─────────────────────────────────────────────────────

function getActivityId() {
  const match = window.location.pathname.match(/\/activities\/(\d+)/);
  return match ? match[1] : null;
}

// ─── Strava API — uses the user's existing session cookies ──────────────────

async function fetchStravaStreams(activityId) {
  const streamTypes = 'time,latlng,altitude,distance,cadence,watts,grade_smooth,velocity_smooth';
  const resp = await fetch(`/api/v3/activities/${activityId}/streams?keys=${streamTypes}&key_type=distance`, {
    credentials: 'include',
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });

  if (!resp.ok) {
    throw new Error(`Streams fetch failed: ${resp.status}`);
  }

  const data = await resp.json();
  // Strava returns an array of { type, data } objects
  const streams = {};
  if (Array.isArray(data)) {
    data.forEach(s => { streams[s.type] = s.data; });
  } else {
    // Sometimes it's already keyed
    Object.assign(streams, data);
  }
  return streams;
}

async function fetchOriginalFit(activityId) {
  try {
    // Strava's download endpoint (not the API v3 path)
    const resp = await fetch(`/activities/${activityId}/export_original`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!resp.ok) return null;

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 12) return null;

    // FIT files start with a header: first byte is header size (usually 12 or 14),
    // then ".FIT" appears at byte 8. But Strava may serve a .gz — try to detect.
    const view = new Uint8Array(buffer);

    // Check for gzip magic bytes (1f 8b)
    if (view[0] === 0x1f && view[1] === 0x8b) {
      // Decompress gzip
      const ds = new DecompressionStream('gzip');
      const decompressed = new Response(
        new Blob([buffer]).stream().pipeThrough(ds)
      );
      const fitBuffer = await decompressed.arrayBuffer();
      if (isFitFile(fitBuffer)) return fitBuffer;
      return null;
    }

    if (isFitFile(buffer)) return buffer;
    return null;
  } catch (err) {
    console.warn('[Di2va] FIT download failed:', err.message);
    return null;
  }
}

function isFitFile(buffer) {
  if (buffer.byteLength < 12) return false;
  const view = new Uint8Array(buffer, 8, 4);
  return String.fromCharCode(...view) === '.FIT';
}

function parseTeethCsv(raw) {
  if (typeof raw !== 'string') return null;
  const values = raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return null;
  return [...new Set(values)].sort((a, b) => a - b);
}

function buildConfigFromFitSetup(groupset) {
  const front = Array.isArray(groupset?.setup?.front_chainrings)
    ? groupset.setup.front_chainrings.filter(v => Number.isFinite(v) && v > 0)
    : [];
  const rear = Array.isArray(groupset?.setup?.rear_cogs)
    ? groupset.setup.rear_cogs.filter(v => Number.isFinite(v) && v > 0)
    : [];

  if (!front.length || !rear.length) return null;
  return {
    chainrings: [...new Set(front)].sort((a, b) => a - b),
    cassette: [...new Set(rear)].sort((a, b) => a - b)
  };
}

function pickAnalysisConfig(userConfig, fitGroupset) {
  // Prefer explicit user drivetrain settings when present.
  if (userConfig?.chainrings?.length && userConfig?.cassette?.length) {
    return userConfig;
  }
  // Fall back to setup inferred from FIT records.
  const fitConfig = buildConfigFromFitSetup(fitGroupset);
  if (fitConfig) return fitConfig;
  return {};
}

function loadUserDrivetrainConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('di2vaSettings', (result) => {
        const s = result?.di2vaSettings;
        if (!s) return resolve(null);

        const chainrings = parseTeethCsv(s.chainrings);
        const cassette = parseTeethCsv(s.cassette);
        const wheelCirc = Number.parseFloat(s.wheelCirc);

        const config = {};
        if (chainrings?.length) config.chainrings = chainrings;
        if (cassette?.length) config.cassette = cassette;
        if (Number.isFinite(wheelCirc) && wheelCirc > 1 && wheelCirc < 3) {
          config.wheelCirc = wheelCirc;
        }

        resolve(Object.keys(config).length ? config : null);
      });
    } catch (err) {
      console.warn('[Di2va] Failed to load drivetrain settings:', err.message);
      resolve(null);
    }
  });
}

// ─── FIT Parsing via Web Worker ─────────────────────────────────────────────

function parseFitInWorker(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const workerUrl = chrome.runtime.getURL('fit-worker.js');
    const worker = new Worker(workerUrl);

    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.type === 'result') {
        resolve(e.data.data);
      } else {
        reject(new Error(e.data.message || 'Worker error'));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };

    worker.postMessage({ type: 'parse', buffer: arrayBuffer }, [arrayBuffer]);
  });
}

// ─── Gear Data Pipeline ─────────────────────────────────────────────────────

/**
 * Align FIT gear records to Strava stream indices by distance.
 * FIT records have their own timestamps; we match them to the nearest
 * Strava distance index.
 */
function alignFitGearsToStreams(fitResult, streams) {
  if (!fitResult.has_gear_data || !fitResult.records.length || !streams.distance) {
    return null;
  }

  const stravaDist = streams.distance;
  const gears = new Array(stravaDist.length).fill(null);

  const fitRecords = fitResult.records.filter(r => r.distance != null);
  if (fitRecords.length === 0) return null;

  // Detect distance unit: fit-file-parser with lengthUnit:'km' gives km,
  // Strava streams give metres. Compare max distances to determine scale.
  const maxFitDist = fitRecords[fitRecords.length - 1].distance;
  const maxStravaDist = stravaDist[stravaDist.length - 1];
  let scaleFactor = 1;
  if (maxFitDist > 0 && maxStravaDist > 0) {
    const ratio = maxStravaDist / maxFitDist;
    // If Strava is ~1000x bigger, FIT is in km
    if (ratio > 500) scaleFactor = 1000;
    // If FIT is ~1000x bigger, FIT is in mm or cm
    else if (ratio < 0.002) scaleFactor = 0.001;
  }

  // Build aligned gears by matching each Strava distance point to nearest FIT record
  let fitIdx = 0;

  for (let si = 0; si < stravaDist.length; si++) {
    const targetDist = stravaDist[si];

    // Advance FIT index to closest point (binary-search style forward scan)
    while (fitIdx < fitRecords.length - 1) {
      const currDiff = Math.abs(fitRecords[fitIdx].distance * scaleFactor - targetDist);
      const nextDiff = Math.abs(fitRecords[fitIdx + 1].distance * scaleFactor - targetDist);
      if (nextDiff <= currDiff) fitIdx++;
      else break;
    }

    const rec = fitRecords[fitIdx];
    if (rec.front_gear_teeth && rec.rear_gear_teeth) {
      gears[si] = {
        front: rec.front_gear_teeth,
        rear: rec.rear_gear_teeth,
        gear_ratio: +(rec.front_gear_teeth / rec.rear_gear_teeth).toFixed(2),
        estimated: false
      };
    }
  }

  // Fill gaps with last known gear
  let lastKnown = null;
  for (let i = 0; i < gears.length; i++) {
    if (gears[i]) lastKnown = gears[i];
    else if (lastKnown) gears[i] = { ...lastKnown };
  }

  return gears;
}

function inferFitDistanceScale(fitResult, fitRecords) {
  if (!fitRecords.length) return 1;
  const lastDist = fitRecords[fitRecords.length - 1].distance;
  if (typeof lastDist !== 'number' || !isFinite(lastDist) || lastDist <= 0) return 1;

  const firstRec = fitRecords[0];
  const lastRec = fitRecords[fitRecords.length - 1];

  // Prefer elapsed-time based inference: pick the distance scale that yields a
  // realistic moving speed profile, avoiding false x0.001 compression.
  let elapsedSec = null;
  if (typeof firstRec.elapsed_time === 'number' && isFinite(firstRec.elapsed_time) &&
      typeof lastRec.elapsed_time === 'number' && isFinite(lastRec.elapsed_time)) {
    elapsedSec = Math.max(0, lastRec.elapsed_time - firstRec.elapsed_time);
  } else if (firstRec.timestamp && lastRec.timestamp) {
    const t0 = new Date(firstRec.timestamp).getTime();
    const t1 = new Date(lastRec.timestamp).getTime();
    if (isFinite(t0) && isFinite(t1)) {
      elapsedSec = Math.max(0, (t1 - t0) / 1000);
    }
  }

  if (typeof elapsedSec === 'number' && isFinite(elapsedSec) && elapsedSec >= 60) {
    const candidateScales = [1, 1000, 0.001];
    let bestScale = 1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const scale of candidateScales) {
      const avgMs = (lastDist * scale) / elapsedSec;
      // Penalize impossible or highly implausible cycling averages.
      let score = 0;
      if (avgMs < 0.5) score += (0.5 - avgMs) * 20;
      if (avgMs > 30) score += (avgMs - 30) * 20;

      // Bias toward normal outdoor cycling averages (~4-12 m/s).
      const target = 8;
      score += Math.abs(avgMs - target);

      if (score < bestScore) {
        bestScore = score;
        bestScale = scale;
      }
    }

    // If session distance exists, lightly refine toward the nearest unit interpretation.
    const sessionDist = fitResult?.session?.total_distance;
    if (typeof sessionDist === 'number' && isFinite(sessionDist) && sessionDist > 0) {
      const sessionMeters = sessionDist > 1000 ? sessionDist : sessionDist * 1000;
      const scaled = lastDist * bestScale;
      const altScaled = lastDist * (bestScale === 1 ? 1000 : (bestScale === 1000 ? 1 : 1));
      const errBest = Math.abs(scaled - sessionMeters);
      const errAlt = Math.abs(altScaled - sessionMeters);
      if (bestScale === 1 && errAlt < errBest * 0.5) return 1000;
      if (bestScale === 1000 && errAlt < errBest * 0.5) return 1;
    }

    return bestScale;
  }

  const sessionDist = fitResult?.session?.total_distance;
  if (typeof sessionDist === 'number' && isFinite(sessionDist) && sessionDist > 0) {
    const ratio = sessionDist / lastDist;
    if (ratio > 500) return 1000; // FIT is km, session is metres
    // Avoid x0.001 downscaling here; this often reflects mixed units in session
    // metadata rather than record distance units.
    return 1;
  }

  // Typical rides in FIT parser outputs are in km; short rides can be ambiguous,
  // so only auto-scale when values strongly look like kilometres.
  const scale = (lastDist <= 500 && fitRecords.length > 100) ? 1000 : 1;
  console.log('[Di2va] Distance scale: ' + lastDist + ' with ' + fitRecords.length + ' records → x' + scale);
  return scale;
}

function inferFitSpeedScale(rawSpeeds) {
  const valid = rawSpeeds.filter(v => typeof v === 'number' && isFinite(v) && v > 0);
  if (!valid.length) return 1;
  const maxSpeed = Math.max(...valid);
  // If values look like km/h (e.g. 30-70), convert to m/s for existing UI math.
  return maxSpeed > 25 ? 1 / 3.6 : 1;
}

function buildDebugFitStreamsAndGears(fitResult) {
  const fitRecords = (fitResult?.records || []).filter(r => r && (r.distance != null || r.timestamp || r.elapsed_time != null));
  if (!fitRecords.length) {
    console.warn('[Di2va] No usable FIT records found');
    return null;
  }

  const distanceScale = inferFitDistanceScale(fitResult, fitRecords);
  const rawSpeeds = fitRecords.map(r => r.speed || r.enhanced_speed).filter(v => v != null);
  const speedScale = inferFitSpeedScale(rawSpeeds);
  const rawAltitudes = fitRecords.map(r => r.altitude || r.enhanced_altitude).filter(v => v != null);

  // Detect if altitude is in km (max < 10) vs metres (typical max > 100)
  const maxAlt = Math.max(...rawAltitudes);
  const altitudeScale = maxAlt < 10 ? 1000 : 1; // Convert km to metres if needed

  const streams = {
    time: [],
    distance: [],
    altitude: [],
    cadence: [],
    watts: [],
    velocity_smooth: [],
    grade_smooth: []
  };

  const gears = [];

  const firstTs = fitRecords[0].timestamp ? new Date(fitRecords[0].timestamp).getTime() : null;
  let prevDist = 0;
  let prevAlt = null;
  let prevGrade = 0;
  let lastGear = null;

  for (let i = 0; i < fitRecords.length; i++) {
    const rec = fitRecords[i];

    let t = i;
    if (typeof rec.elapsed_time === 'number' && isFinite(rec.elapsed_time)) {
      t = rec.elapsed_time;
    } else if (rec.timestamp && firstTs != null) {
      const ts = new Date(rec.timestamp).getTime();
      if (isFinite(ts)) t = (ts - firstTs) / 1000;
    }
    streams.time.push(Math.max(0, t));

    const rawDist = typeof rec.distance === 'number' && isFinite(rec.distance) ? rec.distance : null;
    const dist = rawDist != null ? rawDist * distanceScale : prevDist;
    streams.distance.push(Math.max(0, dist));

    const rawAlt = (typeof rec.altitude === 'number' && isFinite(rec.altitude) ? rec.altitude : null) ||
                   (typeof rec.enhanced_altitude === 'number' && isFinite(rec.enhanced_altitude) ? rec.enhanced_altitude : null);
    const alt = rawAlt != null ? rawAlt * altitudeScale : prevAlt;
    streams.altitude.push(alt);

    streams.cadence.push(rec.cadence != null ? rec.cadence : null);
    streams.watts.push(rec.power != null ? rec.power : null);

    const rawSpeed = (typeof rec.speed === 'number' && isFinite(rec.speed) ? rec.speed : null) ||
                     (typeof rec.enhanced_speed === 'number' && isFinite(rec.enhanced_speed) ? rec.enhanced_speed : null);
    streams.velocity_smooth.push(rawSpeed != null ? rawSpeed * speedScale : null);

    if (alt != null && prevAlt != null && dist != null && prevDist != null) {
      const dd = dist - prevDist;
      if (Math.abs(dd) >= 1) {
        prevGrade = ((alt - prevAlt) / dd) * 100;
      }
    }
    streams.grade_smooth.push(prevGrade);

    prevDist = dist;
    prevAlt = alt;

    if (rec.front_gear_teeth && rec.rear_gear_teeth) {
      lastGear = {
        front: rec.front_gear_teeth,
        rear: rec.rear_gear_teeth,
        gear_ratio: +(rec.front_gear_teeth / rec.rear_gear_teeth).toFixed(2),
        estimated: false
      };
      gears.push(lastGear);
    } else {
      gears.push(lastGear ? { ...lastGear } : null);
    }
  }

  const validAltitudeCount = streams.altitude.filter(a => a != null).length;
  const validDistanceCount = streams.distance.filter(d => d != null && d > 0).length;

  if (validDistanceCount < 2 || validAltitudeCount < 2) {
    throw new Error(`Insufficient FIT data: ${validDistanceCount} distance points, ${validAltitudeCount} altitude points.`);
  }

  // Ensure all stream arrays same length
  const len = streams.time.length;
  const keys = Object.keys(streams);
  for (const key of keys) {
    if (streams[key].length !== len) {
      streams[key].length = len; // truncate or pad
    }
  }

  if (gears.length !== len) {
    while (gears.length < len) {
      gears.push(lastGear ? { ...lastGear } : null);
    }
    gears.length = len;
  }

  return { streams, gears };
}

// ─── UI Injection ───────────────────────────────────────────────────────────

function createPanel() {
  const panel = document.createElement('div');
  panel.id = 'di2va-panel';
  panel.classList.add('di2va-collapsed'); // start collapsed
  panel.innerHTML = `
    <div class="di2va-header" id="di2va-toggle">
      <span class="di2va-logo">⛓ Di2va</span>
      <span class="di2va-status" id="di2va-status">Loading…</span>
      <button id="di2va-debug-toggle" class="di2va-debug-toggle di2va-debug-header-btn" type="button" title="Toggle debug tools panel">Debug</button>
      <span class="di2va-chevron">▾</span>
    </div>
    <div class="di2va-body" id="di2va-body">
      <div class="di2va-loading" id="di2va-loading">
        <div class="di2va-spinner"></div>
        <span>Analysing gear data…</span>
      </div>
      <div class="di2va-content" id="di2va-content" style="display:none;">
        <div class="di2va-row">
          <div class="di2va-col di2va-col-score">
            <div class="di2va-section" id="di2va-source-info"></div>
            <div class="di2va-section" id="di2va-score"></div>
          </div>
          <div class="di2va-col di2va-col-gears">
            <div class="di2va-section" id="di2va-stats"></div>
          </div>
        </div>
        <div class="di2va-section di2va-chart-section">
          <div class="di2va-chart-row">
            <div class="di2va-chart-area">
              <div class="di2va-chart-source" id="di2va-chart-source"></div>
              <canvas id="di2va-elevation-chart"></canvas>
              <div class="di2va-zoom-hint" id="di2va-zoom-hint">Click and drag to zoom</div>
            </div>
            <div class="di2va-chart-sidebar" id="di2va-chart-sidebar">
              <div class="di2va-hover-info" id="di2va-hover-info" style="display:none;">
                <div class="di2va-hv-row di2va-hv-title">
                  <span class="di2va-hv-distance"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Gear</span>
                  <span class="di2va-hv-gear di2va-hv-value"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Elevation</span>
                  <span class="di2va-hv-elevation di2va-hv-value"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Gradient</span>
                  <span class="di2va-hv-gradient di2va-hv-value"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Speed</span>
                  <span class="di2va-hv-speed di2va-hv-value"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Cadence</span>
                  <span class="di2va-hv-cadence di2va-hv-value"></span>
                </div>
                <div class="di2va-hv-row">
                  <span class="di2va-hv-label">Power</span>
                  <span class="di2va-hv-power di2va-hv-value"></span>
                </div>
              </div>
              <div class="di2va-section-scores" id="di2va-section-scores" style="display:none;">
                <div class="di2va-ss-title">Section Scores</div>
                <div class="di2va-ss-range" id="di2va-ss-range"></div>
                <div class="di2va-ss-components" id="di2va-ss-components"></div>
              </div>
              <button class="di2va-zoom-reset" id="di2va-zoom-reset" style="display:none;">↩ Reset Zoom</button>
            </div>
          </div>
        </div>
        <div class="di2va-section" id="di2va-legend"></div>
        <div class="di2va-section di2va-replay-section">
          <div class="di2va-replay-controls-bar">
            <button id="di2va-play" class="di2va-play-btn">▶ Play</button>
            <div class="di2va-speed-group">
              <button class="di2va-speed-btn active" data-speed="1">1×</button>
              <button class="di2va-speed-btn" data-speed="2">2×</button>
              <button class="di2va-speed-btn" data-speed="5">5×</button>
              <button class="di2va-speed-btn" data-speed="10">10×</button>
              <button class="di2va-speed-btn" data-speed="20">20×</button>
            </div>
            <span id="di2va-replay-time" class="di2va-replay-time">0:00 / 0:00</span>
          </div>
          <div class="di2va-replay-progress">
            <input type="range" id="di2va-scrubber" class="di2va-scrubber" min="0" max="100" value="0">
          </div>
          <div class="di2va-replay-body">
            <div class="di2va-replay-left">
              <div id="di2va-replay-stats" class="di2va-replay-stats"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="di2va-error" id="di2va-error" style="display:none;"></div>
    </div>
  `;

  // Create the floating debug panel and add to body
  if (!document.getElementById('di2va-debug-panel')) {
    const debugPanel = document.createElement('div');
    debugPanel.className = 'di2va-debug-panel di2va-debug-collapsed';
    debugPanel.id = 'di2va-debug-panel';
    debugPanel.innerHTML = `
      <div class="di2va-debug-content" id="di2va-debug-content">
        <div class="di2va-debug-controls">
          <button id="di2va-debug-pick" class="di2va-debug-btn" type="button">Load .FIT File</button>
          <input id="di2va-debug-input" type="file" accept=".fit,.FIT" style="display:none;">
          <span id="di2va-debug-file" class="di2va-debug-file">Drop a FIT here or pick a file</span>
        </div>
        <div id="di2va-debug-build" class="di2va-debug-build"></div>
      </div>
    `;
    document.body.appendChild(debugPanel);

    // Setup drag-drop for the floating debug panel
    debugPanel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      debugPanel.classList.add('di2va-debug-drag-over');
    });

    debugPanel.addEventListener('dragleave', () => {
      debugPanel.classList.remove('di2va-debug-drag-over');
    });

    debugPanel.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      debugPanel.classList.remove('di2va-debug-drag-over');
      // The actual file handling will be done by the onFile callback passed later
    });
  }
  return panel;
}

function renderScore(container, analysis) {
  if (!analysis) {
    container.style.display = 'none';
    return;
  }

  const stars = '★'.repeat(analysis.rating) + '☆'.repeat(5 - analysis.rating);

  safeSetHTML(container, `
    <div class="di2va-score-header">
      <span class="di2va-stars">${stars}</span>
      <span class="di2va-overall">${analysis.overall}%</span>
    </div>
    <div class="di2va-components">
      ${Object.entries(analysis.components).map(([key, comp]) => `
        <div class="di2va-component">
          <div class="di2va-component-label">${comp.label}</div>
          <div class="di2va-bar-track">
            <div class="di2va-bar-fill" style="width:${comp.score}%; background:${getBarColor(comp.score)}"></div>
          </div>
          <div class="di2va-component-value">${comp.score}%</div>
        </div>
      `).join('')}
    </div>
  `);
}

function getBarColor(score) {
  const s = parseInt(score);
  if (s >= 80) return '#22c55e';
  if (s >= 60) return '#f59e0b';
  return '#ef4444';
}

function renderGearStats(container, gears, streams) {
  if (!gears || !gears.length) {
    container.style.display = 'none';
    return;
  }

  // Count time in each gear combination
  const gearCounts = {};
  let totalPoints = 0;

  for (const g of gears) {
    if (!g || !g.front || !g.rear) continue;
    const key = `${g.front}/${g.rear}`;
    gearCounts[key] = (gearCounts[key] || 0) + 1;
    totalPoints++;
  }

  if (totalPoints === 0) {
    container.style.display = 'none';
    return;
  }

  // Sort by usage (descending)
  const sorted = Object.entries(gearCounts)
    .map(([key, count]) => {
      const [front, rear] = key.split('/').map(Number);
      return {
        front,
        rear,
        ratio: (front / rear).toFixed(1),
        count,
        pct: ((count / totalPoints) * 100).toFixed(1)
      };
    })
    .sort((a, b) => b.count - a.count);

  // Count shifts
  let shiftCount = 0;
  for (let i = 1; i < gears.length; i++) {
    if (gears[i] && gears[i - 1] &&
        (gears[i].front !== gears[i - 1].front || gears[i].rear !== gears[i - 1].rear)) {
      shiftCount++;
    }
  }

  const isEstimated = gears.some(g => g?.estimated);

  safeSetHTML(container, `
    <div class="di2va-stats-header">
      <span>Gear Usage</span>
      <span class="di2va-shift-count">${shiftCount} shifts${isEstimated ? ' (estimated)' : ''}</span>
    </div>
    <div class="di2va-gear-cards">
      ${sorted.slice(0, 8).map(g => `
        <div class="di2va-gear-card" style="border-left: 3px solid ${getGearColor(g)}">
          <div class="di2va-gear-name">${formatGear(g.front, g.rear)} (${g.ratio})</div>
          <div class="di2va-gear-pct">${g.pct}%</div>
          <div class="di2va-gear-bar">
            <div class="di2va-gear-bar-fill" style="width:${g.pct}%; background:${getGearColor(g)}"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `);
}

function renderLegend(container) {
  safeSetHTML(container, `
    <div class="di2va-legend-row">
      ${GEAR_COLORS.map((c, i) => `<span class="di2va-legend-dot" style="background:${c}" title="Gear ${i + 1}"></span>`).join('')}
      <span class="di2va-legend-labels"><span>Easy</span><span>Hard</span></span>
    </div>
  `);
}

function formatTeethList(values) {
  if (!Array.isArray(values) || values.length === 0) return '—';
  return values.join(' / ');
}

function formatTeethRange(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) return `${min}T`;
  return `${min}-${max}T`;
}

function renderSourceInfo(container, opts) {
  const source = opts?.source || 'estimated';
  const groupset = opts?.groupset || null;
  const groupsetLabel = groupset?.label || null;
  const setup = groupset?.setup || null;
  const debugMode = !!opts?.debugMode;

  const icon = source === 'fit' ? '📁' : '📊';
  const label = source === 'fit' ? 'FIT file (actual shift data)' : 'Estimated from cadence & speed';
  const modeTag = debugMode ? '<span class="di2va-tag di2va-tag-debug">Debug Mode</span>' : '';
  const groupsetTag = groupsetLabel ? `<span class="di2va-tag di2va-tag-groupset">${groupsetLabel}</span>` : '';
  const detectionInfo = groupsetLabel
    ? `<span class="di2va-info-icon" role="img" aria-label="Groupset detection info" title="Groupset detection is inferred from gear teeth observed in this ride's FIT shift data.&#10;If you did not use every sprocket/chainring, the displayed range can be incomplete or slightly wrong.&#10;Set drivetrain teeth in extension options for the most accurate analysis.">i</span>`
    : '';

  let setupBlock = '';
  if (setup && source === 'fit') {
    const front = setup.front_chainrings || [];
    const rear = setup.rear_cogs || [];
    const drivetrain = setup.drivetrain || `${front.length || '?'}x${rear.length || '?'}`;
    const frontRange = formatTeethRange(front);
    const rearRange = formatTeethRange(rear);

    const frontSuffix = frontRange ? `, ${frontRange} range` : '';
    const rearSuffix = rearRange ? `, ${rearRange} range` : '';

    setupBlock = `
      <div class="di2va-groupset-details">
        <div class="di2va-groupset-line"><strong>Detected:</strong> ${groupsetLabel || 'Unknown groupset'} (${drivetrain})</div>
        <div class="di2va-groupset-line"><strong>Front:</strong> ${formatTeethList(front)}T (${front.length} chainrings${frontSuffix})</div>
        <div class="di2va-groupset-line"><strong>Rear:</strong> ${formatTeethList(rear)}T (${rear.length} cogs${rearSuffix})</div>
      </div>
    `;
  }

  safeSetHTML(container, `
    <div class="di2va-source-row">
      <span class="di2va-source">${icon} ${label}</span>
      ${modeTag}
      ${groupsetTag}
      ${detectionInfo}
    </div>
    ${setupBlock}
  `);
}

// ─── FIT File Drop Zone ─────────────────────────────────────────────────────

function setupDropZone(panel, onFile) {
  const body = panel.querySelector('#di2va-body');

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    body.classList.add('di2va-drag-over');
  });

  body.addEventListener('dragleave', () => {
    body.classList.remove('di2va-drag-over');
  });

  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    body.classList.remove('di2va-drag-over');

    const file = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.fit'));
    if (!file) return;

    const buffer = await file.arrayBuffer();
    onFile(buffer, file.name);
  });
}

function setupDebugFilePicker(panel, onFile) {
  const pickBtn = document.getElementById('di2va-debug-pick');
  const input = document.getElementById('di2va-debug-input');

  if (!pickBtn || !input) return;

  pickBtn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.fit')) return;
    const buffer = await file.arrayBuffer();
    onFile(buffer, file.name);
    input.value = '';
  });
}

function setDebugMode(panel, enabled, fileName = null) {
  panel.classList.toggle('di2va-debug-mode', enabled);

  const debugFileEl = document.getElementById('di2va-debug-file');
  if (debugFileEl) {
    debugFileEl.textContent = enabled && fileName
      ? `Using debug FIT: ${fileName}`
      : 'Drop a FIT here or pick a file';
  }
}

function setDebugPanelVisible(panel, visible) {
  const debugPanel = document.getElementById('di2va-debug-panel');
  const toggle = panel.querySelector('#di2va-debug-toggle');
  if (!debugPanel || !toggle) return;

  debugPanel.classList.toggle('di2va-debug-collapsed', !visible);
  toggle.textContent = visible ? 'Hide Debug' : 'Debug';

  try {
    chrome.storage.local.set({ di2vaDebugVisible: !!visible });
  } catch {
    // Ignore storage write failures.
  }
}

function setupDebugPanelToggle(panel) {
  const toggle = panel.querySelector('#di2va-debug-toggle');
  const debugPanel = document.getElementById('di2va-debug-panel');
  if (!toggle || !debugPanel) return;

  // Hidden by default unless user has explicitly enabled it before.
  setDebugPanelVisible(panel, false);

  try {
    chrome.storage.local.get('di2vaDebugVisible', (result) => {
      if (result?.di2vaDebugVisible === true) {
        setDebugPanelVisible(panel, true);
      }
    });
  } catch {
    // Ignore storage read failures.
  }

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isCollapsed = debugPanel.classList.contains('di2va-debug-collapsed');
    setDebugPanelVisible(panel, isCollapsed);
  });
}

function setChartSource(panel, label, type = 'strava') {
  const el = panel.querySelector('#di2va-chart-source');
  if (!el) return;
  el.textContent = `Chart Source: ${label}`;
  el.classList.remove('di2va-chart-source-fit', 'di2va-chart-source-strava');
  el.classList.add(type === 'fit' ? 'di2va-chart-source-fit' : 'di2va-chart-source-strava');
}

function renderBuildNumber(panel) {
  const el = document.getElementById('di2va-debug-build');
  if (!el) return;

  const manifestVersion = chrome?.runtime?.getManifest?.()?.version || 'dev';
  const buildMeta = (typeof __DI2VA_BUILD__ !== 'undefined' && __DI2VA_BUILD__)
    ? __DI2VA_BUILD__
    : null;

  if (!buildMeta || typeof buildMeta !== 'object') {
    el.textContent = `Build v${manifestVersion}`;
    return;
  }

  const buildNumber = Number.isFinite(buildMeta.buildNumber) ? buildMeta.buildNumber : '?';
  const gitHash = buildMeta.gitHash || 'local';
  const sourceHash = buildMeta.sourceHash ? String(buildMeta.sourceHash) : null;
  const suffix = sourceHash ? `/${sourceHash}` : '';

  el.textContent = `Build v${manifestVersion}.${buildNumber} (${gitHash}${suffix})`;
  el.title = 'Build number increments when tracked extension source files change and the extension is rebuilt.';
}

// ─── Main Entry ─────────────────────────────────────────────────────────────

async function init() {
  const activityId = getActivityId();
  if (!activityId) return;
  const userDrivetrainConfig = await loadUserDrivetrainConfig();

  // Detect Strava user's unit preference (metric/imperial)
  try {
    detectUnits();
  } catch (err) {
    console.warn('[Di2va] Unit detection failed:', err.message);
  }

  // Wait for the elevation chart / map section — inject below it
  const anchor = await waitForElement(
    '#elevation-chart, .elevation-chart, [class*="ElevationChart"], ' +
    '#map-canvas, .activity-map, [class*="ActivityMap"], ' +
    '.segments-list, #segments, [class*="Segments"]'
  );
  let fallbackContainer = null;
  if (!anchor) {
    fallbackContainer = document.querySelector('main, #main, [role="main"], #page_content') || document.body;
    console.warn('[Di2va] Could not find Strava chart/map anchor, using fallback container');
  }

  // Walk up to the full-width container, then insert after it
  let insertTarget = anchor || fallbackContainer;
  if (!insertTarget) return;
  // Find the nearest section-level parent so we're full width
  while (insertTarget.parentElement &&
         insertTarget.parentElement.id !== 'view' &&
         !insertTarget.parentElement.classList.contains('activity-summary') &&
         insertTarget.parentElement.tagName !== 'MAIN' &&
         insertTarget.parentElement !== document.body) {
    const pw = insertTarget.parentElement.offsetWidth || 0;
    if (pw >= 700) break; // wide enough — this is the main content column
    insertTarget = insertTarget.parentElement;
  }

  // Create and inject the panel
  const panel = createPanel();
  renderBuildNumber(panel);
  setupDebugPanelToggle(panel);
  if (anchor && insertTarget.parentNode) {
    insertTarget.parentNode.insertBefore(panel, insertTarget.nextSibling);
  } else {
    insertTarget.prepend(panel);
  }

  const statusEl = panel.querySelector('#di2va-status');
  const loadingEl = panel.querySelector('#di2va-loading');
  const contentEl = panel.querySelector('#di2va-content');
  const errorEl = panel.querySelector('#di2va-error');

  const loadDebugFitBuffer = async (buffer, fileName) => {
    setDebugPanelVisible(panel, true);
    statusEl.textContent = 'Parsing debug FIT…';
    loadingEl.style.display = '';
    contentEl.style.display = 'none';
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    setDebugMode(panel, true, fileName);

    try {
      const fitResult = await parseFitInWorker(buffer);
      if (fitResult.has_gear_data) {
        await renderWithFitData(fitResult, activityId, panel, { debugMode: true });
      } else {
        errorEl.textContent = 'No gear shift data found in this FIT file.';
        errorEl.style.display = '';
        loadingEl.style.display = 'none';
      }
    } catch (err) {
      errorEl.textContent = `FIT parse error: ${err.message}`;
      errorEl.style.display = '';
      loadingEl.style.display = 'none';
    }
  };

  // Toggle collapse (but not on Debug button)
  panel.querySelector('#di2va-toggle').addEventListener('click', (e) => {
    // Don't collapse if clicking the Debug button
    if (e.target.id === 'di2va-debug-toggle') return;
    panel.classList.toggle('di2va-collapsed');
    // Persist state
    chrome.storage.local.set({ di2vaCollapsed: panel.classList.contains('di2va-collapsed') });
  });

  // Restore collapsed/expanded state (default: collapsed)
  chrome.storage.local.get('di2vaCollapsed', (result) => {
    if (result.di2vaCollapsed === false) panel.classList.remove('di2va-collapsed');
  });

  // Setup drag-and-drop for manual FIT uploads
  setupDropZone(panel, loadDebugFitBuffer);
  setupDebugFilePicker(panel, loadDebugFitBuffer);

  // Setup drag-drop for the floating debug panel
  const debugPanel = document.getElementById('di2va-debug-panel');
  if (debugPanel) {
    debugPanel.addEventListener('drop', async (e) => {
      const file = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.fit'));
      if (!file) return;
      const buffer = await file.arrayBuffer();
      loadDebugFitBuffer(buffer, file.name);
    });
  }

  try {
    // 1. Fetch streams from Strava API
    statusEl.textContent = 'Fetching streams…';
    const streams = await fetchStravaStreams(activityId);

    if (!streams.cadence || !streams.velocity_smooth) {
      statusEl.textContent = 'No cadence data';
      loadingEl.style.display = 'none';
      errorEl.textContent = 'This activity has no cadence or speed data — gear analysis requires a cadence sensor.';
      errorEl.style.display = '';
      return;
    }

    // 2. Try to download the original FIT file for actual Di2 data
    statusEl.textContent = 'Checking for groupset data…';
    const fitBuffer = await fetchOriginalFit(activityId);
    let gears = null;
    let source = 'estimated';
    let fitResult = null;
    let groupset = null;
    let analysisConfig = userDrivetrainConfig || {};

    if (fitBuffer) {
      try {
        fitResult = await parseFitInWorker(fitBuffer);

        if (fitResult.has_gear_data) {
          gears = alignFitGearsToStreams(fitResult, streams);
          if (gears) {
            source = 'fit';
            groupset = fitResult.groupset || null;
            analysisConfig = pickAnalysisConfig(userDrivetrainConfig, groupset);
          } else {
            console.warn('[Di2va] Alignment returned null — falling back to estimation');
          }
        }
      } catch (fitErr) {
        console.warn('[Di2va] FIT parsing failed:', fitErr.message);
      }
    } else {
    }

    // 3. Fall back to gear estimation
    if (!gears) {
      statusEl.textContent = 'Estimating gears…';
      gears = estimateGearsForActivity(streams.cadence, streams.velocity_smooth, userDrivetrainConfig || {});
      source = 'estimated';
      analysisConfig = userDrivetrainConfig || {};
    }

    // 4. Run shift analysis
    statusEl.textContent = 'Analysing…';
    const analysis = analyseShifting(streams, gears, analysisConfig);

    // 5. Render UI
    loadingEl.style.display = 'none';
    contentEl.style.display = '';

    renderSourceInfo(panel.querySelector('#di2va-source-info'), {
      source,
      groupset,
      debugMode: false
    });
    renderScore(panel.querySelector('#di2va-score'), analysis);
    renderGearStats(panel.querySelector('#di2va-stats'), gears, streams);
    renderLegend(panel.querySelector('#di2va-legend'));

    // Render elevation chart with drag-zoom + replay position line
    setChartSource(panel, 'Strava Streams', 'strava');
    
    // Destroy any existing chart instance before creating a new one
    if (panel._di2vaChart) {
      console.log('[Di2va] Destroying previous chart instance');
      panel._di2vaChart.destroy();
      panel._di2vaChart = null;
    }
    
    const chartResult = renderElevationChart(
      panel.querySelector('#di2va-elevation-chart'),
      streams,
      gears,
      isDarkMode(),
      panel.querySelector('#di2va-hover-info'),
      (startIdx, endIdx) => handleZoomChange(panel, streams, gears, startIdx, endIdx, analysisConfig),
      [replayPosPlugin],
      (idx) => updateDrivetrainOnHover(panel, gears, streams, idx)
    );
    
    // Store chart instance for later cleanup
    if (chartResult?.chart) {
      panel._di2vaChart = chartResult.chart;
    }
    
    wireZoomReset(panel, chartResult);

    // Init ride playback
    initReplay(panel, streams, gears, chartResult);

    setDebugMode(panel, false);
    statusEl.textContent = source === 'fit'
      ? `${groupset?.label || 'FIT'} ✓`
      : 'Estimated';

    // 6. Notify background that we have gear data (for popup display)
    chrome.runtime.sendMessage({
      type: 'gearDataReady',
      activityId,
      source,
      groupset: groupset?.label || null,
      rating: analysis?.rating || null,
      overall: analysis?.overall || null,
      shiftCount: countShifts(gears),
      gearCount: countUniqueGears(gears)
    }).catch(() => {}); // background may not be listening yet

  } catch (err) {
    console.error('[Di2va]', err);
    statusEl.textContent = 'Error';
    loadingEl.style.display = 'none';
    errorEl.textContent = `Failed to load gear data: ${err.message}`;
    errorEl.style.display = '';
  }
}

async function renderWithFitData(fitResult, activityId, panel, opts = {}) {
  const statusEl = panel.querySelector('#di2va-status');
  const loadingEl = panel.querySelector('#di2va-loading');
  const contentEl = panel.querySelector('#di2va-content');
  const errorEl = panel.querySelector('#di2va-error');
  const debugMode = !!opts.debugMode;

  try {
    const userDrivetrainConfig = await loadUserDrivetrainConfig();
    const analysisConfig = pickAnalysisConfig(userDrivetrainConfig, fitResult.groupset || null);
    let streams;
    let gears;

    if (debugMode) {
      const fitSeries = buildDebugFitStreamsAndGears(fitResult);
      if (!fitSeries) {
        throw new Error('Debug FIT is missing usable stream records (distance/altitude/time).');
      }
      streams = fitSeries.streams;
      gears = fitSeries.gears;
      setChartSource(panel, 'FIT (Debug)', 'fit');
    } else {
      streams = await fetchStravaStreams(activityId);
      gears = alignFitGearsToStreams(fitResult, streams);
      setChartSource(panel, 'Strava Streams', 'strava');
    }

    if (!gears || !gears.length) {
      statusEl.textContent = debugMode ? 'No debug stream' : 'No alignment';
      errorEl.textContent = debugMode
        ? 'Could not build chart data from this FIT file.'
        : 'Could not align FIT gear data to activity streams.';
      errorEl.style.display = '';
      loadingEl.style.display = 'none';
      return;
    }

    const analysis = analyseShifting(streams, gears, analysisConfig);

    loadingEl.style.display = 'none';
    contentEl.style.display = '';

    renderSourceInfo(panel.querySelector('#di2va-source-info'), {
      source: 'fit',
      groupset: fitResult.groupset || null,
      debugMode
    });
    renderScore(panel.querySelector('#di2va-score'), analysis);
    renderGearStats(panel.querySelector('#di2va-stats'), gears, streams);
    renderLegend(panel.querySelector('#di2va-legend'));

    // Destroy any existing chart instance before creating a new one
    const chartEl = panel.querySelector('#di2va-elevation-chart');
    if (panel._di2vaChart) {
      panel._di2vaChart.destroy();
      panel._di2vaChart = null;
    }
    
    // Render elevation chart with drag-zoom + replay position line
    const chartResult = renderElevationChart(
      chartEl,
      streams,
      gears,
      isDarkMode(),
      panel.querySelector('#di2va-hover-info'),
      (startIdx, endIdx) => handleZoomChange(panel, streams, gears, startIdx, endIdx, analysisConfig),
      [replayPosPlugin],
      (idx) => updateDrivetrainOnHover(panel, gears, streams, idx)
    );
    
    // Store chart instance for later cleanup
    if (chartResult?.chart) {
      panel._di2vaChart = chartResult.chart;
    }
    wireZoomReset(panel, chartResult);

    // Init ride playback
    initReplay(panel, streams, gears, chartResult);

    statusEl.textContent = `${fitResult.groupset?.label || 'FIT'} ✓`;
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  } catch (err) {
    statusEl.textContent = 'Error';
    loadingEl.style.display = 'none';
    errorEl.textContent = String(err?.message || err || 'Unknown error');
    errorEl.style.display = '';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── Zoom Handling ──────────────────────────────────────────────────────────

function wireZoomReset(panel, chartResult) {
  if (!chartResult) return;
  const btn = panel.querySelector('#di2va-zoom-reset');
  if (btn) {
    btn.addEventListener('click', () => chartResult.resetZoom());
  }
}

function handleZoomChange(panel, streams, gears, startIdx, endIdx, analysisConfig = {}) {
  const resetBtn = panel.querySelector('#di2va-zoom-reset');
  const scoresEl = panel.querySelector('#di2va-section-scores');
  const hintEl = panel.querySelector('#di2va-zoom-hint');

  if (startIdx == null) {
    // Reset
    if (resetBtn) resetBtn.style.display = 'none';
    if (scoresEl) scoresEl.style.display = 'none';
    if (hintEl) hintEl.style.display = '';
    syncReplayToZoom(panel, streams, gears, null);
    return;
  }

  if (resetBtn) resetBtn.style.display = '';
  if (hintEl) hintEl.style.display = 'none';

  // Sync replay scrubber + drivetrain to zoomed range
  syncReplayToZoom(panel, streams, gears, startIdx, endIdx);

  // Slice streams and gears for the zoomed section
  const slicedStreams = {};
  for (const key of Object.keys(streams)) {
    if (Array.isArray(streams[key])) {
      slicedStreams[key] = streams[key].slice(startIdx, endIdx + 1);
    }
  }
  const slicedGears = gears.slice(startIdx, endIdx + 1);

  // Compute section scores
  const sectionAnalysis = analyseShifting(slicedStreams, slicedGears, analysisConfig);

  if (scoresEl && sectionAnalysis) {
    const rangeEl = panel.querySelector('#di2va-ss-range');
    const compEl = panel.querySelector('#di2va-ss-components');
    const distStart = streams.distance?.[startIdx];
    const distEnd = streams.distance?.[endIdx];
    const altStart = streams.altitude?.[startIdx];
    const altEnd = streams.altitude?.[endIdx];
    const grades = streams.grade_smooth;

    if (rangeEl) {
      rangeEl.textContent = (distStart != null && distEnd != null)
        ? `${distFromMetres(distStart).toFixed(1)} – ${distFromMetres(distEnd).toFixed(1)} ${distUnit()}`
        : '';
    }

    // Calculate overall gradient for the section
    let overallGradientHtml = '';
    
    // Try elevation-based gradient first
    if (distStart != null && distEnd != null && altStart != null && altEnd != null) {
      const distDiff = Math.abs(distEnd - distStart);
      if (distDiff > 0) {
        const altDiff = altEnd - altStart;
        const gradientPct = (altDiff / distDiff) * 100;
        overallGradientHtml = `<div class="di2va-ss-gradient"><strong>Gradient:</strong> ${gradientPct.toFixed(1)}%</div>`;
      }
    }
    // Fallback to average of grade_smooth values if elevation data unavailable
    else if (Array.isArray(grades) && startIdx < grades.length && endIdx < grades.length) {
      const sectionGrades = grades.slice(startIdx, endIdx + 1).filter(g => g != null && Number.isFinite(g));
      if (sectionGrades.length > 0) {
        const avgGradient = sectionGrades.reduce((a, b) => a + b, 0) / sectionGrades.length;
        overallGradientHtml = `<div class="di2va-ss-gradient"><strong>Avg Gradient:</strong> ${avgGradient.toFixed(1)}%</div>`;
      }
    }

    if (compEl) {
      safeSetHTML(compEl, overallGradientHtml + Object.entries(sectionAnalysis.components).map(([key, comp]) => `
        <div class="di2va-ss-row">
          <span class="di2va-ss-label">${comp.label}</span>
          <div class="di2va-ss-bar-track">
            <div class="di2va-ss-bar-fill" style="width:${comp.score}%; background:${getBarColor(comp.score)}"></div>
          </div>
          <span class="di2va-ss-value">${comp.score}%</span>
        </div>
      `).join(''));
    }

    scoresEl.style.display = '';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function countShifts(gears) {
  let count = 0;
  for (let i = 1; i < gears.length; i++) {
    if (gears[i] && gears[i - 1] &&
        (gears[i].front !== gears[i - 1].front || gears[i].rear !== gears[i - 1].rear)) {
      count++;
    }
  }
  return count;
}

function countUniqueGears(gears) {
  const seen = new Set();
  for (const g of gears) {
    if (g?.front && g?.rear) seen.add(`${g.front}/${g.rear}`);
  }
  return seen.size;
}

function waitForElement(selector, timeout = 15000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

init();
