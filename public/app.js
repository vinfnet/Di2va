/**
 * Di2va — Frontend Application
 *
 * Visualizes Shimano Di2 gear shift data on a Leaflet map and Chart.js
 * elevation profile, pulling activity data from the Strava API and
 * optionally merging gear data from an uploaded .FIT file.
 */

// ─── Gear Color Palette ─────────────────────────────────────────────────────

// Colors for rear cassette positions (low gear → high gear)
const GEAR_COLORS = [
  '#ef4444', // 1  - Easiest (biggest cog)
  '#f97316', // 2
  '#f59e0b', // 3
  '#eab308', // 4
  '#84cc16', // 5
  '#22c55e', // 6
  '#10b981', // 7
  '#14b8a6', // 8
  '#06b6d4', // 9
  '#3b82f6', // 10
  '#6366f1', // 11
  '#8b5cf6', // 12 - Hardest (smallest cog)
];

// Chainring indicator colors
const CHAINRING_COLORS = {
  small: '#f59e0b',  // Inner ring (easier)
  big: '#3b82f6'     // Outer ring (harder)
};

// ─── Units ──────────────────────────────────────────────────────────────────

const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;

function getUnits() {
  return localStorage.getItem('di2va-units') || 'metric';
}

function isImperial() {
  return getUnits() === 'imperial';
}

/** Convert metres to display distance (km or mi) */
function distFromMetres(m) {
  return isImperial() ? (m / 1000) * KM_TO_MI : m / 1000;
}

/** Convert m/s to display speed (km/h or mph) */
function speedFromMs(ms) {
  return isImperial() ? ms * 3.6 * KM_TO_MI : ms * 3.6;
}

/** Convert metres elevation to display (m or ft) */
function elevFromMetres(m) {
  return isImperial() ? m * M_TO_FT : m;
}

function distUnit()  { return isImperial() ? 'mi' : 'km'; }
function speedUnit() { return isImperial() ? 'mph' : 'km/h'; }
function elevUnit()  { return isImperial() ? 'ft' : 'm'; }

// ─── State ──────────────────────────────────────────────────────────────────

let state = {
  authenticated: false,
  athlete: null,
  activities: [],
  currentActivity: null,
  streams: null,
  gearData: null,        // Gear data per data point
  fitGearData: null,     // Raw FIT file gear data
  usingFitData: false,
  optimalGears: null,    // AI-computed optimal gears per data point
  page: 1,
  map: null,
  routeLayers: [],
  marker: null,
  chart: null
};

// ─── DOM Elements ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  loginScreen:     $('login-screen'),
  activitiesScreen: $('activities-screen'),
  detailScreen:    $('detail-screen'),
  userInfo:        $('user-info'),
  userAvatar:      $('user-avatar'),
  userName:        $('user-name'),
  loginPrompt:     $('login-prompt'),
  activitiesList:  $('activities-list'),
  activitiesLoading: $('activities-loading'),
  btnLoadMore:     $('btn-load-more'),
  btnBack:         $('btn-back'),
  btnUploadFit:    $('btn-upload-fit'),
  fitFileInput:    $('fit-file-input'),
  btnUploadFitDetail: $('btn-upload-fit-detail'),
  fitFileInputDetail: $('fit-file-input-detail'),
  detailTitle:     $('detail-title'),
  detailStats:     $('detail-stats'),
  gearLegend:      $('gear-legend'),
  dataSourceBar:   $('data-source-bar'),
  dataSourceBadge: $('data-source-badge'),
  mapContainer:    $('map-container'),
  elevContainer:   $('elevation-container'),
  elevationChart:  $('elevation-chart'),
  btnResetZoom:    $('btn-reset-zoom'),
  btnFullscreenMap: $('btn-fullscreen-map'),
  btnFullscreenElev: $('btn-fullscreen-elevation'),
  gearStatsContainer: $('gear-stats-container'),
  gearStats:       $('gear-stats'),
  hoverInfo:       $('hover-info'),
  hoverDistance:   $('hover-distance'),
  hoverGear:       $('hover-gear'),
  hoverElevation:  $('hover-elevation'),
  hoverGradient:   $('hover-gradient'),
  hoverSpeed:      $('hover-speed'),
  hoverCadence:    $('hover-cadence'),
  hoverPower:      $('hover-power'),
  toggleGradient:  $('toggle-gradient'),
  toggleCadence:   $('toggle-cadence'),
  btnDownloadFit:  $('btn-download-fit'),
  btnDownloadFitPanel: $('btn-download-fit-panel'),
  btnUploadFitPanel: $('btn-upload-fit-panel'),
  btnDismissImport: $('btn-dismiss-import'),
  fitImportPanel:  $('fit-import-panel'),
  dropOverlay:     $('drop-overlay'),
  // Settings / FIT Library
  btnSettings:     $('btn-settings'),
  settingsModal:   $('settings-modal'),
  btnCloseSettings: $('btn-close-settings'),
  fitFolderInput:  $('fit-folder-input'),
  btnSaveFitFolder: $('btn-save-fit-folder'),
  fitLibraryStatus: $('fit-library-status'),
  fitLibraryBanner: $('fit-library-banner'),
  unitsSelect:     $('units-select'),
  // AI Analysis
  btnAiAnalysis:   $('btn-ai-analysis'),
  aiSliderModal:   $('ai-slider-modal'),
  btnCloseAiSlider: $('btn-close-ai-slider'),
  aiActivitySlider: $('ai-activity-slider'),
  aiSliderValue:   $('ai-slider-value'),
  aiSliderWarning: $('ai-slider-warning'),
  btnRunAiAnalysis: $('btn-run-ai-analysis'),
  aiAnalysisModal: $('ai-analysis-modal'),
  btnCloseAiAnalysis: $('btn-close-ai-analysis'),
  aiAnalysisLoading: $('ai-analysis-loading'),
  aiAnalysisResults: $('ai-analysis-results'),
  aiScoreChart:    $('ai-score-chart'),
  aiScoreCanvas:   $('ai-score-canvas'),
  aiAnalysisError: $('ai-analysis-error'),
  aiErrorText:     $('ai-error-text'),
  aiRating:        $('ai-rating'),
  aiComponents:    $('ai-components'),
  aiSummary:       $('ai-summary'),
  aiActivities:    $('ai-activities'),
  toggleOptimalGear: $('toggle-optimal-gear')
};

// ─── API Helpers ────────────────────────────────────────────────────────────

async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    state.authenticated = false;
    showScreen('login');
    throw new Error('Not authenticated');
  }
  return res.json();
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Restore units preference
  els.unitsSelect.value = getUnits();

  try {
    const athlete = await api('/api/me');
    state.authenticated = true;
    state.athlete = athlete;
    showUser(athlete);
    showScreen('activities');
    loadActivities();
  } catch {
    showScreen('login');
  }

  // Event listeners
  els.btnBack.addEventListener('click', () => showScreen('activities'));
  els.btnLoadMore.addEventListener('click', () => loadActivities());

  els.btnResetZoom.addEventListener('click', () => {
    if (state.chart) {
      state.chart.resetZoom();
      els.btnResetZoom.classList.add('hidden');
    }
  });
  els.btnUploadFit.addEventListener('click', () => els.fitFileInput.click());
  els.fitFileInput.addEventListener('change', handleFitUploadFromList);
  els.btnUploadFitDetail.addEventListener('click', () => els.fitFileInputDetail.click());
  els.fitFileInputDetail.addEventListener('change', handleFitUploadForActivity);
  els.toggleGradient.addEventListener('change', () => {
    if (state.chart) updateElevationChart();
  });
  els.toggleCadence.addEventListener('change', () => {
    if (state.chart) updateElevationChart();
  });
  els.toggleOptimalGear.addEventListener('change', async () => {
    if (els.toggleOptimalGear.checked && !state.optimalGears) {
      await loadOptimalGears();
    }
    if (state.chart) updateElevationChart();
  });

  // AI Analysis — show slider picker first
  els.btnAiAnalysis.addEventListener('click', showAiSliderModal);
  els.btnCloseAiSlider.addEventListener('click', () => {
    els.aiSliderModal.classList.add('hidden');
  });
  els.aiSliderModal.addEventListener('click', (e) => {
    if (e.target === els.aiSliderModal) els.aiSliderModal.classList.add('hidden');
  });
  els.aiActivitySlider.addEventListener('input', () => {
    const val = els.aiActivitySlider.value;
    els.aiSliderValue.textContent = val;
    if (parseInt(val) > 10) {
      els.aiSliderWarning.classList.remove('hidden');
    } else {
      els.aiSliderWarning.classList.add('hidden');
    }
  });
  els.btnRunAiAnalysis.addEventListener('click', () => {
    const count = parseInt(els.aiActivitySlider.value) || 5;
    els.aiSliderModal.classList.add('hidden');
    runAiAnalysis(count);
  });
  els.btnCloseAiAnalysis.addEventListener('click', () => {
    els.aiAnalysisModal.classList.add('hidden');
  });
  els.aiAnalysisModal.addEventListener('click', (e) => {
    if (e.target === els.aiAnalysisModal) els.aiAnalysisModal.classList.add('hidden');
  });

  // Fullscreen toggles
  els.btnFullscreenMap.addEventListener('click', () => toggleFullscreen(els.mapContainer));
  els.btnFullscreenElev.addEventListener('click', () => toggleFullscreen(els.elevContainer));
  document.addEventListener('fullscreenchange', handleFullscreenChange);

  // Download FIT from Strava (uses browser session)
  els.btnDownloadFit.addEventListener('click', downloadFitFromStrava);
  els.btnDownloadFitPanel.addEventListener('click', downloadFitFromStrava);

  // Import panel buttons
  els.btnUploadFitPanel.addEventListener('click', () => els.fitFileInputDetail.click());
  els.btnDismissImport.addEventListener('click', () => {
    els.fitImportPanel.classList.add('hidden');
  });

  // Settings modal
  els.btnSettings?.addEventListener('click', () => {
    els.settingsModal.classList.remove('hidden');
    loadFitLibraryStatus();
  });
  els.btnCloseSettings?.addEventListener('click', () => {
    els.settingsModal.classList.add('hidden');
  });
  els.settingsModal?.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden');
  });
  els.btnSaveFitFolder?.addEventListener('click', saveFitFolderSetting);

  // Gear visualization popup
  document.getElementById('btn-close-gear-popup')?.addEventListener('click', closeGearPopup);
  document.getElementById('gear-popup')?.addEventListener('click', (e) => {
    if (e.target.id === 'gear-popup') closeGearPopup();
  });

  // Units switcher
  els.unitsSelect.addEventListener('change', () => {
    localStorage.setItem('di2va-units', els.unitsSelect.value);
    // Re-render everything that shows units
    if (state.activities.length) renderActivities();
    if (state.currentActivity) renderActivityStats(state.currentActivity);
    if (state.chart) updateElevationChart();
  });

  // Global drag-and-drop for .FIT files
  setupDragAndDrop();
}

