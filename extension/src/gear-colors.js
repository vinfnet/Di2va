/**
 * Di2va — Gear Color Palette & Utilities
 *
 * Shared color mapping for gear visualizations.
 */

// Colors for rear cassette positions (easy/big cog → hard/small cog)
export const GEAR_COLORS = [
  '#ef4444', // 1  – Easiest (biggest cog)
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
  '#8b5cf6', // 12 – Hardest (smallest cog)
];

export const CHAINRING_COLORS = {
  small: '#f59e0b',
  big: '#3b82f6'
};

// Extended cassette lookup (covers 11-speed + 12-speed + gravel)
const CASSETTE_LOOKUP = [11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 28, 32, 34];

/**
 * Get the display color for a gear combination.
 * Based on the rear cassette position — bigger cog = warmer (easier), smaller = cooler (harder).
 *
 * @param {{ rear: number }} gearData
 * @returns {string} hex color
 */
export function getGearColor(gearData) {
  if (!gearData || !gearData.rear) return '#fc4c02'; // Strava orange fallback

  let rearIdx = CASSETTE_LOOKUP.indexOf(gearData.rear);
  if (rearIdx === -1) {
    rearIdx = CASSETTE_LOOKUP.findIndex(t => t >= gearData.rear);
    if (rearIdx === -1) rearIdx = CASSETTE_LOOKUP.length - 1;
  }

  const colorIdx = Math.min(rearIdx, GEAR_COLORS.length - 1);
  return GEAR_COLORS[GEAR_COLORS.length - 1 - colorIdx];
}

/**
 * Format a gear ratio as "50×17" string.
 */
export function formatGear(front, rear) {
  if (!front || !rear) return '—';
  return `${front}×${rear}`;
}

/**
 * Format a gear ratio number to one decimal place.
 */
export function formatRatio(ratio) {
  if (!ratio) return '—';
  return ratio.toFixed(2);
}
