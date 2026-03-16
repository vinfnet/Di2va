/**
 * Di2va — Ride Playback Engine
 *
 * Manages play/pause/scrub through ride data, driving the drivetrain
 * animation and syncing with the elevation chart.
 */

import { getGearColor } from '../gear-colors.js';
import { renderDrivetrainSVG, updateDrivetrainRotation } from './drivetrain.js';
import { distFromMetres, speedFromMs, elevFromMetres, distUnit, speedUnit, elevUnit } from './units.js';
import { isCrossChained, optimalGearForConditions, buildGearTable } from '../shift-analyzer.js';

// ─── State ──────────────────────────────────────────────────────────────

let _replay = null;
const _gearTable = buildGearTable();

// ─── Helpers ────────────────────────────────────────────────────────────

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function removeDtOverlay(panel) {
  const dt = panel.querySelector('#di2va-drivetrain');
  if (!dt) return;
  dt.classList.remove('di2va-dt-inactive');
  const overlay = dt.querySelector('.di2va-dt-overlay');
  if (overlay) overlay.remove();
}

/** Detect bogus Di2 init values — real chainrings are ≤60T, cassette ≤42T */
function isValidGear(gear) {
  return gear?.front && gear?.rear && gear.front <= 60 && gear.rear <= 42;
}

function addDtOverlay(panel) {
  const dt = panel.querySelector('#di2va-drivetrain');
  if (!dt) return;
  // Don't add if already present
  if (dt.querySelector('.di2va-dt-overlay')) return;
  dt.classList.add('di2va-dt-inactive');
  const overlay = document.createElement('div');
  overlay.className = 'di2va-dt-overlay';
  overlay.textContent = 'Press \u25B6 Play to visualise gear position';
  dt.appendChild(overlay);
}

// ─── Initialise Replay Section ──────────────────────────────────────────

/**
 * Wire up the replay controls and render the initial drivetrain.
 *
 * @param {HTMLElement} panel — the di2va panel root
 * @param {object} streams — Strava stream data
 * @param {Array} gears — per-point gear data
 * @param {object} chartResult — { chart, resetZoom } from renderElevationChart
 */
export function initReplay(panel, streams, gears, chartResult) {
  if (!streams?.time || !gears?.length) return;

  // Build chainring/cassette sets from ride data (filter out bogus Di2 init values)
  const frontSet = new Set(), rearSet = new Set();
  gears.forEach(g => {
    if (isValidGear(g)) {
      frontSet.add(g.front);
      rearSet.add(g.rear);
    }
  });
  const chainrings = [...frontSet].sort((a, b) => a - b);
  const cassette = [...rearSet].sort((a, b) => a - b);

  // Render initial drivetrain (no chain)
  const dtContainer = panel.querySelector('#di2va-drivetrain');
  const first = gears.find(g => isValidGear(g));
  if (first && dtContainer) {
    renderDrivetrainSVG(dtContainer, chainrings, cassette,
      first.front, first.rear, getGearColor(first), { noChain: true });
  }

  // Add inactive overlay until user interacts
  addDtOverlay(panel);

  const maxIndex = Math.min(
    (streams.time?.length || 1) - 1,
    gears.length - 1
  );

  // Configure scrubber
  const scrubber = panel.querySelector('#di2va-scrubber');
  if (scrubber) scrubber.max = maxIndex;

  // Play button
  const playBtn = panel.querySelector('#di2va-play');
  if (playBtn) {
    playBtn.onclick = () => {
      removeDtOverlay(panel);
      if (_replay?.playing) {
        pauseReplay(panel);
      } else if (_replay) {
        resumeReplay(panel, streams, gears, chainrings, cassette, chartResult);
      } else {
        startReplay(panel, streams, gears, chainrings, cassette, chartResult, false);
      }
    };
  }

  // Scrubber input
  if (scrubber) {
    scrubber.oninput = function () {
      removeDtOverlay(panel);
      if (!_replay) {
        startReplay(panel, streams, gears, chainrings, cassette, chartResult, true);
      }
      _replay.index = parseInt(this.value);
      _replay.rideTime = streams.time[_replay.index] || 0;
      updateReplayFrame(panel, streams, gears, chainrings, cassette, chartResult);
    };
  }

  // Speed buttons
  const speedGroup = panel.querySelector('.di2va-speed-group');
  if (speedGroup) {
    speedGroup.onclick = (e) => {
      const btn = e.target.closest('.di2va-speed-btn');
      if (!btn) return;
      const speed = parseInt(btn.dataset.speed);
      if (_replay) _replay.speed = speed;
      speedGroup.querySelectorAll('.di2va-speed-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
    };
  }

  // Keyboard: spacebar to play/pause
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      if (playBtn) playBtn.click();
    }
  });

  // Start paused at beginning
  startReplay(panel, streams, gears, chainrings, cassette, chartResult, true);
}