// ─── Screen Management ──────────────────────────────────────────────────────

function showScreen(name) {
  els.loginScreen.classList.add('hidden');
  els.activitiesScreen.classList.add('hidden');
  els.detailScreen.classList.add('hidden');
  els.hoverInfo.classList.add('hidden');

  switch (name) {
    case 'login':
      els.loginScreen.classList.remove('hidden');
      els.loginPrompt.classList.remove('hidden');
      els.userInfo.classList.add('hidden');
      break;
    case 'activities':
      els.activitiesScreen.classList.remove('hidden');
      break;
    case 'detail':
      els.detailScreen.classList.remove('hidden');
      break;
  }
}

function showUser(athlete) {
  els.userAvatar.src = athlete.profile_medium || athlete.profile;
  els.userName.textContent = `${athlete.firstname} ${athlete.lastname}`;
  els.userInfo.classList.remove('hidden');
  els.loginPrompt.classList.add('hidden');
}

// ─── Activities ─────────────────────────────────────────────────────────────

async function loadActivities() {
  els.activitiesLoading.classList.remove('hidden');

  try {
    const activities = await api(`/api/activities?page=${state.page}&per_page=30`);
    state.activities.push(...activities);
    state.page++;
    renderActivities();
  } catch (err) {
    console.error('Failed to load activities:', err);
  } finally {
    els.activitiesLoading.classList.add('hidden');
  }
}

function renderActivities() {
  els.activitiesList.innerHTML = '';

  // Sort activities by date descending (most recent first)
  const sorted = [...state.activities].sort((a, b) =>
    new Date(b.start_date_local) - new Date(a.start_date_local)
  );

  const table = document.createElement('table');
  table.className = 'activities-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th class="col-date">Date</th>
        <th class="col-name">Ride</th>
        <th class="col-dist">Distance</th>
        <th class="col-elev">Elevation</th>
        <th class="col-time">Time</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  sorted.forEach(activity => {
    const row = document.createElement('tr');
    row.className = 'activity-row';
    row.addEventListener('click', () => openActivity(activity));

    const date = new Date(activity.start_date_local);
    const distance = distFromMetres(activity.distance).toFixed(1);
    const elevation = Math.round(elevFromMetres(activity.total_elevation_gain));
    const duration = formatDuration(activity.moving_time);
    const hasGearIndicator = activity.device_name?.toLowerCase().includes('di2') ||
                             activity.gear_id ? '⚙️ ' : '';

    row.innerHTML = `
      <td class="col-date">${date.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric'
      })}</td>
      <td class="col-name">${hasGearIndicator}${escapeHtml(activity.name)}</td>
      <td class="col-dist">${distance} <small>${distUnit()}</small></td>
      <td class="col-elev">${elevation} <small>${elevUnit()}</small></td>
      <td class="col-time">${duration}</td>
    `;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  els.activitiesList.appendChild(table);
}

// ─── Open Activity Detail ───────────────────────────────────────────────────

async function openActivity(activity) {
  showScreen('detail');
  state.currentActivity = activity;
  state.gearData = null;
  state.fitGearData = null;
  state.usingFitData = false;
  state.optimalGears = null;
  els.toggleOptimalGear.checked = false;

  // Set header
  els.detailTitle.textContent = activity.name;
  renderActivityStats(activity);

  // Show loading state
  els.gearLegend.innerHTML = '<span style="color: var(--text-muted)">Loading ride data...</span>';
  els.gearStatsContainer.classList.add('hidden');
  els.fitImportPanel.classList.add('hidden');

  try {
    // Fetch streams from Strava API
    const streams = await api(`/api/activity/${activity.id}/streams`);
    state.streams = streams;

    // Estimate gears from cadence + speed as a baseline
    if (streams.cadence && streams.velocity_smooth) {
      els.gearLegend.innerHTML = '<span style="color: var(--text-muted)">Estimating gears from cadence/speed...</span>';
      const gearRes = await api('/api/estimate-gears', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cadence: streams.cadence,
          velocity_smooth: streams.velocity_smooth,
          distance: streams.distance,
          latlng: streams.latlng,
          altitude: streams.altitude
        })
      });
      state.gearData = gearRes.gears;
    }

    // Show data source + download button
    els.dataSourceBar.classList.remove('hidden');
    els.btnDownloadFit.classList.remove('hidden');
    updateDataSourceBadge();

    // Render visualizations (with estimated data for now)
    renderMap();
    renderElevationChart();
    renderGearLegend();
    renderGearStats();

    // ── Auto-match Di2 data from FIT Library ──
    await autoMatchDi2Data(activity);

  } catch (err) {
    console.error('Failed to load activity details:', err);
    els.gearLegend.innerHTML = '<span style="color: var(--red)">Failed to load activity data</span>';
  }
}

function renderActivityStats(activity) {
  const distance = distFromMetres(activity.distance).toFixed(1);
  const elevation = Math.round(elevFromMetres(activity.total_elevation_gain));
  const duration = formatDuration(activity.moving_time);
  const avgSpeed = speedFromMs(activity.average_speed || 0).toFixed(1);
  const maxSpeed = speedFromMs(activity.max_speed || 0).toFixed(1);
  const avgWatts = activity.average_watts ? `${Math.round(activity.average_watts)}` : '—';
  const avgCadence = activity.average_cadence ? `${Math.round(activity.average_cadence)}` : '—';

  // Count front/rear shifts from gear data
  const shiftCounts = countGearShifts();

  els.detailStats.innerHTML = `
    <div class="stat"><span class="value">${distance} ${distUnit()}</span><span class="label">Distance</span></div>
    <div class="stat"><span class="value">${elevation} ${elevUnit()}</span><span class="label">Elevation</span></div>
    <div class="stat"><span class="value">${duration}</span><span class="label">Moving Time</span></div>
    <div class="stat"><span class="value">${avgSpeed} ${speedUnit()}</span><span class="label">Avg Speed</span></div>
    <div class="stat"><span class="value">${maxSpeed} ${speedUnit()}</span><span class="label">Max Speed</span></div>
    <div class="stat"><span class="value">${avgWatts} W</span><span class="label">Avg Power</span></div>
    <div class="stat"><span class="value">${avgCadence} rpm</span><span class="label">Avg Cadence</span></div>
    <div class="stat shift-stat"><span class="value">${shiftCounts.rear}</span><span class="label">Rear Shifts</span></div>
    <div class="stat shift-stat"><span class="value">${shiftCounts.front}</span><span class="label">Front Shifts</span></div>
  `;
}

/**
 * Count front and rear gear shifts.
 * Uses FIT gear_changes if available, otherwise detects changes in gearData.
 */
function countGearShifts() {
  // Prefer FIT gear change events (most accurate)
  if (state.fitGearData?.gear_changes?.length > 0) {
    const gc = state.fitGearData.gear_changes;
    let rear = 0, front = 0;
    gc.forEach(e => {
      if (e.event_type === 'rear_gear_change') rear++;
      else if (e.event_type === 'front_gear_change') front++;
      else { rear++; } // generic gear_change — count as rear
    });
    return { rear, front, total: rear + front };
  }

  // Fall back to detecting changes in per-point gear data
  const gears = state.gearData;
  if (!gears || gears.length < 2) return { rear: 0, front: 0, total: 0 };

  let rear = 0, front = 0;
  for (let i = 1; i < gears.length; i++) {
    if (!gears[i]?.rear || !gears[i - 1]?.rear) continue;
    if (gears[i].rear !== gears[i - 1].rear) rear++;
    if (gears[i].front !== gears[i - 1].front) front++;
  }
  return { rear, front, total: rear + front };
}

/**
 * Get indices in state.gearData where a gear shift occurred.
 * Returns array of { index, type, direction } where direction is 'up' (harder)
 * or 'down' (easier) based on gear ratio change.
 */
function getShiftIndices() {
  const gears = state.gearData;
  if (!gears || gears.length < 2) return [];

  const shifts = [];
  for (let i = 1; i < gears.length; i++) {
    if (!gears[i]?.rear || !gears[i - 1]?.rear) continue;
    const rearChanged = gears[i].rear !== gears[i - 1].rear;
    const frontChanged = gears[i].front !== gears[i - 1].front;
    if (rearChanged || frontChanged) {
      // Gear ratio = front / rear. Higher ratio = harder gear = upshift
      const prevRatio = (gears[i - 1].front || 50) / (gears[i - 1].rear || 15);
      const newRatio = (gears[i].front || 50) / (gears[i].rear || 15);
      shifts.push({
        index: i,
        type: (rearChanged && frontChanged) ? 'both' : rearChanged ? 'rear' : 'front',
        direction: newRatio >= prevRatio ? 'up' : 'down'
      });
    }
  }
  return shifts;
}

function updateDataSourceBadge() {
  if (state.usingFitData) {
    let source = 'Di2 Actual (uploaded FIT)';
    if (state.fitGearData?.source === 'fit_library') {
      source = `Di2 Actual (${state.fitGearData.matched_file || 'auto-matched'})`;
    } else if (state.fitGearData?.source === 'strava_export') {
      source = 'Di2 Actual (from Strava FIT)';
    }
    els.dataSourceBadge.textContent = source;
    els.dataSourceBadge.className = 'badge fit-file';
    els.btnUploadFitDetail.textContent = 'Replace with different FIT';
    els.btnUploadFitDetail.classList.remove('btn-primary');
    els.btnUploadFitDetail.classList.add('btn-outline');
    els.btnDownloadFit.classList.add('hidden');
    els.fitImportPanel.classList.add('hidden');
  } else {
    els.dataSourceBadge.textContent = state.gearData ? 'Estimated from Cadence/Speed' : 'No gear data';
    els.dataSourceBadge.className = 'badge';
    els.btnUploadFitDetail.textContent = '📂 Upload FIT for actual Di2 data';
    els.btnUploadFitDetail.classList.add('btn-primary');
    els.btnUploadFitDetail.classList.remove('btn-outline');
  }
}

