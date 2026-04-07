/**
 * Di2va — Drivetrain SVG Renderer
 *
 * Renders an animated SVG visualization of the chainrings, cassette, chain
 * and crank arm. Ported from the web app's renderDrivetrainSVG().
 */

import { getGearColor } from '../gear-colors.js';

// ─── SVG Gear Path Generator ─────────────────────────────────────────────

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

// ─── Main Renderer ──────────────────────────────────────────────────────

/**
 * Render the full drivetrain SVG into a container.
 *
 * @param {HTMLElement} container — target element (innerHTML will be replaced)
 * @param {number[]} chainrings — front chainring teeth from ride data
 * @param {number[]} cassette — rear cassette teeth from ride data
 * @param {number} activeFront — currently active front teeth
 * @param {number} activeRear — currently active rear teeth
 * @param {string} activeColor — highlight color for active gear
 * @param {object} [opts] — { frontAngle: number (static degrees), noChain: bool }
 */
export function renderDrivetrainSVG(container, chainrings, cassette, activeFront, activeRear, activeColor, opts) {
  const W = 740, H = 400;
  const FRONT_CX = 530, FRONT_CY = 195;
  const REAR_CX = 190, REAR_CY = 195;

  const FULL_CASSETTE = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34];
  const FULL_CHAINRINGS = [34, 50];
  const allRear = [...new Set([...cassette, ...FULL_CASSETTE])].sort((a, b) => a - b);
  const allFront = [...new Set([...chainrings, ...FULL_CHAINRINGS])].sort((a, b) => a - b);
  const rideRearSet = new Set(cassette);
  const rideFrontSet = new Set(chainrings);

  const SCALE = 2.8;

  const useStatic = opts && opts.frontAngle != null;
  const gearRatio = activeFront / activeRear;
  const FRONT_DUR = 3;
  const REAR_DUR = (FRONT_DUR / gearRatio).toFixed(3);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `style="width:100%;height:100%;display:block;">`;

  // Defs
  svg += `<defs>
    <filter id="di2va-glow"><feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <radialGradient id="di2va-hubGrad"><stop offset="0%" stop-color="#555"/>
      <stop offset="100%" stop-color="#222"/></radialGradient>
  </defs>`;

  // Background
  svg += `<rect width="${W}" height="${H}" fill="#2a2a2a" rx="8"/>`;

  // Chain
  const activeFrontR = activeFront * SCALE;
  const activeRearR = activeRear * SCALE;
  if (!(opts && opts.noChain)) {
    svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY - activeFrontR}" ` +
      `x2="${REAR_CX}" y2="${REAR_CY - activeRearR}" ` +
      `stroke="#ff8800" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>`;
    svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY + activeFrontR}" ` +
      `x2="${REAR_CX}" y2="${REAR_CY + activeRearR}" ` +
      `stroke="#ff8800" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>`;
    svg += `<path d="M${FRONT_CX},${FRONT_CY - activeFrontR} ` +
      `A${activeFrontR},${activeFrontR} 0 1,0 ${FRONT_CX},${FRONT_CY + activeFrontR}" ` +
      `fill="none" stroke="#ff8800" stroke-width="3" opacity="0.5"/>`;
    svg += `<path d="M${REAR_CX},${REAR_CY + activeRearR} ` +
      `A${activeRearR},${activeRearR} 0 1,0 ${REAR_CX},${REAR_CY - activeRearR}" ` +
      `fill="none" stroke="#ff8800" stroke-width="3" opacity="0.5"/>`;
  }

  // ═══ REAR CASSETTE ═══
  if (useStatic) {
    const ra = ((opts.frontAngle * gearRatio) % 360).toFixed(2);
    svg += `<g transform="rotate(${ra} ${REAR_CX} ${REAR_CY})">`;
  } else {
    svg += `<g>`;
    svg += `<animateTransform attributeName="transform" type="rotate" ` +
      `from="0 ${REAR_CX} ${REAR_CY}" to="360 ${REAR_CX} ${REAR_CY}" ` +
      `dur="${REAR_DUR}s" repeatCount="indefinite"/>`;
  }

  const rearSorted = [...allRear].sort((a, b) => b - a);
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
      `${isActive ? ' filter="url(#di2va-glow)"' : ''}/>`;
    const hubR = Math.max(5, outerR * 0.12);
    svg += `<circle cx="${REAR_CX}" cy="${REAR_CY}" r="${hubR}" fill="url(#di2va-hubGrad)" opacity="${opacity}"/>`;
  });
  svg += `</g>`;

  // ═══ FRONT CHAINRINGS + CRANK ═══
  if (useStatic) {
    const fa = (opts.frontAngle % 360).toFixed(2);
    svg += `<g transform="rotate(${fa} ${FRONT_CX} ${FRONT_CY})">`;
  } else {
    svg += `<g>`;
    svg += `<animateTransform attributeName="transform" type="rotate" ` +
      `from="0 ${FRONT_CX} ${FRONT_CY}" to="360 ${FRONT_CX} ${FRONT_CY}" ` +
      `dur="${FRONT_DUR}s" repeatCount="indefinite"/>`;
  }

  const frontSorted = [...allFront].sort((a, b) => b - a);
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
      `${isActive ? ' filter="url(#di2va-glow)"' : ''}/>`;

    // Spider arms (4-arm)
    for (let s = 0; s < 4; s++) {
      const angle = (s / 4) * Math.PI * 2 + Math.PI / 8;
      const armInner = Math.max(12, outerR * 0.15);
      const armOuter = innerR - 2;
      svg += `<line x1="${FRONT_CX + Math.cos(angle) * armInner}" y1="${FRONT_CY + Math.sin(angle) * armInner}" ` +
        `x2="${FRONT_CX + Math.cos(angle) * armOuter}" y2="${FRONT_CY + Math.sin(angle) * armOuter}" ` +
        `stroke="#555" stroke-width="3" stroke-linecap="round" opacity="${opacity * 0.6}"/>`;
    }
    const hubR = Math.max(8, outerR * 0.1);
    svg += `<circle cx="${FRONT_CX}" cy="${FRONT_CY}" r="${hubR}" fill="url(#di2va-hubGrad)" opacity="${opacity}"/>`;
  });

  // Crank arm
  const crankLen = 70;
  const crankAngle = Math.PI * 0.6;
  const crankEndX = FRONT_CX + Math.cos(crankAngle) * crankLen;
  const crankEndY = FRONT_CY + Math.sin(crankAngle) * crankLen;
  svg += `<line x1="${FRONT_CX}" y1="${FRONT_CY}" x2="${crankEndX}" y2="${crankEndY}" ` +
    `stroke="#555" stroke-width="6" stroke-linecap="round"/>`;
  svg += `<circle cx="${crankEndX}" cy="${crankEndY}" r="4" fill="#666"/>`;

  svg += `</g>`;

  // ═══ STATIC OVERLAYS ═══
  svg += `<circle cx="${FRONT_CX}" cy="${FRONT_CY}" r="5" fill="#444"/>`;
  svg += `<circle cx="${REAR_CX}" cy="${REAR_CY}" r="4" fill="#444"/>`;

  // Rear labels
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

  // Front labels
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

  // Section labels
  svg += `<text x="${FRONT_CX}" y="${H - 15}" fill="#888" font-size="13" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle" font-weight="600">CHAINRING</text>`;
  svg += `<text x="${REAR_CX}" y="${H - 15}" fill="#888" font-size="13" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle" font-weight="600">CASSETTE</text>`;

  // Gear ratio callout
  const ratio = (activeFront / activeRear).toFixed(2);
  svg += `<text x="${W / 2}" y="28" fill="${activeColor}" font-size="18" ` +
    `font-weight="bold" font-family="system-ui,sans-serif" text-anchor="middle">` +
    `${activeFront}/${activeRear}</text>`;
  svg += `<text x="${W / 2}" y="46" fill="#999" font-size="12" ` +
    `font-family="system-ui,sans-serif" text-anchor="middle">Ratio ${ratio}</text>`;

  svg += `</svg>`;
  container.replaceChildren(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
}

/**
 * Update rotation of an already-rendered drivetrain SVG (no full re-render).
 */
export function updateDrivetrainRotation(container, angle, front, rear) {
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;
  const groups = svgEl.querySelectorAll(':scope > g[transform]');
  const ratio = front / rear;
  const fa = (angle % 360).toFixed(2);
  const ra = ((angle * ratio) % 360).toFixed(2);
  if (groups[0]) groups[0].setAttribute('transform', `rotate(${ra} 190 195)`);
  if (groups[1]) groups[1].setAttribute('transform', `rotate(${fa} 530 195)`);
}
