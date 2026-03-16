/**
 * Di2va — Gear Estimation from Cadence & Speed
 *
 * When no FIT file is available, estimates gear position from the rider's
 * cadence and speed using known chainring/cassette combinations.
 */

// Default gear configuration — user can override in extension settings
export const DEFAULT_CHAINRINGS = [34, 50];
export const DEFAULT_CASSETTE = [11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 28];
export const DEFAULT_WHEEL_CIRCUMFERENCE = 2.105; // metres (700×25c)

/**
 * Estimate gear for a single data point.
 *
 * @param {number} rpm — pedal cadence
 * @param {number} speedMs — speed in m/s
 * @param {{ chainrings: number[], cassette: number[], wheelCirc: number }} config
 * @returns {{ front: number|null, rear: number|null, gear_ratio: number|null, confidence: string, estimated: boolean }}
 */
export function estimateGearAtPoint(rpm, speedMs, config = {}) {
  const chainrings = config.chainrings || DEFAULT_CHAINRINGS;
  const cassette = config.cassette || DEFAULT_CASSETTE;
  const wheelCirc = config.wheelCirc || DEFAULT_WHEEL_CIRCUMFERENCE;

  if (rpm <= 0 || speedMs <= 0.5) {
    return { front: null, rear: null, gear_ratio: null, confidence: 'none', estimated: true };
  }

  // speed (m/s) = (cadence/60) × gear_ratio × wheel_circumference
  const actualRatio = (speedMs / (rpm / 60)) / wheelCirc;

  let bestMatch = null;
  let bestDiff = Infinity;

  for (const front of chainrings) {
    for (const rear of cassette) {
      const ratio = front / rear;
      const diff = Math.abs(ratio - actualRatio);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = { front, rear, ratio };
      }
    }
  }

  return {
    front: bestMatch?.front || null,
    rear: bestMatch?.rear || null,
    gear_ratio: bestMatch ? +bestMatch.ratio.toFixed(2) : null,
    confidence: bestDiff < 0.15 ? 'high' : bestDiff < 0.3 ? 'medium' : 'low',
    estimated: true
  };
}

/**
 * Estimate gears for an entire activity's streams.
 *
 * @param {number[]} cadence — RPM per data point
 * @param {number[]} velocitySmooth — speed m/s per data point
 * @param {object} config — optional { chainrings, cassette, wheelCirc }
 * @returns {Array<{ front, rear, gear_ratio, confidence, estimated }>}
 */
export function estimateGearsForActivity(cadence, velocitySmooth, config = {}) {
  const result = [];
  const len = Math.min(cadence.length, velocitySmooth.length);

  for (let i = 0; i < len; i++) {
    result.push(estimateGearAtPoint(cadence[i], velocitySmooth[i], config));
  }

  return result;
}