// ─── Settings / FIT Library Helpers ─────────────────────────────────────────

async function loadFitLibraryStatus() {
  try {
    const status = await api('/api/fit-library/status');
    if (els.fitLibraryStatus) {
      if (status.configured) {
        els.fitLibraryStatus.textContent = `✅ ${status.fileCount} FIT files indexed in ${status.folder}`;
        els.fitLibraryStatus.className = 'setting-status success';
      } else {
        els.fitLibraryStatus.textContent = 'Using ~/Downloads (default)';
        els.fitLibraryStatus.className = 'setting-status';
      }
    }
    if (els.fitFolderInput && status.folder) {
      els.fitFolderInput.value = status.folder;
    }
  } catch (err) {
    console.warn('Failed to load FIT library status:', err);
  }
}

async function saveFitFolderSetting() {
  const folder = els.fitFolderInput?.value?.trim();
  if (!folder) return;

  try {
    const result = await api('/api/fit-library/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder })
    });

    if (result.error) {
      els.fitLibraryStatus.textContent = `❌ ${result.error}`;
      els.fitLibraryStatus.className = 'setting-status error';
    } else {
      els.fitLibraryStatus.textContent = `✅ ${result.fileCount} FIT files indexed`;
      els.fitLibraryStatus.className = 'setting-status success';
    }
  } catch (err) {
    els.fitLibraryStatus.textContent = `❌ Failed to save`;
    els.fitLibraryStatus.className = 'setting-status error';
  }
}

// ─── Map Rendering ──────────────────────────────────────────────────────────

function renderMap() {
  const streams = state.streams;
  if (!streams?.latlng || streams.latlng.length === 0) return;

  // Clean up old map
  if (state.map) {
    state.map.remove();
    state.map = null;
  }

  // Create map
  state.map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    touchZoom: false,
    keyboard: false
  });

  // Dark tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(state.map);

  // Clear previous route layers
  state.routeLayers.forEach(l => state.map.removeLayer(l));
  state.routeLayers = [];

  const latlngs = streams.latlng;
  const gears = state.gearData;

  if (gears && gears.length === latlngs.length) {
    // Draw route colored by gear
    drawGearColoredRoute(latlngs, gears);
  } else {
    // Draw simple route
    const polyline = L.polyline(latlngs, {
      color: '#fc4c02',
      weight: 3,
      opacity: 0.9
    }).addTo(state.map);
    state.routeLayers.push(polyline);
  }

  // Fit bounds
  const bounds = L.latLngBounds(latlngs);
  state.map.fitBounds(bounds, { padding: [30, 30] });

  // Add start/end markers
  addStartEndMarkers(latlngs);

  // Hover marker
  state.marker = L.circleMarker([0, 0], {
    radius: 7,
    fillColor: '#ffffff',
    fillOpacity: 1,
    color: '#fc4c02',
    weight: 3
  });
}

function drawGearColoredRoute(latlngs, gears) {
  // Group consecutive points with the same gear into segments
  let segments = [];
  let currentSegment = { gear: null, points: [] };

  for (let i = 0; i < latlngs.length; i++) {
    const gearKey = gears[i]?.rear
      ? `${gears[i].front}-${gears[i].rear}`
      : 'unknown';

    if (gearKey !== currentSegment.gear) {
      if (currentSegment.points.length > 0) {
        // Add the current point as the start of the overlap
        currentSegment.points.push(latlngs[i]);
        segments.push({ ...currentSegment });
      }
      currentSegment = { gear: gearKey, gearData: gears[i], points: [latlngs[i]] };
    } else {
      currentSegment.points.push(latlngs[i]);
    }
  }
  if (currentSegment.points.length > 0) {
    segments.push(currentSegment);
  }

  // Draw each segment
  segments.forEach(seg => {
    if (seg.points.length < 2) return;

    const color = getGearColor(seg.gearData);
    const polyline = L.polyline(seg.points, {
      color: color,
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(state.map);

    // Tooltip
    if (seg.gearData?.front && seg.gearData?.rear) {
      polyline.bindTooltip(`${seg.gearData.front}/${seg.gearData.rear}`, {
        sticky: true,
        className: 'gear-tooltip'
      });
    }

    state.routeLayers.push(polyline);
  });
}

function addStartEndMarkers(latlngs) {
  // Start marker (green)
  L.circleMarker(latlngs[0], {
    radius: 8,
    fillColor: '#22c55e',
    fillOpacity: 1,
    color: '#fff',
    weight: 2
  }).addTo(state.map).bindTooltip('Start', { permanent: false });

  // End marker (red)
  L.circleMarker(latlngs[latlngs.length - 1], {
    radius: 8,
    fillColor: '#ef4444',
    fillOpacity: 1,
    color: '#fff',
    weight: 2
  }).addTo(state.map).bindTooltip('Finish', { permanent: false });
}

function getGearColor(gearData) {
  if (!gearData || !gearData.rear) return '#fc4c02';

  // Common cassette teeth counts
  const CASSETTE = [11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 28, 32, 34];

  // Find cassette position index (0 = smallest/hardest cog)
  let rearIdx = CASSETTE.indexOf(gearData.rear);
  if (rearIdx === -1) {
    // Approximate position
    rearIdx = CASSETTE.findIndex(t => t >= gearData.rear);
    if (rearIdx === -1) rearIdx = CASSETTE.length - 1;
  }

  // Invert so high index = easy gear gets warm colors
  const colorIdx = Math.min(rearIdx, GEAR_COLORS.length - 1);
  return GEAR_COLORS[GEAR_COLORS.length - 1 - colorIdx];
}

// ─── Chart Magnify Plugin ───────────────────────────────────────────────────

const magnifyPlugin = {
  id: 'magnify',
  _mouse: { x: -1000, y: -1000, active: false },
  _drawing: false,
  _snapshot: null,
  RADIUS: 80,
  ZOOM: 2.5,

  afterEvent(chart, args) {
    const event = args.event;
    const area = chart.chartArea;
    if (!area) return;

    if (event.type === 'mousemove') {
      const x = event.x;
      const y = event.y;
      if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
        this._mouse = { x, y, active: true };
      } else {
        this._mouse.active = false;
      }
    } else if (event.type === 'mouseout') {
      this._mouse.active = false;
    }
  },

  afterDraw(chart) {
    if (!this._mouse.active || this._drawing) return;
    this._drawing = true;

    const { x, y } = this._mouse;
    const R = this.RADIUS;
    const zoom = this.ZOOM;
    const canvas = chart.canvas;
    const ctx = chart.ctx;

    // Capture the fully-rendered chart to an offscreen canvas BEFORE we draw on it
    if (!this._snapshot) {
      this._snapshot = document.createElement('canvas');
    }
    this._snapshot.width = canvas.width;
    this._snapshot.height = canvas.height;
    this._snapshot.getContext('2d').drawImage(canvas, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const srcSize = (R * 2) / zoom;
    const sx = (x - srcSize / 2) * dpr;
    const sy = (y - srcSize / 2) * dpr;

    ctx.save();

    // Clip to circle at cursor
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.clip();

    // Dark background fill
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(x - R, y - R, R * 2, R * 2);

    // Draw zoomed portion from the snapshot (not the live canvas)
    ctx.drawImage(
      this._snapshot,
      sx, sy,
      srcSize * dpr, srcSize * dpr,
      x - R, y - R,
      R * 2, R * 2
    );

    ctx.restore();

    // Lens border
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, R - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x - 10, y);
    ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y + 10);
    ctx.stroke();

    ctx.restore();
    this._drawing = false;
  }
};

// ─── Shift Arrow Icons ──────────────────────────────────────────────────────

/**
 * Pre-render arrow icons as small canvases for use as Chart.js pointStyle.
 * This guarantees exact vertical orientation regardless of Chart.js rotation bugs.
 */
