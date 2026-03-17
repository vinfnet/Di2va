/**
 * Di2va — AI Shifting Analysis Engine
 *
 * Scores shifting quality for a single ride based on:
 *  - Cadence efficiency (30%) — time in 80–100 RPM sweet spot
 *  - Gradient matching (25%) — gear ratio matches ideal for terrain
 *  - Cross-chain avoidance (15%) — penalizes big-big / small-small
 *  - Shift smoothness (15%) — penalizes rapid gear hunting
 *  - Anticipatory bonus (15%) — combined cadence + gradient quality
 */

import { DEFAULT_CHAINRINGS, DEFAULT_CASSETTE } from './gear-estimator.js';

const WHEEL_CIRC = 2.105;

export function buildGearTable(chainrings = DEFAULT_CHAINRINGS, cassette = DEFAULT_CASSETTE) {
  const gears = [];
  for (const front of chainrings) {
    for (const rear of cassette) {
      gears.push({ front, rear, ratio: front / rear });
    }
  }
  return gears.sort((a, b) => a.ratio - b.ratio);
}

export function isCrossChained(front, rear, chainrings = DEFAULT_CHAINRINGS, cassette = DEFAULT_CASSETTE) {
  const bigChainring = Math.max(...chainrings);
  const smallChainring = Math.min(...chainrings);
  const cogIndex = cassette.indexOf(rear);
  if (cogIndex === -1) return false;

  // Big-big: big chainring + 3 biggest cogs
  if (front === bigChainring && cogIndex >= cassette.length - 3) return true;
  // Small-small: small chainring + 3 smallest cogs
  if (front === smallChainring && cogIndex <= 2) return true;
  return false;
}

/**
 * For a given speed and gradient, find the optimal gear.
 */
export function optimalGearForConditions(speed, gradient, gearTable) {
  if (speed < 0.5) return null;

  // Adjust target cadence based on gradient
  let targetCadence;
  if (gradient > 8) targetCadence = 75;
  else if (gradient > 5) targetCadence = 80;
  else if (gradient > 2) targetCadence = 85;
  else if (gradient > -2) targetCadence = 90;
  else if (gradient > -5) targetCadence = 92;
  else targetCadence = 95;

  const idealRatio = speed / ((targetCadence / 60) * WHEEL_CIRC);

  let bestGear = null;
  let bestScore = Infinity;

  for (const g of gearTable) {
    const ratioDiff = Math.abs(g.ratio - idealRatio);
    const crossPenalty = isCrossChained(g.front, g.rear) ? 0.3 : 0;
    const score = ratioDiff + crossPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestGear = g;
    }
  }
  return bestGear;
}

/**
 * Analyse shifting quality for a single ride.
 *
 * @param {{ cadence: number[], velocity_smooth: number[], grade_smooth: number[], time: number[] }} streams
 * @param {Array<{ front: number|null, rear: number|null }>} gearData — per-point gear info
 * @returns {{ rating: number, overall: string, components: object, stats: object, optimalGears: Array }|null}
 */