// ─── Start / Pause / Resume ─────────────────────────────────────────────

function startReplay(panel, streams, gears, chainrings, cassette, chartResult, paused) {
  const maxIndex = Math.min(streams.time.length, gears.length) - 1;

  const activeSpeedBtn = panel.querySelector('.di2va-speed-btn.active');
  const speed = activeSpeedBtn ? parseInt(activeSpeedBtn.dataset.speed) : 1;

  // Find first point with valid cadence data to skip warm-up
  let startIndex = 0;
  if (!paused) {
    for (let i = 0; i < maxIndex; i++) {
      if (streams.cadence?.[i] > 0 && isValidGear(gears[i])) {
        startIndex = i;
        break;
      }
    }
  }

  _replay = {
    playing: !paused,
    speed,
    frameId: null,
    index: startIndex,
    maxIndex,
    lastTimestamp: null,
    rideTime: streams.time[startIndex] || 0,
    rotationAngle: 0,
    lastFront: null,
    lastRear: null
  };

  const playBtn = panel.querySelector('#di2va-play');
  if (playBtn) playBtn.textContent = paused ? '▶ Play' : '⏸ Pause';

  if (!paused) {
    _replay.frameId = requestAnimationFrame((ts) =>
      replayTick(ts, panel, streams, gears, chainrings, cassette, chartResult)
    );
  }

  updateReplayFrame(panel, streams, gears, chainrings, cassette, chartResult);
}

function pauseReplay(panel) {
  if (!_replay) return;
  _replay.playing = false;
  if (_replay.frameId) {
    cancelAnimationFrame(_replay.frameId);
    _replay.frameId = null;
  }
  const playBtn = panel.querySelector('#di2va-play');
  if (playBtn) playBtn.textContent = '▶ Play';
}

function resumeReplay(panel, streams, gears, chainrings, cassette, chartResult) {
  if (!_replay) return;
  _replay.playing = true;
  _replay.lastTimestamp = null;
  _replay.rideTime = streams.time[_replay.index] || 0;
  _replay.frameId = requestAnimationFrame((ts) =>
    replayTick(ts, panel, streams, gears, chainrings, cassette, chartResult)
  );
  const playBtn = panel.querySelector('#di2va-play');
  if (playBtn) playBtn.textContent = '⏸ Pause';
}

// ─── Animation Loop ─────────────────────────────────────────────────────

function replayTick(timestamp, panel, streams, gears, chainrings, cassette, chartResult) {
  if (!_replay || !_replay.playing) return;

  if (_replay.lastTimestamp === null) {
    _replay.lastTimestamp = timestamp;
    _replay.frameId = requestAnimationFrame((ts) =>
      replayTick(ts, panel, streams, gears, chainrings, cassette, chartResult)
    );
    return;
  }

  const elapsed = (timestamp - _replay.lastTimestamp) / 1000;
  _replay.lastTimestamp = timestamp;

  // Accumulate ride time
  _replay.rideTime += elapsed * _replay.speed;

  // Accumulate rotation from cadence
  const cadenceNow = streams.cadence?.[_replay.index];
  if (cadenceNow > 0) {
    _replay.rotationAngle += (cadenceNow / 60) * 360 * elapsed * _replay.speed;
  }

  // Advance index
  let newIndex = _replay.index;
  while (newIndex < _replay.maxIndex &&
         (streams.time[newIndex + 1] || Infinity) <= _replay.rideTime) {
    newIndex++;
  }

  if (newIndex !== _replay.index) {
    _replay.index = newIndex;
    updateReplayFrame(panel, streams, gears, chainrings, cassette, chartResult);
  } else {
    // Just update rotation
    const dtContainer = panel.querySelector('#di2va-drivetrain');
    if (dtContainer && _replay.lastFront && _replay.lastRear) {
      updateDrivetrainRotation(dtContainer, _replay.rotationAngle, _replay.lastFront, _replay.lastRear);
    }
  }

  if (_replay.index >= _replay.maxIndex) {
    _replay.playing = false;
    const playBtn = panel.querySelector('#di2va-play');
    if (playBtn) playBtn.textContent = '▶ Play';
    return;
  }

  _replay.frameId = requestAnimationFrame((ts) =>
    replayTick(ts, panel, streams, gears, chainrings, cassette, chartResult)
  );
}

