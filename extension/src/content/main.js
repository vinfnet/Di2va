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

// ─── UI Injection ───────────────────────────────────────────────────────────

function createPanel() {
  const panel = document.createElement('div');
  panel.id = 'di2va-panel';
  panel.classList.add('di2va-collapsed'); // start collapsed
  panel.innerHTML = `
    <div class="di2va-header" id="di2va-toggle">
      <span class="di2va-logo">⛓ Di2va</span>
      <span class="di2va-status" id="di2va-status">Loading…</span>
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
              <div id="di2va-drivetrain" class="di2va-drivetrain di2va-dt-inactive">
                <div class="di2va-dt-overlay">Press ▶ Play to visualise gear position</div>
              </div>
              <div id="di2va-replay-stats" class="di2va-replay-stats"></div>
            </div>
            <div class="di2va-replay-right">
              <div id="di2va-replay-ai" class="di2va-replay-ai">
                <div class="di2va-ai-title">Shifting Analysis</div>
                <div id="di2va-ai-rows" class="di2va-ai-rows"></div>
                <div id="di2va-ai-suggestion" class="di2va-ai-suggestion"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="di2va-error" id="di2va-error" style="display:none;"></div>
    </div>
  `;
  return panel;
}

function renderScore(container, analysis) {
  if (!analysis) {
    container.style.display = 'none';
    return;
  }

  const stars = '★'.repeat(analysis.rating) + '☆'.repeat(5 - analysis.rating);

  container.innerHTML = `
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
  `;
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
      return { front, rear, count, pct: ((count / totalPoints) * 100).toFixed(1) };
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

  container.innerHTML = `
    <div class="di2va-stats-header">
      <span>Gear Usage</span>
      <span class="di2va-shift-count">${shiftCount} shifts${isEstimated ? ' (estimated)' : ''}</span>
    </div>
    <div class="di2va-gear-cards">
      ${sorted.slice(0, 8).map(g => `
        <div class="di2va-gear-card" style="border-left: 3px solid ${getGearColor(g)}">
          <div class="di2va-gear-name">${formatGear(g.front, g.rear)}</div>
          <div class="di2va-gear-pct">${g.pct}%</div>
          <div class="di2va-gear-bar">
            <div class="di2va-gear-bar-fill" style="width:${g.pct}%; background:${getGearColor(g)}"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderLegend(container) {
  container.innerHTML = `
    <div class="di2va-legend-row">
      ${GEAR_COLORS.map((c, i) => `<span class="di2va-legend-dot" style="background:${c}" title="Gear ${i + 1}"></span>`).join('')}
      <span class="di2va-legend-labels"><span>Easy</span><span>Hard</span></span>
    </div>
  `;
}

function renderSourceInfo(container, source) {
  const icon = source === 'fit' ? '📁' : '📊';
  const label = source === 'fit' ? 'FIT file (actual Di2 data)' : 'Estimated from cadence & speed';
  container.innerHTML = `<span class="di2va-source">${icon} ${label}</span>`;
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
    onFile(buffer);
  });
}

// ─── Main Entry ─────────────────────────────────────────────────────────────

