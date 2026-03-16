/**
 * Di2va — Elevation Chart with Gear-Colored Segments, Shift Arrows & Drag-Zoom
 *
 * Ported from the Di2va web app (public/app.js).
 * Uses Chart.js for rendering, bundled by webpack.
 */

import { Chart, registerables } from 'chart.js';
import { getGearColor } from '../gear-colors.js';
import { distFromMetres, speedFromMs, elevFromMetres, distUnit, speedUnit, elevUnit } from './units.js';

Chart.register(...registerables);

// ─── Arrow Icons ────────────────────────────────────────────────────────────

const ARROW_SIZE = 18;

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
    ctx.moveTo(mid, pad);
    ctx.lineTo(size - pad, size - pad);
    ctx.lineTo(pad, size - pad);
  } else {
    ctx.moveTo(pad, pad);
    ctx.lineTo(size - pad, pad);
    ctx.lineTo(mid, size - pad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  return c;
}

const arrowUpRed = createArrowIcon('up', '#ef4444', ARROW_SIZE);
const arrowDownBlue = createArrowIcon('down', '#3b82f6', ARROW_SIZE);

// ─── Shift Detection ────────────────────────────────────────────────────────

function getShiftIndices(gears) {
  if (!gears || gears.length < 2) return [];

  const shifts = [];
  for (let i = 1; i < gears.length; i++) {
    if (!gears[i]?.rear || !gears[i - 1]?.rear) continue;
    const rearChanged = gears[i].rear !== gears[i - 1].rear;
    const frontChanged = gears[i].front !== gears[i - 1].front;
    if (rearChanged || frontChanged) {
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

// ─── Drag-to-Zoom Plugin ────────────────────────────────────────────────────

function createDragZoomPlugin(onZoomChange) {
  return {
    id: 'di2vaDragZoom',
    _startX: null,
    _endX: null,
    _isDragging: false,

    afterEvent(chart, args) {
      const event = args.event;
      const area = chart.chartArea;
      if (!area) return;

      const inArea = event.x >= area.left && event.x <= area.right &&
                     event.y >= area.top && event.y <= area.bottom;

      if (event.type === 'mousedown' && inArea) {
        this._isDragging = true;
        this._startX = event.x;
        this._endX = event.x;
      } else if (event.type === 'mousemove' && this._isDragging) {
        this._endX = Math.max(area.left, Math.min(event.x, area.right));
        chart.draw();
      } else if (event.type === 'mouseup' && this._isDragging) {
        this._isDragging = false;
        const left = Math.min(this._startX, this._endX);
        const right = Math.max(this._startX, this._endX);

        if (right - left > 10) {
          const startIdx = Math.round(chart.scales.x.getValueForPixel(left));
          const endIdx = Math.round(chart.scales.x.getValueForPixel(right));

          if (endIdx > startIdx + 1) {
            chart.options.scales.x.min = startIdx;
            chart.options.scales.x.max = endIdx;
            chart.update('none');
            if (onZoomChange) onZoomChange(startIdx, endIdx);
          }
        }
        this._startX = null;
        this._endX = null;
      }
    },

    afterDraw(chart) {
      if (!this._isDragging || this._startX == null || this._endX == null) return;

      const ctx = chart.ctx;
      const area = chart.chartArea;
      const left = Math.min(this._startX, this._endX);
      const right = Math.max(this._startX, this._endX);

      ctx.save();
      ctx.fillStyle = 'rgba(252, 76, 2, 0.15)';
      ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
      ctx.strokeStyle = '#fc4c02';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(left, area.top, right - left, area.bottom - area.top);
      ctx.restore();
    }
  };
}

// ─── Elevation Gradient Fill ────────────────────────────────────────────────

function createElevationGradient(ctx, isDark) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  if (isDark) {
    gradient.addColorStop(0, 'rgba(252, 76, 2, 0.2)');
    gradient.addColorStop(1, 'rgba(252, 76, 2, 0.01)');
  } else {
    gradient.addColorStop(0, 'rgba(252, 76, 2, 0.3)');
    gradient.addColorStop(1, 'rgba(252, 76, 2, 0.02)');
  }
  return gradient;
}

// ─── Hover Stats Update ─────────────────────────────────────────────────────

function updateHoverInfo(hoverEl, index, streams, gears) {
  if (!hoverEl) return;

  const g = gears?.[index];
  const dist = streams.distance?.[index];
  const elev = streams.altitude?.[index];
  const grad = streams.grade_smooth?.[index];
  const speed = streams.velocity_smooth?.[index];
  const cad = streams.cadence?.[index];
  const power = streams.watts?.[index];

  hoverEl.style.display = '';

  const distEl = hoverEl.querySelector('.di2va-hv-distance');
  if (distEl) distEl.textContent = dist != null ? `${distFromMetres(dist).toFixed(2)} ${distUnit()}` : '—';

  const gearEl = hoverEl.querySelector('.di2va-hv-gear');
  if (gearEl) {
    if (g?.front && g?.rear) {
      gearEl.textContent = `${g.front}×${g.rear}`;
      gearEl.style.color = getGearColor(g);
    } else {
      gearEl.textContent = '—';
      gearEl.style.color = '';
    }
  }

  const elevEl = hoverEl.querySelector('.di2va-hv-elevation');
  if (elevEl) elevEl.textContent = elev != null ? `${elevFromMetres(elev).toFixed(0)} ${elevUnit()}` : '—';

  const gradEl = hoverEl.querySelector('.di2va-hv-gradient');
  if (gradEl) gradEl.textContent = grad != null ? `${grad.toFixed(1)}%` : '—';

  const speedEl = hoverEl.querySelector('.di2va-hv-speed');
  if (speedEl) speedEl.textContent = speed != null ? `${speedFromMs(speed).toFixed(1)} ${speedUnit()}` : '—';

  const cadEl = hoverEl.querySelector('.di2va-hv-cadence');
  if (cadEl) cadEl.textContent = cad != null ? `${cad} rpm` : '—';

  const powerEl = hoverEl.querySelector('.di2va-hv-power');
  if (powerEl) powerEl.textContent = power != null ? `${power} W` : '—';
}

// ─── Main Render ────────────────────────────────────────────────────────────

/**
 * Render the gear-colored elevation chart with shift arrows and drag-to-zoom.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} streams — Strava streams
 * @param {Array} gears — per-point gear data
 * @param {boolean} isDark — dark mode flag
 * @param {HTMLElement} hoverEl — the hover info box element
 * @param {function} onZoomChange — callback(startIdx, endIdx) when zoomed, callback(null) when reset
 * @param {Array} [extraPlugins] — additional Chart.js plugins (e.g. replay position line)
 * @param {function} [onHoverIndex] — callback(index) when hovering a data point
 * @returns {{ chart: Chart, resetZoom: function }}
 */
export function renderElevationChart(canvas, streams, gears, isDark, hoverEl, onZoomChange, extraPlugins, onHoverIndex) {
  if (!streams.altitude || !streams.distance) return null;

  const ctx = canvas.getContext('2d');
  const distances = streams.distance.map(d => distFromMetres(d).toFixed(2));
  const elevations = streams.altitude.map(a => Math.round(elevFromMetres(a)));

  // Build per-segment gear colors
  const segmentColors = [];
  for (let i = 0; i < elevations.length; i++) {
    if (i > 0) {
      segmentColors.push(
        gears?.[i] ? getGearColor(gears[i]) : '#fc4c02'
      );
    }
  }

  // Build shift marker data
  const shiftIndices = getShiftIndices(gears);
  const shiftData = new Array(elevations.length).fill(null);
  const shiftDirection = new Array(elevations.length).fill(null);
  shiftIndices.forEach(s => {
    shiftData[s.index] = elevations[s.index];
    shiftDirection[s.index] = s.direction;
  });

  // Theme colors
  const textColor = isDark ? '#aaa' : '#8b8fa3';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const dragZoomPlugin = createDragZoomPlugin(onZoomChange);

  const datasets = [
    {
      label: 'Elevation (m)',
      data: elevations,
      backgroundColor: createElevationGradient(ctx, isDark),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: '#fc4c02',
      fill: true,
      tension: 0.2,
      segment: {
        borderColor: (c) => {
          if (segmentColors.length > 0 && c.p0DataIndex < segmentColors.length) {
            return segmentColors[c.p0DataIndex];
          }
          return '#fc4c02';
        }
      },
      yAxisID: 'y'
    }
  ];

  // Shift arrows
  if (shiftIndices.length > 0) {
    datasets.push({
      label: 'Gear Shifts',
      data: shiftData,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      borderWidth: 0,
      pointRadius: (c) => shiftData[c.dataIndex] !== null ? ARROW_SIZE / 2 : 0,
      pointHoverRadius: (c) => shiftData[c.dataIndex] !== null ? ARROW_SIZE / 2 + 2 : 0,
      pointStyle: (c) => {
        const dir = shiftDirection[c.dataIndex];
        if (dir === 'up') return arrowUpRed;
        if (dir === 'down') return arrowDownBlue;
        return false;
      },
      fill: false,
      showLine: false,
      yAxisID: 'y',
      order: -1
    });
  }

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: distances, datasets },
    plugins: [dragZoomPlugin, ...(extraPlugins || [])],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      events: ['mousemove', 'mouseout', 'mousedown', 'mouseup'],
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          display: true,
          title: { display: true, text: `Distance (${distUnit()})`, color: textColor },
          ticks: {
            color: textColor,
            maxTicksLimit: 20,
            callback: (val, idx) => {
              const step = Math.max(1, Math.floor(distances.length / 20));
              return idx % step === 0 ? distances[idx] : '';
            }
          },
          grid: { color: gridColor }
        },
        y: {
          display: true,
          title: { display: true, text: `Elevation (${elevUnit()})`, color: textColor },
          ticks: { color: textColor },
          grid: { color: gridColor }
        }
      },
      onHover: (event, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          updateHoverInfo(hoverEl, idx, streams, gears);
          if (onHoverIndex) onHoverIndex(idx);
        }
      }
    }
  });

  canvas.addEventListener('mouseout', () => {
    if (hoverEl) hoverEl.style.display = 'none';
  });

  function resetZoom() {
    delete chart.options.scales.x.min;
    delete chart.options.scales.x.max;
    chart.update('none');
    if (onZoomChange) onZoomChange(null);
  }

  return { chart, resetZoom };
}