// ─── Frame Update ───────────────────────────────────────────────────────

function updateReplayFrame(panel, streams, gears, chainrings, cassette, chartResult) {
  if (!_replay) return;
  const i = _replay.index;
  const gear = gears[i];

  // Scrubber + time
  const scrubber = panel.querySelector('#di2va-scrubber');
  if (scrubber) scrubber.value = i;

  const curSec = streams.time[i] || 0;
  const totSec = streams.time[_replay.maxIndex] || 0;
  const timeEl = panel.querySelector('#di2va-replay-time');
  if (timeEl) timeEl.textContent = `${fmtTime(curSec)} / ${fmtTime(totSec)}`;

  // Drivetrain
  const front = gear?.front || chainrings[chainrings.length - 1] || 50;
  const rear = gear?.rear || cassette[0] || 11;
  const color = gear?.front ? getGearColor(gear) : '#555';
  const dtContainer = panel.querySelector('#di2va-drivetrain');

  if (dtContainer) {
    if (front !== _replay.lastFront || rear !== _replay.lastRear) {
      renderDrivetrainSVG(dtContainer, chainrings, cassette,
        front, rear, color, { frontAngle: _replay.rotationAngle });
      _replay.lastFront = front;
      _replay.lastRear = rear;
    } else {
      updateDrivetrainRotation(dtContainer, _replay.rotationAngle, front, rear);
    }
  }

  // Update replay stats
  updateReplayStats(panel, i, streams, gear);

  // Update AI analysis box
  updateReplayAI(panel, i, streams, gear);

  // Sync elevation chart position indicator
  if (chartResult?.chart) {
    chartResult.chart._replayIndex = i;
    chartResult.chart.draw();
  }
}

// ─── Replay Stats ───────────────────────────────────────────────────────

function updateReplayStats(panel, index, streams, gear) {
  const el = panel.querySelector('#di2va-replay-stats');
  if (!el) return;

  const dist = streams.distance?.[index];
  const elev = streams.altitude?.[index];
  const grad = streams.grade_smooth?.[index];
  const speed = streams.velocity_smooth?.[index];
  const cad = streams.cadence?.[index];
  const power = streams.watts?.[index];

  const gearText = isValidGear(gear)
    ? `<span style="color:${getGearColor(gear)}">${gear.front}×${gear.rear}</span>`
    : '—';

  el.innerHTML = `
    <span class="di2va-rs-item">${gearText}</span>
    <span class="di2va-rs-item">${dist != null ? `${distFromMetres(dist).toFixed(2)} ${distUnit()}` : '—'}</span>
    <span class="di2va-rs-item">${elev != null ? `${elevFromMetres(elev).toFixed(0)} ${elevUnit()}` : '—'}</span>
    <span class="di2va-rs-item">${grad != null ? `${grad.toFixed(1)}%` : '—'}</span>
    <span class="di2va-rs-item">${speed != null ? `${speedFromMs(speed).toFixed(1)} ${speedUnit()}` : '—'}</span>
    <span class="di2va-rs-item">${cad != null ? `${cad} rpm` : '—'}</span>
    <span class="di2va-rs-item">${power != null ? `${power} W` : '—'}</span>
  `;
}

/**
 * Update drivetrain on chart hover (not during playback).
 */