function createArrowIcon(direction, fillColor, size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const mid = size / 2;
  const pad = 2;

  ctx.fillStyle = fillColor;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';

  ctx.beginPath();
  if (direction === 'up') {
    // Arrow pointing UP: vertex at top
    ctx.moveTo(mid, pad);
    ctx.lineTo(size - pad, size - pad);
    ctx.lineTo(pad, size - pad);
  } else {
    // Arrow pointing DOWN: vertex at bottom
    ctx.moveTo(pad, pad);
    ctx.lineTo(size - pad, pad);
    ctx.lineTo(mid, size - pad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  return c;
}

// Cache the arrow icons so we don't recreate them every render
const ARROW_SIZE = 18;
const arrowUpRed = createArrowIcon('up', '#ef4444', ARROW_SIZE);
const arrowDownBlue = createArrowIcon('down', '#3b82f6', ARROW_SIZE);

// ─── Elevation Chart ────────────────────────────────────────────────────────

function renderElevationChart() {
  const streams = state.streams;
  if (!streams?.altitude || !streams?.distance) return;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  updateElevationChart();
}

function updateElevationChart() {
  const streams = state.streams;
  const gears = state.gearData;
  const showGradient = els.toggleGradient.checked;
  const showCadence = els.toggleCadence.checked;
  const showOptimalGear = els.toggleOptimalGear.checked;

  if (state.chart) {
    state.chart.destroy();
  }

  // Reset zoom button when chart is rebuilt
  els.btnResetZoom.classList.add('hidden');

  const ctx = els.elevationChart.getContext('2d');
  const distances = streams.distance.map(d => distFromMetres(d).toFixed(2));
  const elevations = streams.altitude.map(a => elevFromMetres(a));

  // Build colored segments for the elevation line
  const pointColors = [];
  const segmentColors = [];

  for (let i = 0; i < elevations.length; i++) {
    if (gears && gears[i]) {
      pointColors.push(getGearColor(gears[i]));
    } else {
      pointColors.push('#fc4c02');
    }

    if (i > 0) {
      if (gears && gears[i]) {
        segmentColors.push(getGearColor(gears[i]));
      } else {
        segmentColors.push('#fc4c02');
      }
    }
  }

  // Gradient data
  const gradients = [];
  if (showGradient && streams.grade_smooth) {
    for (let i = 0; i < streams.grade_smooth.length; i++) {
      gradients.push(streams.grade_smooth[i]);
    }
  }

  // Build shift marker data — sparse array with elevation only at shift points
  const shiftIndices = getShiftIndices();
  const shiftData = new Array(elevations.length).fill(null);
  // Direction map: 'up' = harder gear (ratio increase), 'down' = easier gear
  const shiftDirection = new Array(elevations.length).fill(null);
  shiftIndices.forEach(s => {
    shiftData[s.index] = elevations[s.index];
    shiftDirection[s.index] = s.direction; // 'up' or 'down'
  });

  const datasets = [
    {
      label: 'Elevation (m)',
      data: elevations,
      borderColor: segmentColors.length > 0 ? segmentColors : '#fc4c02',
      backgroundColor: createElevationGradient(ctx, elevations),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: '#fc4c02',
      fill: true,
      tension: 0.2,
      segment: {
        borderColor: (ctx) => {
          if (segmentColors.length > 0 && ctx.p0DataIndex < segmentColors.length) {
            return segmentColors[ctx.p0DataIndex];
          }
          return '#fc4c02';
        }
      },
      yAxisID: 'y'
    }
  ];

  // Add gear shift markers as directional arrows on the elevation line
  // Up arrows (▲) = upshift (harder gear / higher ratio)  — red
  // Down arrows (▼) = downshift (easier gear / lower ratio) — blue
  if (shiftIndices.length > 0) {
    datasets.push({
      label: 'Gear Shifts',
      data: shiftData,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      borderWidth: 0,
      pointRadius: (ctx) => shiftData[ctx.dataIndex] !== null ? ARROW_SIZE / 2 : 0,
      pointHoverRadius: (ctx) => shiftData[ctx.dataIndex] !== null ? ARROW_SIZE / 2 + 2 : 0,
      pointStyle: (ctx) => {
        const dir = shiftDirection[ctx.dataIndex];
        if (dir === 'up') return arrowUpRed;
        if (dir === 'down') return arrowDownBlue;
        return false;
      },
      fill: false,
      showLine: false,
      yAxisID: 'y',
      order: -1  // draw on top
    });
  }

  // Add gradient dataset
  if (showGradient && gradients.length > 0) {
    datasets.push({
      label: 'Gradient (%)',
      data: gradients,
      borderColor: 'rgba(139, 92, 246, 0.5)',
      backgroundColor: 'transparent',
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'y1'
    });
  }

  // Add cadence dataset
  const cadenceData = [];
  if (showCadence && streams.cadence) {
    for (let i = 0; i < streams.cadence.length; i++) {
      cadenceData.push(streams.cadence[i]);
    }
  }
  if (showCadence && cadenceData.length > 0) {
    datasets.push({
      label: 'Cadence (rpm)',
      data: cadenceData,
      borderColor: 'rgba(34, 197, 94, 0.5)',
      backgroundColor: 'transparent',
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'y2'
    });
  }

  // Add optimal gear ratio overlay
  const optimalRatioData = [];
  if (showOptimalGear && state.optimalGears) {
    for (let i = 0; i < state.optimalGears.length; i++) {
      const g = state.optimalGears[i];
      optimalRatioData.push(g ? (g.front / g.rear) : null);
    }
  }
  if (showOptimalGear && optimalRatioData.length > 0) {
    datasets.push({
      label: 'Optimal Gear Ratio',
      data: optimalRatioData,
      borderColor: 'rgba(251, 191, 36, 0.7)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'y3'
    });
  }

  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels: distances, datasets },
    plugins: [magnifyPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        zoom: {
          pan: {
            enabled: false
          },
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: false },
            drag: {
              enabled: true,
              backgroundColor: 'rgba(252, 76, 2, 0.15)',
              borderColor: 'rgba(252, 76, 2, 0.6)',
              borderWidth: 1
            },
            mode: 'x',
            onZoomComplete: () => {
              els.btnResetZoom.classList.remove('hidden');
            }
          },
          limits: {
            x: { minRange: 10 }
          }
        }
      },
      scales: {
        x: {
          display: true,
          title: { display: true, text: `Distance (${distUnit()})`, color: '#8b8fa3' },
          ticks: {
            color: '#8b8fa3',
            maxTicksLimit: 20,
            callback: (val, idx) => {
              // Show every Nth label
              const step = Math.max(1, Math.floor(distances.length / 20));
              return idx % step === 0 ? distances[idx] : '';
            }
          },
          grid: { color: 'rgba(42,45,58,0.5)' }
        },
        y: {
          display: true,
          title: { display: true, text: `Elevation (${elevUnit()})`, color: '#8b8fa3' },
          ticks: { color: '#8b8fa3' },
          grid: { color: 'rgba(42,45,58,0.5)' }
        },
        ...(showGradient && gradients.length > 0 ? {
          y1: {
            display: true,
            position: 'right',
            title: { display: true, text: 'Gradient (%)', color: '#8b8fa3' },
            ticks: { color: '#8b8fa3' },
            grid: { display: false }
          }
        } : {}),
        ...(showCadence && cadenceData.length > 0 ? {
          y2: {
            display: true,
            position: 'right',
            title: { display: true, text: 'Cadence (rpm)', color: 'rgba(34, 197, 94, 0.7)' },
            ticks: { color: 'rgba(34, 197, 94, 0.7)' },
            grid: { display: false }
          }
        } : {}),
        ...(showOptimalGear && optimalRatioData.length > 0 ? {
          y3: {
            display: true,
            position: 'right',
            title: { display: true, text: 'Gear Ratio', color: 'rgba(251, 191, 36, 0.7)' },
            ticks: { color: 'rgba(251, 191, 36, 0.7)' },
            grid: { display: false }
          }
        } : {})
      },
      onHover: (event, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          highlightPoint(idx);
        }
      }
    }
  });
}

function createElevationGradient(ctx, elevations) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(252, 76, 2, 0.3)');
  gradient.addColorStop(1, 'rgba(252, 76, 2, 0.02)');
  return gradient;
}

// ─── Fullscreen Toggle ──────────────────────────────────────────────────────────────

function toggleFullscreen(element) {
  if (document.fullscreenElement === element) {
    document.exitFullscreen();
  } else {
    element.requestFullscreen();
  }
}

function handleFullscreenChange() {
  // Resize map when entering/exiting fullscreen
  if (state.map) {
    setTimeout(() => state.map.invalidateSize(), 100);
  }
  // Resize chart when entering/exiting fullscreen
  if (state.chart) {
    setTimeout(() => state.chart.resize(), 100);
  }
}

// ─── Point Highlighting (Syncs Map & Chart) ─────────────────────────────────

function highlightPoint(index) {
  const streams = state.streams;
  if (!streams?.latlng) return;

  const latlng = streams.latlng[index];
  if (!latlng) return;

  // Move marker on map
  if (state.marker && state.map) {
    state.marker.setLatLng(latlng);
    if (!state.map.hasLayer(state.marker)) {
      state.marker.addTo(state.map);
    }
  }

  // Update hover info panel — pinned to top-left of elevation container
  const gears = state.gearData;
  els.hoverInfo.classList.remove('hidden');

  if (gears && gears[index]?.front && gears[index]?.rear) {
    els.hoverGear.textContent = `${gears[index].front}/${gears[index].rear}`;
    els.hoverGear.style.color = getGearColor(gears[index]);
  } else {
    els.hoverGear.textContent = '—';
    els.hoverGear.style.color = '';
  }

  els.hoverElevation.textContent = streams.altitude?.[index]
    ? `${elevFromMetres(streams.altitude[index]).toFixed(0)} ${elevUnit()}` : '—';
  els.hoverDistance.textContent = streams.distance?.[index]
    ? `${distFromMetres(streams.distance[index]).toFixed(2)} ${distUnit()}` : '—';
  els.hoverGradient.textContent = streams.grade_smooth?.[index] !== undefined
    ? `${streams.grade_smooth[index].toFixed(1)}%` : '—';
  els.hoverSpeed.textContent = streams.velocity_smooth?.[index]
    ? `${speedFromMs(streams.velocity_smooth[index]).toFixed(1)} ${speedUnit()}` : '—';
  els.hoverCadence.textContent = streams.cadence?.[index]
    ? `${streams.cadence[index]} rpm` : '—';
  els.hoverPower.textContent = streams.watts?.[index]
    ? `${streams.watts[index]} W` : '—';
}

// ─── Gear Legend ────────────────────────────────────────────────────────────

function renderGearLegend() {
  const gears = state.gearData;
  if (!gears) {
    els.gearLegend.innerHTML = '<span style="color: var(--text-muted)">No gear data available. Upload a FIT file for Di2 data.</span>';
    return;
  }

  // Collect unique gears
  const uniqueGears = new Map();
  gears.forEach(g => {
    if (g?.front && g?.rear) {
      const key = `${g.front}/${g.rear}`;
      if (!uniqueGears.has(key)) {
        uniqueGears.set(key, { front: g.front, rear: g.rear, color: getGearColor(g) });
      }
    }
  });

  // Sort by gear ratio (hardest → easiest)
  const sorted = Array.from(uniqueGears.values()).sort((a, b) =>
    (b.front / b.rear) - (a.front / a.rear)
  );

  els.gearLegend.innerHTML = sorted.map(g => `
    <div class="gear-legend-item">
      <span class="gear-legend-swatch" style="background: ${g.color}"></span>
      <span>${g.front}/${g.rear}</span>
    </div>
  `).join('');
}

// ─── Gear Statistics ────────────────────────────────────────────────────────