async function init() {
  const activityId = getActivityId();
  if (!activityId) return;

  // Detect Strava user's unit preference (metric/imperial)
  detectUnits();

  // Wait for the elevation chart / map section — inject below it
  const anchor = await waitForElement(
    '#elevation-chart, .elevation-chart, [class*="ElevationChart"], ' +
    '#map-canvas, .activity-map, [class*="ActivityMap"], ' +
    '.segments-list, #segments, [class*="Segments"]'
  );
  if (!anchor) return;

  // Walk up to the full-width container, then insert after it
  let insertTarget = anchor;
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
  insertTarget.parentNode.insertBefore(panel, insertTarget.nextSibling);

  const statusEl = panel.querySelector('#di2va-status');
  const loadingEl = panel.querySelector('#di2va-loading');
  const contentEl = panel.querySelector('#di2va-content');
  const errorEl = panel.querySelector('#di2va-error');

  // Toggle collapse
  panel.querySelector('#di2va-toggle').addEventListener('click', () => {
    panel.classList.toggle('di2va-collapsed');
    // Persist state
    chrome.storage.local.set({ di2vaCollapsed: panel.classList.contains('di2va-collapsed') });
  });

  // Restore collapsed/expanded state (default: collapsed)
  chrome.storage.local.get('di2vaCollapsed', (result) => {
    if (result.di2vaCollapsed === false) panel.classList.remove('di2va-collapsed');
  });

  // Setup drag-and-drop for manual FIT uploads
  setupDropZone(panel, async (buffer) => {
    statusEl.textContent = 'Parsing FIT…';
    loadingEl.style.display = '';
    contentEl.style.display = 'none';
    try {
      const fitResult = await parseFitInWorker(buffer);
      if (fitResult.has_gear_data) {
        await renderWithFitData(fitResult, activityId, panel);
      } else {
        errorEl.textContent = 'No Di2 gear data found in this FIT file.';
        errorEl.style.display = '';
        loadingEl.style.display = 'none';
      }
    } catch (err) {
      errorEl.textContent = `FIT parse error: ${err.message}`;
      errorEl.style.display = '';
      loadingEl.style.display = 'none';
    }
  });

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
    statusEl.textContent = 'Checking for Di2 data…';
    const fitBuffer = await fetchOriginalFit(activityId);
    let gears = null;
    let source = 'estimated';
    let fitResult = null;

    if (fitBuffer) {
      try {
        fitResult = await parseFitInWorker(fitBuffer);

        if (fitResult.has_gear_data) {
          gears = alignFitGearsToStreams(fitResult, streams);
          if (gears) {
            source = 'fit';
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
      gears = estimateGearsForActivity(streams.cadence, streams.velocity_smooth);
      source = 'estimated';
    }

    // 4. Run shift analysis
    statusEl.textContent = 'Analysing…';
    const analysis = analyseShifting(streams, gears);

    // 5. Render UI
    loadingEl.style.display = 'none';
    contentEl.style.display = '';

    renderSourceInfo(panel.querySelector('#di2va-source-info'), source);
    renderScore(panel.querySelector('#di2va-score'), analysis);
    renderGearStats(panel.querySelector('#di2va-stats'), gears, streams);
    renderLegend(panel.querySelector('#di2va-legend'));

    // Render elevation chart with drag-zoom + replay position line
    const chartResult = renderElevationChart(
      panel.querySelector('#di2va-elevation-chart'),
      streams,
      gears,
      isDarkMode(),
      panel.querySelector('#di2va-hover-info'),
      (startIdx, endIdx) => handleZoomChange(panel, streams, gears, startIdx, endIdx),
      [replayPosPlugin],
      (idx) => updateDrivetrainOnHover(panel, gears, streams, idx)
    );
    wireZoomReset(panel, chartResult);

    // Init ride playback
    initReplay(panel, streams, gears, chartResult);

    statusEl.textContent = source === 'fit' ? 'Di2 ✓' : 'Estimated';

    // 6. Notify background that we have gear data (for popup display)
    chrome.runtime.sendMessage({
      type: 'gearDataReady',
      activityId,
      source,
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

async function renderWithFitData(fitResult, activityId, panel) {
  const statusEl = panel.querySelector('#di2va-status');
  const loadingEl = panel.querySelector('#di2va-loading');
  const contentEl = panel.querySelector('#di2va-content');

  try {
    const streams = await fetchStravaStreams(activityId);
    const gears = alignFitGearsToStreams(fitResult, streams);

    if (!gears) {
      statusEl.textContent = 'No alignment';
      panel.querySelector('#di2va-error').textContent = 'Could not align FIT gear data to activity streams.';
      panel.querySelector('#di2va-error').style.display = '';
      loadingEl.style.display = 'none';
      return;
    }

    const analysis = analyseShifting(streams, gears);

    loadingEl.style.display = 'none';
    contentEl.style.display = '';

    renderSourceInfo(panel.querySelector('#di2va-source-info'), 'fit');
    renderScore(panel.querySelector('#di2va-score'), analysis);
    renderGearStats(panel.querySelector('#di2va-stats'), gears, streams);
    renderLegend(panel.querySelector('#di2va-legend'));

    // Render elevation chart with drag-zoom + replay position line
    const chartResult = renderElevationChart(
      panel.querySelector('#di2va-elevation-chart'),
      streams,
      gears,
      isDarkMode(),
      panel.querySelector('#di2va-hover-info'),
      (startIdx, endIdx) => handleZoomChange(panel, streams, gears, startIdx, endIdx),
      [replayPosPlugin],
      (idx) => updateDrivetrainOnHover(panel, gears, streams, idx)
    );
    wireZoomReset(panel, chartResult);

    // Init ride playback
    initReplay(panel, streams, gears, chartResult);

    statusEl.textContent = 'Di2 ✓';
  } catch (err) {
    statusEl.textContent = 'Error';
    loadingEl.style.display = 'none';
    panel.querySelector('#di2va-error').textContent = err.message;
    panel.querySelector('#di2va-error').style.display = '';
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

function handleZoomChange(panel, streams, gears, startIdx, endIdx) {
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
  const sectionAnalysis = analyseShifting(slicedStreams, slicedGears);

  if (scoresEl && sectionAnalysis) {
    const rangeEl = panel.querySelector('#di2va-ss-range');
    const compEl = panel.querySelector('#di2va-ss-components');
    const distStart = streams.distance?.[startIdx];
    const distEnd = streams.distance?.[endIdx];

    if (rangeEl) {
      rangeEl.textContent = (distStart != null && distEnd != null)
        ? `${distFromMetres(distStart).toFixed(1)} – ${distFromMetres(distEnd).toFixed(1)} ${distUnit()}`
        : '';
    }

    if (compEl) {
      compEl.innerHTML = Object.entries(sectionAnalysis.components).map(([key, comp]) => `
        <div class="di2va-ss-row">
          <span class="di2va-ss-label">${comp.label}</span>
          <div class="di2va-ss-bar-track">
            <div class="di2va-ss-bar-fill" style="width:${comp.score}%; background:${getBarColor(comp.score)}"></div>
          </div>
          <span class="di2va-ss-value">${comp.score}%</span>
        </div>
      `).join('');
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