export function updateDrivetrainOnHover(panel, gears, streams, index) {
  if (_replay?.playing) return;
  const gear = gears?.[index];
  if (!isValidGear(gear)) return;

  // Don't update drivetrain until user has started playback
  if (!_replay) return;

  // Derive chainrings/cassette
  const frontSet = new Set(), rearSet = new Set();
  gears.forEach(g => {
    if (isValidGear(g)) {
      frontSet.add(g.front);
      rearSet.add(g.rear);
    }
  });

  const dtContainer = panel.querySelector('#di2va-drivetrain');
  if (!dtContainer) return;

  removeDtOverlay(panel);
  renderDrivetrainSVG(dtContainer,
    [...frontSet].sort((a, b) => a - b),
    [...rearSet].sort((a, b) => a - b),
    gear.front, gear.rear, getGearColor(gear)
  );

  // Also update AI for hover point
  updateReplayAI(panel, index, streams, gear);
}

// ─── AI Shifting Analysis ───────────────────────────────────────────────

function updateReplayAI(panel, index, streams, gear) {
  const rowsEl = panel.querySelector('#di2va-ai-rows');
  const sugEl = panel.querySelector('#di2va-ai-suggestion');
  if (!rowsEl) return;

  const speed = streams?.velocity_smooth?.[index];
  const grad = streams?.grade_smooth?.[index];
  const cad = streams?.cadence?.[index];

  // Compute optimal gear for current conditions
  const optimal = (speed != null && grad != null)
    ? optimalGearForConditions(speed, grad, _gearTable)
    : null;

  // Checks — also reject bogus Di2 init values (e.g. 255T chainring)
  const validGear = isValidGear(gear);
  const hasGear = validGear;

  // 1. Cadence efficiency: 80-100 is ideal
  const cadOk = cad != null && cad >= 80 && cad <= 100;
  const cadWarn = cad != null && (cad < 80 || cad > 100);

  // 2. Cross-chain avoidance
  const crossChained = hasGear ? isCrossChained(gear.front, gear.rear) : false;

  // 3. Gradient matching: is current gear close to optimal?
  let gearMatch = false;
  if (hasGear && optimal) {
    gearMatch = gear.front === optimal.front && gear.rear === optimal.rear;
  }

  // 4. Gear ratio closeness (within ~10%)
  let ratioClose = false;
  if (hasGear && optimal) {
    const currentRatio = gear.front / gear.rear;
    const optRatio = optimal.front / optimal.rear;
    ratioClose = Math.abs(currentRatio - optRatio) / optRatio < 0.10;
  }

  const tick = '<span class="di2va-ai-tick">✓</span>';
  const cross = '<span class="di2va-ai-cross">✗</span>';
  const info = '<span class="di2va-ai-info">—</span>';

  let rows = '';

  // Detect waiting for data (bogus gear values from Di2 init)
  if (!validGear && gear?.front) {
    rows += `<div class="di2va-ai-row">${info}
      <span class="di2va-ai-label">Status</span>
      <span class="di2va-ai-detail">Waiting for data…</span>
    </div>`;
    rowsEl.innerHTML = rows;
    if (sugEl) sugEl.innerHTML = '';
    return;
  }

  // Detect coasting or stopped
  const isCoasting = speed > 0 && (!cad || cad === 0);
  const isStopped = (!speed || speed === 0) && (!cad || cad === 0);

  // Cadence
  if (isStopped) {
    rows += `<div class="di2va-ai-row">${info}
      <span class="di2va-ai-label">Cadence</span>
      <span class="di2va-ai-detail">Stopped</span>
    </div>`;
  } else if (isCoasting) {
    rows += `<div class="di2va-ai-row">${info}
      <span class="di2va-ai-label">Cadence</span>
      <span class="di2va-ai-detail">Coasting</span>
    </div>`;
  } else if (cad != null) {
    rows += `<div class="di2va-ai-row">${cadOk ? tick : cross}
      <span class="di2va-ai-label">Cadence</span>
      <span class="di2va-ai-detail">${cad} rpm ${cadOk ? '(optimal)' : cad < 80 ? '(too low)' : '(too high)'}</span>
    </div>`;
  }

  // Cross-chain
  if (hasGear) {
    rows += `<div class="di2va-ai-row">${crossChained ? cross : tick}
      <span class="di2va-ai-label">Cross-chain</span>
      <span class="di2va-ai-detail">${crossChained ? 'cross-chained' : 'good chain line'}</span>
    </div>`;
  }

  // Gradient match
  if (hasGear && optimal) {
    rows += `<div class="di2va-ai-row">${(gearMatch || ratioClose) ? tick : cross}
      <span class="di2va-ai-label">Gradient match</span>
      <span class="di2va-ai-detail">${gearMatch ? 'optimal gear' : ratioClose ? 'close to optimal' : 'sub-optimal'}</span>
    </div>`;
  }

  // Current gear
  if (hasGear) {
    rows += `<div class="di2va-ai-row">${tick}
      <span class="di2va-ai-label">Current gear</span>
      <span class="di2va-ai-detail" style="color:${getGearColor(gear)}">${gear.front}×${gear.rear}</span>
    </div>`;
  }

  rowsEl.innerHTML = rows;

  // Suggestion
  if (sugEl) {
    if (!hasGear || speed == null) {
      sugEl.innerHTML = '';
    } else if (gearMatch || ratioClose) {
      sugEl.innerHTML = '<span class="di2va-ai-ok">👍 Good gear choice</span>';
    } else if (optimal) {
      let suggestion = `Try <strong>${optimal.front}×${optimal.rear}</strong>`;
      // Suggest cadence target based on gradient
      let targetCad;
      if (grad > 8) targetCad = '~75';
      else if (grad > 5) targetCad = '~80';
      else if (grad > 2) targetCad = '~85';
      else if (grad > -2) targetCad = '~90';
      else targetCad = '~92';
      suggestion += ` at ${targetCad} rpm`;
      if (crossChained) suggestion += ' (avoids cross-chain)';
      sugEl.innerHTML = `<span class="di2va-ai-suggest">💡 ${suggestion}</span>`;
    } else {
      sugEl.innerHTML = '';
    }
  }
}