function renderGearStats() {
  const gears = state.gearData;
  if (!gears) {
    els.gearStatsContainer.classList.add('hidden');
    return;
  }

  // Count time/distance in each gear
  const gearCounts = new Map();
  let totalValid = 0;

  gears.forEach((g, i) => {
    if (g?.front && g?.rear) {
      const key = `${g.front}/${g.rear}`;
      gearCounts.set(key, (gearCounts.get(key) || 0) + 1);
      totalValid++;
    }
  });

  if (totalValid === 0) {
    els.gearStatsContainer.classList.add('hidden');
    return;
  }

  // Sort by usage
  const sorted = Array.from(gearCounts.entries())
    .map(([key, count]) => {
      const [front, rear] = key.split('/').map(Number);
      return {
        key, front, rear, count,
        percentage: ((count / totalValid) * 100).toFixed(1),
        color: getGearColor({ front, rear })
      };
    })
    .sort((a, b) => b.count - a.count);

  els.gearStatsContainer.classList.remove('hidden');

  // Scale factor: largest gear gets scale 1.0, smallest gets 0.6, linear in between
  const maxCount = sorted[0].count;
  const minScale = 0.6;

  els.gearStats.innerHTML = sorted.map(g => {
    const scale = minScale + (1 - minScale) * (g.count / maxCount);
    return `
    <div class="gear-stat-card" data-front="${g.front}" data-rear="${g.rear}" data-color="${g.color}" style="transform: scale(${scale.toFixed(3)}); transform-origin: top left;">
      <div class="gear-stat-color" style="background: ${g.color}"></div>
      <div class="gear-stat-info">
        <h4>${g.key}</h4>
        <span class="percentage">${g.percentage}% of ride</span>
        <div class="gear-stat-bar">
          <div class="gear-stat-bar-fill" style="width: ${g.percentage}%; background: ${g.color}"></div>
        </div>
      </div>
    </div>
  `;
  }).join('');

  // Attach click handlers to each gear card
  els.gearStats.querySelectorAll('.gear-stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const front = Number(card.dataset.front);
      const rear  = Number(card.dataset.rear);
      const color = card.dataset.color;
      showGearPopup(front, rear, color);
    });
  });
}

// ─── AI Slider Modal ────────────────────────────────────────────────────────

async function showAiSliderModal() {
  // Reset slider to defaults while we fetch stats
  els.aiActivitySlider.value = 5;
  els.aiSliderValue.textContent = '5';
  els.aiSliderWarning.classList.add('hidden');
  els.aiSliderModal.classList.remove('hidden');

  try {
    const stats = await api('/api/athlete-stats');
    const max = Math.max(1, stats.totalRides || 10);
    els.aiActivitySlider.max = max;
    // Keep current value in range
    if (parseInt(els.aiActivitySlider.value) > max) {
      els.aiActivitySlider.value = max;
      els.aiSliderValue.textContent = max;
    }
  } catch {
    // Fallback — leave slider max at a reasonable default
    els.aiActivitySlider.max = 50;
  }
}

// ─── AI Analysis ────────────────────────────────────────────────────────────

async function runAiAnalysis(count = 10) {
  els.aiAnalysisModal.classList.remove('hidden');
  els.aiAnalysisLoading.classList.remove('hidden');
  els.aiAnalysisResults.classList.add('hidden');
  els.aiAnalysisError.classList.add('hidden');

  // Update loading text to reflect chosen count
  const loadingSpan = els.aiAnalysisLoading.querySelector('span');
  if (loadingSpan) loadingSpan.textContent = `Analysing your last ${count} ride${count > 1 ? 's' : ''}...`;

  try {
    const result = await api(`/api/ai-analysis?count=${encodeURIComponent(count)}`);

    if (result.error) {
      els.aiAnalysisLoading.classList.add('hidden');
      els.aiAnalysisError.classList.remove('hidden');
      els.aiErrorText.textContent = result.error;
      return;
    }

    els.aiAnalysisLoading.classList.add('hidden');
    els.aiAnalysisResults.classList.remove('hidden');

    // Rating display
    const stars = '★'.repeat(result.rating) + '☆'.repeat(5 - result.rating);
    els.aiRating.innerHTML = `
      <div class="ai-rating-stars">${stars}</div>
      <div class="ai-rating-label">${result.rating}/5 — Overall Shifting Score</div>
      <div class="ai-rating-percent">${result.overallPercent}% efficiency across ${result.analysedCount} ride${result.analysedCount > 1 ? 's' : ''}</div>
    `;

    // Component bars
    const comps = result.components;
    els.aiComponents.innerHTML = `
      <div class="ai-comp">
        <span class="ai-comp-label">Cadence Efficiency</span>
        <div class="ai-comp-bar"><div class="ai-comp-fill" style="width:${comps.cadence}%; background: #22c55e"></div></div>
        <span class="ai-comp-pct">${comps.cadence}%</span>
      </div>
      <div class="ai-comp">
        <span class="ai-comp-label">Cross-Chain Avoidance</span>
        <div class="ai-comp-bar"><div class="ai-comp-fill" style="width:${comps.crossChain}%; background: #3b82f6"></div></div>
        <span class="ai-comp-pct">${comps.crossChain}%</span>
      </div>
      <div class="ai-comp">
        <span class="ai-comp-label">Gradient Matching</span>
        <div class="ai-comp-bar"><div class="ai-comp-fill" style="width:${comps.gradient}%; background: #f59e0b"></div></div>
        <span class="ai-comp-pct">${comps.gradient}%</span>
      </div>
      <div class="ai-comp">
        <span class="ai-comp-label">Shift Smoothness</span>
        <div class="ai-comp-bar"><div class="ai-comp-fill" style="width:${comps.hunting}%; background: #8b5cf6"></div></div>
        <span class="ai-comp-pct">${comps.hunting}%</span>
      </div>
    `;

    // Summary text
    els.aiSummary.textContent = result.summary;

    // Score-over-time chart
    renderAiScoreChart(result.activities);

    // Per-activity breakdown
    if (result.activities?.length) {
      els.aiActivities.innerHTML = `
        <h4>Per-Ride Breakdown</h4>
        <table class="ai-activities-table">
          <thead><tr><th>Ride</th><th>Date</th><th>Score</th></tr></thead>
          <tbody>
            ${result.activities.map(a => `
              <tr>
                <td>${escapeHtml(a.name)}</td>
                <td>${new Date(a.date).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</td>
                <td>${'★'.repeat(a.rating)}${'☆'.repeat(5 - a.rating)} (${a.overall}%)</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

  } catch (err) {
    console.error('AI Analysis failed:', err);
    els.aiAnalysisLoading.classList.add('hidden');
    els.aiAnalysisError.classList.remove('hidden');
    els.aiErrorText.textContent = 'Failed to run analysis. Check console for details.';
  }
}

// ─── AI Score-Over-Time Chart ───────────────────────────────────────────────

let aiScoreChartInstance = null;

function renderAiScoreChart(activities) {
  if (!activities || activities.length < 2) {
    els.aiScoreChart.classList.add('hidden');
    return;
  }

  els.aiScoreChart.classList.remove('hidden');

  // Sort chronologically (oldest first)
  const sorted = [...activities].sort((a, b) => new Date(a.date) - new Date(b.date));

  const labels = sorted.map(a =>
    new Date(a.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  );

  const mkDataset = (label, key, color, fill = false) => ({
    label,
    data: sorted.map(a => parseInt(a[key])),
    borderColor: color,
    backgroundColor: fill ? color.replace(')', ', 0.10)').replace('rgb', 'rgba') : 'transparent',
    fill,
    tension: 0.35,
    pointRadius: 3,
    pointBackgroundColor: color,
    pointBorderWidth: 0,
    pointHoverRadius: 5,
    borderWidth: fill ? 2.5 : 1.5,
    borderDash: fill ? [] : [4, 3]
  });

  // Destroy previous instance if it exists
  if (aiScoreChartInstance) {
    aiScoreChartInstance.destroy();
    aiScoreChartInstance = null;
  }

  const ctx = els.aiScoreCanvas.getContext('2d');
  aiScoreChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        mkDataset('Overall Score',       'overall',    'rgb(59, 130, 246)',  true),
        mkDataset('Cadence Efficiency',   'cadence',    'rgb(34, 197, 94)'),
        mkDataset('Cross-Chain Avoidance','crossChain', 'rgb(99, 102, 241)'),
        mkDataset('Gradient Matching',    'gradient',   'rgb(245, 158, 11)'),
        mkDataset('Shift Smoothness',     'hunting',    'rgb(139, 92, 246)')
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: {
            callback: v => v + '%',
            color: 'rgba(255,255,255,0.5)',
            font: { size: 11 }
          },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: {
          ticks: {
            color: 'rgba(255,255,255,0.5)',
            font: { size: 11 },
            maxRotation: 45
          },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: 'rgba(255,255,255,0.7)',
            font: { size: 11 },
            boxWidth: 14,
            padding: 12,
            usePointStyle: true,
            pointStyle: 'line'
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => sorted[items[0].dataIndex]?.name || items[0].label,
            label: (item) => `${item.dataset.label}: ${item.raw}%`
          }
        }
      }
    }
  });
}

async function loadOptimalGears() {
  const streams = state.streams;
  if (!streams?.cadence || !streams?.velocity_smooth) return;

  try {
    const result = await api('/api/optimal-gears', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cadence: streams.cadence,
        velocity_smooth: streams.velocity_smooth,
        grade_smooth: streams.grade_smooth,
        distance: streams.distance
      })
    });
    state.optimalGears = result.optimalGears;
  } catch (err) {
    console.error('Failed to load optimal gears:', err);
  }
}

// ─── Auto-Match Di2 Data from FIT Library ───────────────────────────────────

/**
 * Try to automatically load Di2 gear data:
 * 1. Check FIT Library for an already-present matching .FIT file
 * 2. If not found, trigger Strava FIT download and poll until it appears
 */