export function analyseShifting(streams, gearData) {
  const gearTable = buildGearTable();
  const len = Math.min(
    streams.distance?.length || 0,
    streams.cadence?.length || 0,
    streams.velocity_smooth?.length || 0,
    gearData.length
  );

  if (len === 0) return null;

  let cadenceScore = 0, cadenceCount = 0;
  let crossChainCount = 0, totalGearPoints = 0;
  let gearHuntingPenalty = 0;
  let gradientMatchScore = 0, gradientMatchCount = 0;
  const optimalGears = [];
  const recentShifts = [];

  for (let i = 0; i < len; i++) {
    const g = gearData[i];
    const cadence = streams.cadence?.[i];
    const speed = streams.velocity_smooth?.[i] || 0;
    const gradient = streams.grade_smooth?.[i] || 0;
    const time = streams.time?.[i] || i;

    const optimal = optimalGearForConditions(speed, gradient, gearTable);
    optimalGears.push(optimal ? { front: optimal.front, rear: optimal.rear } : null);

    if (!g?.front || !g?.rear || speed < 0.5) continue;

    totalGearPoints++;

    // 1. Cadence scoring (30%)
    if (cadence && cadence > 0) {
      cadenceCount++;
      if (cadence >= 80 && cadence <= 100) cadenceScore += 1.0;
      else if (cadence >= 70 && cadence <= 110) cadenceScore += 0.6;
      else if (cadence >= 60 && cadence <= 120) cadenceScore += 0.3;
    }

    // 2. Cross-chain check (15%)
    if (isCrossChained(g.front, g.rear)) crossChainCount++;

    // 3. Gradient matching (25%)
    if (optimal) {
      const actualRatio = g.front / g.rear;
      const ratioDiff = Math.abs(actualRatio - optimal.ratio);
      if (ratioDiff < 0.2) gradientMatchScore += 1.0;
      else if (ratioDiff < 0.5) gradientMatchScore += 0.6;
      else if (ratioDiff < 1.0) gradientMatchScore += 0.3;
      gradientMatchCount++;
    }

    // 4. Gear hunting detection (15%)
    if (i > 0 && gearData[i - 1]?.front && gearData[i - 1]?.rear) {
      const prev = gearData[i - 1];
      if (g.front !== prev.front || g.rear !== prev.rear) {
        recentShifts.push(time);
        const windowStart = time - 15;
        const windowShifts = recentShifts.filter(t => t >= windowStart).length;
        if (windowShifts > 3) gearHuntingPenalty++;
      }
    }
  }

  if (totalGearPoints === 0) return null;

  const cadenceComponent = cadenceCount > 0 ? cadenceScore / cadenceCount : 0.5;
  const crossChainComponent = 1 - (crossChainCount / totalGearPoints);
  const gradientComponent = gradientMatchCount > 0 ? gradientMatchScore / gradientMatchCount : 0.5;
  const huntingComponent = Math.max(0, 1 - (gearHuntingPenalty / (totalGearPoints * 0.05)));

  const overall = (
    cadenceComponent * 0.30 +
    crossChainComponent * 0.15 +
    gradientComponent * 0.25 +
    huntingComponent * 0.15 +
    0.15 * ((cadenceComponent + gradientComponent) / 2)
  );

  const rating = Math.max(1, Math.min(5, Math.round(overall * 5)));

  return {
    rating,
    overall: (overall * 100).toFixed(0),
    components: {
      cadence: { score: (cadenceComponent * 100).toFixed(0), label: 'Cadence Efficiency' },
      crossChain: { score: (crossChainComponent * 100).toFixed(0), label: 'Cross-Chain Avoidance' },
      gradient: { score: (gradientComponent * 100).toFixed(0), label: 'Gradient Matching' },
      hunting: { score: (huntingComponent * 100).toFixed(0), label: 'Shift Smoothness' }
    },
    stats: {
      totalPoints: totalGearPoints,
      crossChainPercent: ((crossChainCount / totalGearPoints) * 100).toFixed(1),
      avgCadenceInRange: cadenceCount > 0 ? ((cadenceScore / cadenceCount) * 100).toFixed(0) : 'N/A'
    },
    optimalGears
  };
}

/**
 * Compute per-point optimal gears for an activity (for the overlay line).
 */
export function computeOptimalGears(cadence, velocitySmooth, gradeSmooth) {
  const gearTable = buildGearTable();
  const result = [];
  const len = cadence.length;

  for (let i = 0; i < len; i++) {
    const speed = velocitySmooth[i] || 0;
    const gradient = gradeSmooth?.[i] || 0;
    const optimal = optimalGearForConditions(speed, gradient, gearTable);
    result.push(optimal ? { front: optimal.front, rear: optimal.rear, ratio: +(optimal.front / optimal.rear).toFixed(2) } : null);
  }

  return result;
}