// ─── Zoom ↔ Replay Sync ────────────────────────────────────────────────

/**
 * Called when the elevation chart is zoomed. Constrains the scrubber
 * and jumps playback to the start of the zoomed section.
 */
export function syncReplayToZoom(panel, streams, gears, startIdx, endIdx) {
  const scrubber = panel.querySelector('#di2va-scrubber');

  if (startIdx == null) {
    // Reset — restore full range
    if (_replay) {
      _replay.zoomStart = null;
      _replay.zoomEnd = null;
      _replay.maxIndex = Math.min(streams.time.length, gears.length) - 1;
    }
    if (scrubber) {
      scrubber.min = 0;
      scrubber.max = Math.min(streams.time.length, gears.length) - 1;
    }
    return;
  }

  // Pause any running animation and show overlay
  if (_replay?.playing) {
    pauseReplay(panel);
  }
  addDtOverlay(panel);

  // Clear AI analysis box
  const rowsEl = panel.querySelector('#di2va-ai-rows');
  const sugEl = panel.querySelector('#di2va-ai-suggestion');
  if (rowsEl) rowsEl.innerHTML = '';
  if (sugEl) sugEl.innerHTML = '';

  // Constrain scrubber to zoomed range
  if (scrubber) {
    scrubber.min = startIdx;
    scrubber.max = endIdx;
    scrubber.value = startIdx;
  }

  if (_replay) {
    _replay.zoomStart = startIdx;
    _replay.zoomEnd = endIdx;
    _replay.maxIndex = endIdx;
    _replay.index = startIdx;
    _replay.rideTime = streams.time[startIdx] || 0;
  }
}

/**
 * Get the replay position line plugin for Chart.js.
 */
export const replayPosPlugin = {
  id: 'di2vaReplayPos',
  afterDatasetsDraw(chart) {
    const idx = chart._replayIndex;
    if (idx == null || idx < 0) return;
    const meta = chart.getDatasetMeta(0);
    const pt = meta.data[idx];
    if (!pt) return;
    const { ctx, chartArea: { top, bottom } } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pt.x, top);
    ctx.lineTo(pt.x, bottom);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff3333';
    ctx.shadowColor = '#ff3333';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3333';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
};