async function autoMatchDi2Data(activity) {
  if (!activity?.start_date) return;

  // Show status in import panel
  showAutoStatus('Checking for Di2 data...');

  try {
    // Step 1: Check if a matching FIT file already exists in the library
    const result = await api(`/api/activity/${activity.id}/auto-fit?start_date=${encodeURIComponent(activity.start_date)}`);

    if (result.has_gear_data) {
      console.log(`[Di2va] Auto-matched Di2 data from FIT library: ${result.matched_file}`);
      applyAutoMatchResult(result);
      return;
    }

    // Step 2: Try fetching FIT via server-side API (OAuth token, no browser popup)
    showAutoStatus('Fetching FIT from Strava API...');
    const apiResult = await api(`/api/activity/${activity.id}/fit-gear-data`);

    if (apiResult.has_gear_data) {
      console.log('[Di2va] Got Di2 data via server-side Strava API');
      applyAutoMatchResult(apiResult);
      return;
    }

    // Step 3: API didn't return gear data — try browser-cookie download + poll
    console.log('[Di2va] Server API had no gear data — trying browser download...');
    showAutoStatus('Downloading FIT from Strava...');
    triggerFitDownloadSilent();

    // Step 4: Poll for the FIT to appear in ~/Downloads
    const POLL_INTERVAL = 2000; // 2 seconds
    const MAX_POLLS = 15;       // 30 seconds max
    let polls = 0;

    const pollTimer = setInterval(async () => {
      polls++;

      // Stop if we navigated away from this activity
      if (state.currentActivity?.id !== activity.id) {
        clearInterval(pollTimer);
        return;
      }

      try {
        const pollResult = await api(`/api/activity/${activity.id}/auto-fit?start_date=${encodeURIComponent(activity.start_date)}`);

        if (pollResult.has_gear_data) {
          clearInterval(pollTimer);
          console.log(`[Di2va] FIT detected after ${polls * 2}s: ${pollResult.matched_file}`);
          applyAutoMatchResult(pollResult);
          return;
        }
      } catch (err) {
        console.warn('[Di2va] Poll error:', err.message);
      }

      if (polls >= MAX_POLLS) {
        clearInterval(pollTimer);
        console.log('[Di2va] Polling timed out — showing manual import panel');
        showManualImportPanel();
      } else {
        showAutoStatus(`Waiting for FIT download... (${polls * 2}s)`);
      }
    }, POLL_INTERVAL);

  } catch (err) {
    console.warn('[Di2va] Auto-match failed:', err.message);
    showManualImportPanel();
  }
}

/**
 * Apply auto-matched Di2 data to the current visualizations.
 */
function applyAutoMatchResult(result) {
  state.fitGearData = result;
  state.usingFitData = true;

  // Merge FIT gear data with Strava streams
  mergeFitDataWithStreams(result);

  // Hide import panel, update badge
  els.fitImportPanel.classList.add('hidden');
  updateDataSourceBadge();

  // Refresh all visualizations
  renderActivityStats(state.currentActivity);
  renderMap();
  updateElevationChart();
  renderGearLegend();
  renderGearStats();
}

/**
 * Show an auto-download status message in the import panel area.
 */
function showAutoStatus(message) {
  els.fitImportPanel.classList.remove('hidden');
  els.fitImportPanel.innerHTML = `
    <div class="fit-import-content auto-status">
      <div class="spinner-inline"></div>
      <span>${message}</span>
    </div>
  `;
}

/**
 * Revert import panel to manual mode (download + upload buttons).
 */
function showManualImportPanel() {
  els.fitImportPanel.classList.remove('hidden');
  els.fitImportPanel.innerHTML = `
    <div class="fit-import-content">
      <div class="fit-import-icon">⚙️</div>
      <h3>Get Actual Di2 Gear Data</h3>
      <p>The automatic FIT download didn't complete. You can try again or upload manually:</p>
      <div class="fit-import-actions">
        <button id="btn-download-fit-panel" class="btn btn-strava" onclick="downloadFitFromStrava()">
          ⬇ Fetch FIT from Strava
        </button>
        <button id="btn-upload-fit-panel" class="btn btn-outline" onclick="document.getElementById('fit-file-input-detail').click()">
          📂 Choose FIT File
        </button>
      </div>
      <button class="btn btn-sm btn-outline" style="margin-top: 8px" onclick="this.closest('.fit-import-panel').classList.add('hidden')">Skip — use estimated data</button>
    </div>
  `;
}

// ─── Download FIT from Strava ───────────────────────────────────────────────

/**
 * Silent FIT download — uses a hidden iframe so no popup/tab appears.
 * Falls back to window.open if iframe approach doesn't work.
 */
function triggerFitDownloadSilent() {
  if (!state.currentActivity?.id) return;
  const url = `https://www.strava.com/activities/${state.currentActivity.id}/export_original`;

  // Create a hidden iframe to trigger the download without a visible tab
  let iframe = document.getElementById('fit-download-frame');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'fit-download-frame';
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
  }
  iframe.src = url;
}

/**
 * Manual FIT download button handler — tries server-side API first,
 * then falls back to silent iframe download if no gear data returned.
 */
async function downloadFitFromStrava() {
  if (!state.currentActivity?.id) return;

  // Try server-side API first (no browser download UI)
  try {
    showAutoStatus('Fetching FIT from Strava API...');
    const result = await api(`/api/activity/${state.currentActivity.id}/fit-gear-data`);
    if (result.has_gear_data) {
      applyAutoMatchResult(result);
      return;
    }
  } catch (err) {
    console.warn('[Di2va] Server-side FIT fetch failed:', err.message);
  }

  // Fall back to hidden iframe download (uses browser Strava cookies)
  triggerFitDownloadSilent();
}

// ─── Drag & Drop for .FIT Files ─────────────────────────────────────────────

function setupDragAndDrop() {
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    // Only show overlay on detail screen
    if (!els.detailScreen.classList.contains('hidden')) {
      els.dropOverlay.classList.remove('hidden');
    }
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      els.dropOverlay.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    els.dropOverlay.classList.add('hidden');

    // Find .fit files in the drop
    const files = Array.from(e.dataTransfer.files);
    const fitFile = files.find(f =>
      f.name.toLowerCase().endsWith('.fit')
    );

    if (!fitFile) {
      // Check if any files were dropped at all
      if (files.length > 0) {
        alert('Please drop a .FIT file (the file you dropped is not a .FIT file).');
      }
      return;
    }

    // If we're on the detail screen with streams loaded, merge with current activity
    if (!els.detailScreen.classList.contains('hidden') && state.streams) {
      await parseFitFile(fitFile, false);
    } else {
      // Standalone FIT file load
      await parseFitFile(fitFile, true);
    }
  });
}

// ─── FIT File Upload Handlers ───────────────────────────────────────────────

async function handleFitUploadFromList(e) {
  const file = e.target.files[0];
  if (!file) return;
  await parseFitFile(file, true);
  e.target.value = '';
}

async function handleFitUploadForActivity(e) {
  const file = e.target.files[0];
  if (!file) return;
  await parseFitFile(file, false);
  e.target.value = '';
}

async function parseFitFile(file, standalone) {
  const formData = new FormData();
  formData.append('fitfile', file);

  try {
    const result = await fetch('/api/parse-fit', {
      method: 'POST',
      body: formData
    }).then(r => r.json());

    if (result.error) {
      alert(`Error parsing FIT file: ${result.error}`);
      return;
    }

    state.fitGearData = result;

    console.log(`[Di2va] FIT parsed: ${result.records.length} records, ${result.gear_changes?.length || 0} gear changes, has_gear_data=${result.has_gear_data}`);

    if (result.has_gear_data) {
      state.usingFitData = true;

      if (standalone && result.records.length > 0) {
        // Use FIT file data directly (no Strava activity needed)
        console.log('[Di2va] Using standalone FIT path (openFitActivity)');
        openFitActivity(result);
      } else if (!standalone && state.streams) {
        // Merge FIT gear data with Strava streams
        console.log('[Di2va] Merging FIT gear data with Strava streams');
        mergeFitDataWithStreams(result);
        els.fitImportPanel.classList.add('hidden');
        updateDataSourceBadge();
        renderActivityStats(state.currentActivity);  // refresh shift counts
        renderMap();
        updateElevationChart();
        renderGearLegend();
        renderGearStats();
      }
    } else {
      alert('No Di2 gear shift data found in this FIT file. Make sure the file is from a ride recorded with a Shimano Di2 drivetrain.');
    }
  } catch (err) {
    console.error('FIT upload error:', err);
    alert('Failed to upload and parse FIT file.');
  }
}

function openFitActivity(fitData) {
  showScreen('detail');

  const session = fitData.session;
  const records = fitData.records;

  // Build activity-like object from FIT data
  state.currentActivity = {
    name: session?.sport || 'FIT File Activity',
    distance: session?.total_distance ? session.total_distance * 1000 : 0,
    total_elevation_gain: session?.total_ascent || 0,
    moving_time: session?.total_timer_time || 0,
    average_speed: session?.avg_speed || 0,
    max_speed: session?.max_speed || 0,
    average_watts: session?.avg_power || null,
    average_cadence: session?.avg_cadence || null,
    start_date_local: session?.start_time || new Date()
  };

  // Build streams from FIT records
  const streams = {
    latlng: [],
    altitude: [],
    distance: [],
    cadence: [],
    watts: [],
    velocity_smooth: [],
    grade_smooth: [],
    time: []
  };

  const gears = [];

  records.forEach((rec, i) => {
    if (rec.position_lat !== undefined && rec.position_long !== undefined) {
      streams.latlng.push([rec.position_lat, rec.position_long]);
      streams.altitude.push(rec.altitude || 0);
      streams.distance.push(rec.distance ? rec.distance * 1000 : 0);
      streams.cadence.push(rec.cadence || 0);
      streams.watts.push(rec.power || 0);
      streams.velocity_smooth.push(rec.speed ? rec.speed / 3.6 : 0);
      streams.time.push(rec.elapsed_time || i);

      // Calculate grade
      if (streams.latlng.length > 1) {
        const dDist = streams.distance[streams.distance.length - 1] -
                      streams.distance[streams.distance.length - 2];
        const dElev = streams.altitude[streams.altitude.length - 1] -
                      streams.altitude[streams.altitude.length - 2];
        const grade = dDist > 0 ? (dElev / dDist) * 100 : 0;
        streams.grade_smooth.push(Math.max(-25, Math.min(25, grade)));
      } else {
        streams.grade_smooth.push(0);
      }

      gears.push({
        front: rec.front_gear_teeth || null,
        rear: rec.rear_gear_teeth || null,
        gear_ratio: rec.gear_ratio || null,
        estimated: false
      });
    }
  });

  state.streams = streams;
  state.gearData = gears;

  els.detailTitle.textContent = state.currentActivity.name;
  renderActivityStats(state.currentActivity);
  els.dataSourceBar.classList.remove('hidden');
  updateDataSourceBadge();
  renderMap();
  renderElevationChart();
  renderGearLegend();
  renderGearStats();
}

function mergeFitDataWithStreams(fitData) {
  if (!state.streams || !fitData.records.length) return;

  const fitRecords = fitData.records;
  const stravaLatlngs = state.streams.latlng;
  const stravaTime = state.streams.time;        // elapsed seconds from Strava
  const stravaDist = state.streams.distance;    // meters from Strava
  const gears = [];

  // Strategy 1: Match by elapsed time (most reliable)
  // Strava 'time' stream = elapsed seconds. FIT 'elapsed_time' = elapsed seconds.
  const useTime = stravaTime && stravaTime.length === stravaLatlngs.length &&
                  fitRecords.some(r => r.elapsed_time !== undefined && r.elapsed_time !== null);

  // Strategy 2: Match by distance
  // Strava distance is in meters. FIT distance (with lengthUnit:'km') is in km.
  const useDist = !useTime && stravaDist && stravaDist.length === stravaLatlngs.length &&
                  fitRecords.some(r => r.distance !== undefined && r.distance !== null);

  if (useTime) {
    console.log(`[Di2va] Merge strategy: elapsed time (stravaTime: ${stravaTime.length} pts, fitRecords: ${fitRecords.length})`);
    // Two-pointer merge by elapsed time
    let fitIdx = 0;
    for (let i = 0; i < stravaLatlngs.length; i++) {
      const t = stravaTime[i] || 0;

      while (fitIdx < fitRecords.length - 1) {
        const currDiff = Math.abs((fitRecords[fitIdx].elapsed_time || 0) - t);
        const nextDiff = Math.abs((fitRecords[fitIdx + 1].elapsed_time || 0) - t);
        if (nextDiff < currDiff) { fitIdx++; } else { break; }
      }

      const fitRec = fitRecords[fitIdx];
      gears.push({
        front: fitRec.front_gear_teeth || null,
        rear: fitRec.rear_gear_teeth || null,
        gear_ratio: fitRec.gear_ratio || null,
        estimated: false
      });
    }
  } else if (useDist) {
    console.log(`[Di2va] Merge strategy: distance (stravaDist: ${stravaDist.length} pts, fitRecords: ${fitRecords.length})`);
    // Two-pointer merge by distance
    let fitIdx = 0;
    for (let i = 0; i < stravaLatlngs.length; i++) {
      const d = stravaDist[i] || 0; // meters

      while (fitIdx < fitRecords.length - 1) {
        const currDiff = Math.abs((fitRecords[fitIdx].distance || 0) * 1000 - d);
        const nextDiff = Math.abs((fitRecords[fitIdx + 1].distance || 0) * 1000 - d);
        if (nextDiff < currDiff) { fitIdx++; } else { break; }
      }

      const fitRec = fitRecords[fitIdx];
      gears.push({
        front: fitRec.front_gear_teeth || null,
        rear: fitRec.rear_gear_teeth || null,
        gear_ratio: fitRec.gear_ratio || null,
        estimated: false
      });
    }
  } else {
    console.log('[Di2va] Merge strategy: proportional index (no time or distance)');
    // Fallback: proportional index mapping (no time or distance available)
    for (let i = 0; i < stravaLatlngs.length; i++) {
      const fitIdx = Math.min(
        Math.round((i / stravaLatlngs.length) * fitRecords.length),
        fitRecords.length - 1
      );
      const fitRec = fitRecords[fitIdx];
      gears.push({
        front: fitRec.front_gear_teeth || null,
        rear: fitRec.rear_gear_teeth || null,
        gear_ratio: fitRec.gear_ratio || null,
        estimated: false
      });
    }
  }

  state.gearData = gears;

  // Log gear distribution for debugging
  const combos = new Map();
  gears.forEach(g => {
    if (g?.front && g?.rear) combos.set(`${g.front}/${g.rear}`, (combos.get(`${g.front}/${g.rear}`) || 0) + 1);
  });
  console.log(`[Di2va] Merged gear distribution (${gears.length} points, ${combos.size} combos):`,
    [...combos.entries()].sort((a,b) => b[1]-a[1]).slice(0, 5).map(([k,v]) => `${k}:${v}`).join(', '));
}

// ─── Gear Visualization (SVG Drivetrain) ────────────────────────────────────

/**
 * Generate an SVG gear/cog path centred at (cx, cy).
 */
function gearPath(cx, cy, teeth, outerR, innerR) {
  const pts = [];
  const steps = teeth * 2;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push(`${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`);
  }
  return `M${pts.join('L')}Z`;
}

/**
 * Render an animated SVG drivetrain diagram showing chainrings + cassette.
 * Cogs rotate as if pedalling — front at cadence, rear faster by gear ratio.
 */
function renderDrivetrainSVG(container, chainrings, cassette, activeFront, activeRear, activeColor) {
  const W = 740, H = 400;
  const FRONT_CX = 530, FRONT_CY = 195;
  const REAR_CX = 190, REAR_CY = 195;

  // Full Dura-Ace 9200 groupset merged with ride data
  const FULL_CASSETTE = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34];
  const FULL_CHAINRINGS = [34, 50];
  const allRear = [...new Set([...cassette, ...FULL_CASSETTE])].sort((a, b) => a - b);
  const allFront = [...new Set([...chainrings, ...FULL_CHAINRINGS])].sort((a, b) => a - b);
  const rideRearSet = new Set(cassette);
  const rideFrontSet = new Set(chainrings);

  // Scale: pixels per tooth
  const SCALE = 2.8;

  // Animation: front pedal period (seconds), rear spins faster by gear ratio
  const FRONT_DUR = 3;   // ~20 RPM — gentle, easy to see teeth
  const gearRatio = activeFront / activeRear;
  const REAR_DUR = (FRONT_DUR / gearRatio).toFixed(3);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `style="width:100%;height:100%;display:block;">`;

  // ── Defs: filters and gradients ──
  svg += `<defs>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <radialGradient id="hubGrad"><stop offset="0%" stop-color="#555"/>
      <stop offset="100%" stop-color="#222"/></radialGradient>
  </defs>`;

  // ── Background ──
  svg += `<rect width="${W}" height="${H}" fill="#2a2a2a" rx="8"/>`;

  // ── Chain (static — represents the tangent path the chain follows) ──
  const activeFrontR = activeFront * SCALE;
  const activeRearR = activeRear * SCALE;
  // Top tangent
  svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY - activeFrontR}" ` +
    `x2="${REAR_CX}" y2="${REAR_CY - activeRearR}" ` +
    `stroke="#ff8800" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>`;
  // Bottom tangent
  svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY + activeFrontR}" ` +
    `x2="${REAR_CX}" y2="${REAR_CY + activeRearR}" ` +
    `stroke="#ff8800" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>`;
  // Arcs around cogs
  svg += `<path d="M${FRONT_CX},${FRONT_CY - activeFrontR} ` +
    `A${activeFrontR},${activeFrontR} 0 1,0 ${FRONT_CX},${FRONT_CY + activeFrontR}" ` +
    `fill="none" stroke="#ff8800" stroke-width="3" opacity="0.5"/>`;
  svg += `<path d="M${REAR_CX},${REAR_CY + activeRearR} ` +
    `A${activeRearR},${activeRearR} 0 1,0 ${REAR_CX},${REAR_CY - activeRearR}" ` +
    `fill="none" stroke="#ff8800" stroke-width="3" opacity="0.5"/>`;

  // ═══════════════════════════════════════════════════════════════════════════
  // ── REAR CASSETTE (rotating group) ──
  // ═══════════════════════════════════════════════════════════════════════════
  svg += `<g>`;
  svg += `<animateTransform attributeName="transform" type="rotate" ` +
    `from="0 ${REAR_CX} ${REAR_CY}" to="360 ${REAR_CX} ${REAR_CY}" ` +
    `dur="${REAR_DUR}s" repeatCount="indefinite"/>`;

  const rearSorted = [...allRear].sort((a, b) => b - a); // biggest first (drawn first = behind)
  rearSorted.forEach((teeth) => {
    const isActive = teeth === activeRear;
    const inRide = rideRearSet.has(teeth);
    const outerR = teeth * SCALE + SCALE;
    const innerR = teeth * SCALE - SCALE * 0.8;

    const fill = isActive ? activeColor : (inRide ? '#aaaaaa' : '#555555');
    const stroke = isActive ? activeColor : (inRide ? '#cccccc' : '#666666');
    const opacity = isActive ? 1 : (inRide ? 0.85 : 0.3);
    const strokeW = isActive ? 2 : 1;

    svg += `<path d="${gearPath(REAR_CX, REAR_CY, teeth, outerR, innerR)}" ` +
      `fill="${fill}" fill-opacity="${opacity * 0.35}" ` +
      `stroke="${stroke}" stroke-width="${strokeW}" opacity="${opacity}"` +
      `${isActive ? ' filter="url(#glow)"' : ''}/>`;

    // Hub hole
    const hubR = Math.max(5, outerR * 0.12);
    svg += `<circle cx="${REAR_CX}" cy="${REAR_CY}" r="${hubR}" fill="url(#hubGrad)" opacity="${opacity}"/>`;
  });
  svg += `</g>`; // end rear rotating group

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FRONT CHAINRINGS + CRANK (rotating group) ──
  // ═══════════════════════════════════════════════════════════════════════════
  svg += `<g>`;
  svg += `<animateTransform attributeName="transform" type="rotate" ` +
    `from="0 ${FRONT_CX} ${FRONT_CY}" to="360 ${FRONT_CX} ${FRONT_CY}" ` +
    `dur="${FRONT_DUR}s" repeatCount="indefinite"/>`;

  const frontSorted = [...allFront].sort((a, b) => b - a); // biggest first
  frontSorted.forEach((teeth) => {
    const isActive = teeth === activeFront;
    const inRide = rideFrontSet.has(teeth);
    const outerR = teeth * SCALE + SCALE;
    const innerR = teeth * SCALE - SCALE * 0.8;

    const fill = isActive ? activeColor : (inRide ? '#999999' : '#555555');
    const stroke = isActive ? activeColor : (inRide ? '#bbbbbb' : '#666666');
    const opacity = isActive ? 1 : (inRide ? 0.75 : 0.3);
    const strokeW = isActive ? 2.5 : 1;

    svg += `<path d="${gearPath(FRONT_CX, FRONT_CY, teeth, outerR, innerR)}" ` +
      `fill="${fill}" fill-opacity="${opacity * 0.3}" ` +
      `stroke="${stroke}" stroke-width="${strokeW}" opacity="${opacity}"` +
      `${isActive ? ' filter="url(#glow)"' : ''}/>`;

    // Spider arms (4-arm)
    for (let s = 0; s < 4; s++) {
      const angle = (s / 4) * Math.PI * 2 + Math.PI / 8;
      const armInner = Math.max(12, outerR * 0.15);
      const armOuter = innerR - 2;
      svg += `<line x1="${FRONT_CX + Math.cos(angle) * armInner}" y1="${FRONT_CY + Math.sin(angle) * armInner}" ` +
        `x2="${FRONT_CX + Math.cos(angle) * armOuter}" y2="${FRONT_CY + Math.sin(angle) * armOuter}" ` +
        `stroke="#555" stroke-width="3" stroke-linecap="round" opacity="${opacity * 0.6}"/>`;
    }

    // Hub hole
    const hubR = Math.max(8, outerR * 0.1);
    svg += `<circle cx="${FRONT_CX}" cy="${FRONT_CY}" r="${hubR}" fill="url(#hubGrad)" opacity="${opacity}"/>`;
  });

  // Crank arm (rotates with chainrings)
  const crankLen = 70;
  const crankAngle = Math.PI * 0.6;
  const crankEndX = FRONT_CX + Math.cos(crankAngle) * crankLen;
  const crankEndY = FRONT_CY + Math.sin(crankAngle) * crankLen;
  svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY}" x2="${crankEndX}" y2="${crankEndY}" ` +
    `stroke="#555" stroke-width="6" stroke-linecap="round"/>`;
  svg += `<circle cx="${crankEndX}" cy="${crankEndY}" r="4" fill="#666"/>`;

  svg += `</g>`; // end front rotating group

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STATIC OVERLAYS (axles, labels, callouts) ──
  // ═══════════════════════════════════════════════════════════════════════════

  // Axle dots (on top of spinning cogs)
  svg += `<circle cx="${FRONT_CX}" cy="${FRONT_CY}" r="5" fill="#444"/>`;
  svg += `<circle cx="${REAR_CX}" cy="${REAR_CY}" r="4" fill="#444"/>`;

  // ── Rear cassette labels (static column to the left) ──
  const rearForLabels = [...allRear].sort((a, b) => b - a);
  const labelX = REAR_CX - allRear[allRear.length - 1] * SCALE - SCALE * 4;
  const labelStartY = REAR_CY - (rearForLabels.length - 1) * 14 / 2;
  rearForLabels.forEach((teeth, idx) => {
    const isActive = teeth === activeRear;
    const inRide = rideRearSet.has(teeth);
    const y = labelStartY + idx * 14;
    const fill = isActive ? activeColor : (inRide ? '#cccccc' : '#666666');
    const fw = isActive ? 'bold' : 'normal';
    const sz = isActive ? 13 : 10;
    svg += `<text x="${labelX}" y="${y}" fill="${fill}" font-size="${sz}" ` +
      `font-weight="${fw}" font-family="system-ui,sans-serif" text-anchor="end">${teeth}T</text>`;
    if (isActive || inRide) {
      const cogOuterR = teeth * SCALE + SCALE;
      svg += `<line x1="${labelX + 4}" y1="${y - 3}" x2="${REAR_CX - cogOuterR}" y2="${REAR_CY}" ` +
        `stroke="${fill}" stroke-width="0.5" opacity="0.3"/>`;
    }
  });

  // ── Chainring labels (static, above the cogs) ──
  allFront.forEach((teeth) => {
    const isActive = teeth === activeFront;
    const inRide = rideFrontSet.has(teeth);
    const outerR = teeth * SCALE + SCALE;
    const fill = isActive ? activeColor : (inRide ? '#cccccc' : '#666666');
    const fw = isActive ? 'bold' : 'normal';
    const sz = isActive ? 16 : 12;
    svg += `<text x="${FRONT_CX}" y="${FRONT_CY - outerR - 8}" fill="${fill}" ` +
      `font-size="${sz}" font-weight="${fw}" font-family="system-ui,sans-serif" ` +
      `text-anchor="middle">${teeth}T</text>`;
  });

  // ── Section labels ──
  svg += `<text x="${FRONT_CX}" y="${H - 15}" fill="#888" font-size="13" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle" font-weight="600">CHAINRING</text>`;
  svg += `<text x="${REAR_CX}" y="${H - 15}" fill="#888" font-size="13" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle" font-weight="600">CASSETTE</text>`;

  // ── Gear ratio callout (centre top) ──
  const ratio = (activeFront / activeRear).toFixed(2);
  svg += `<text x="${W / 2}" y="28" fill="${activeColor}" font-size="18" ` +
    `font-weight="bold" font-family="system-ui,sans-serif" text-anchor="middle">` +
    `${activeFront}/${activeRear}</text>`;
  svg += `<text x="${W / 2}" y="46" fill="#999" font-size="12" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle">Ratio ${ratio}</text>`;

  svg += `</svg>`;
  container.innerHTML = svg;
}

// ─── Gear Popup Navigation State ────────────────────────────────────────────
let _gearNav = null;  // { gears: [{front,rear,color,ratio}], index, chainrings, cassette, keyHandler }

/**
 * Build sorted gear list from ride data (easiest → hardest by ratio).
 */
function _buildGearList() {
  if (!state.gearData) return [];
  const counts = new Map();
  state.gearData.forEach(g => {
    if (g?.front && g?.rear) {
      const key = `${g.front}/${g.rear}`;
      if (!counts.has(key)) counts.set(key, { front: g.front, rear: g.rear });
    }
  });
  return Array.from(counts.values())
    .map(g => ({
      front: g.front,
      rear: g.rear,
      ratio: g.front / g.rear,
      color: getGearColor(g)
    }))
    .sort((a, b) => a.ratio - b.ratio);  // easiest (lowest ratio) first
}

/**
 * Update the popup to show gear at the given index in _gearNav.gears.
 */
function _updateGearPopup(index) {
  if (!_gearNav) return;
  _gearNav.index = index;
  const g = _gearNav.gears[index];

  // Title
  document.getElementById('gear-popup-title').textContent =
    `Gear: ${g.front}/${g.rear}`;

  // Info bar
  const ratio = g.ratio.toFixed(2);
  const metres = g.ratio * 2.1 * Math.PI;
  const info = document.getElementById('gear-popup-info');
  info.innerHTML = `
    <span class="gpi-item">Ratio: <span class="gpi-value">${ratio}</span></span>
    <span class="gpi-item">Development: <span class="gpi-value">${metres.toFixed(1)} m</span></span>
    <span class="gpi-item">Front: <span class="gpi-value">${g.front}T</span></span>
    <span class="gpi-item">Rear: <span class="gpi-value">${g.rear}T</span></span>
  `;

  // SVG
  const container = document.getElementById('gear-popup-3d');
  renderDrivetrainSVG(container, _gearNav.chainrings, _gearNav.cassette, g.front, g.rear, g.color);

  // Nav bar
  _renderGearNavBar();
}

/**
 * Render the gear navigation bar — clickable chips for every gear in the ride.
 */
function _renderGearNavBar() {
  const nav = document.getElementById('gear-popup-nav');
  if (!nav || !_gearNav) return;

  nav.innerHTML = _gearNav.gears.map((g, i) => {
    const active = i === _gearNav.index;
    const cls = active ? 'gear-nav-chip active' : 'gear-nav-chip';
    const bg = active ? g.color : 'transparent';
    const border = g.color;
    const textColor = active ? '#fff' : g.color;
    return `<button class="${cls}" data-idx="${i}" ` +
      `style="background:${bg};border-color:${border};color:${textColor}" ` +
      `title="${g.front}/${g.rear} — ratio ${g.ratio.toFixed(2)}"` +
      `>${g.front}/${g.rear}</button>`;
  }).join('');

  // Arrow indicators
  const atStart = _gearNav.index === 0;
  const atEnd = _gearNav.index === _gearNav.gears.length - 1;
  const hint = nav.closest('.gear-popup-body')?.querySelector('.gear-popup-hint');
  if (hint) {
    if (atStart) hint.textContent = '→ harder gear';
    else if (atEnd) hint.textContent = '← easier gear';
    else hint.textContent = '← easier · harder →';
  }

  // Click handlers on chips
  nav.querySelectorAll('.gear-nav-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _updateGearPopup(Number(btn.dataset.idx));
    });
  });

  // Scroll active chip into view
  const activeChip = nav.querySelector('.gear-nav-chip.active');
  if (activeChip) activeChip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

/**
 * Open the gear visualization popup for a given front/rear combo.
 */
function showGearPopup(front, rear, color) {
  if (!state.gearData) return;

  // Build sorted gear list
  const gears = _buildGearList();
  if (gears.length === 0) return;

  // Collect chainring & cassette arrays for SVG
  const frontSet = new Set(), rearSet = new Set();
  state.gearData.forEach(g => {
    if (g?.front) frontSet.add(g.front);
    if (g?.rear) rearSet.add(g.rear);
  });
  const chainrings = [...frontSet].sort((a, b) => a - b);
  const cassette   = [...rearSet].sort((a, b) => a - b);

  // Find index of the clicked gear
  let startIdx = gears.findIndex(g => g.front === front && g.rear === rear);
  if (startIdx === -1) startIdx = 0;

  // Arrow key handler
  const keyHandler = (e) => {
    if (!_gearNav) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (_gearNav.index < _gearNav.gears.length - 1) {
        _updateGearPopup(_gearNav.index + 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (_gearNav.index > 0) {
        _updateGearPopup(_gearNav.index - 1);
      }
    } else if (e.key === 'Escape') {
      closeGearPopup();
    }
  };

  _gearNav = { gears, index: startIdx, chainrings, cassette, keyHandler };

  // Show popup
  document.getElementById('gear-popup').classList.remove('hidden');
  document.addEventListener('keydown', keyHandler);

  // Initial render
  _updateGearPopup(startIdx);
}

function closeGearPopup() {
  if (_gearNav?.keyHandler) {
    document.removeEventListener('keydown', _gearNav.keyHandler);
  }
  _gearNav = null;
  const container = document.getElementById('gear-popup-3d');
  if (container) container.innerHTML = '';
  const nav = document.getElementById('gear-popup-nav');
  if (nav) nav.innerHTML = '';
  document.getElementById('gear-popup').classList.add('hidden');
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
