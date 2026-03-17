/**
 * Di2va — Unit Detection & Conversion
 *
 * Detects the Strava user's measurement preference (metric / imperial)
 * by injecting a tiny script into the page context to read Strava globals,
 * falling back to page scraping.
 */

const KM_TO_MI = 0.621371;
const M_TO_FT  = 3.28084;

let _imperial = null; // cached after first detection

/**
 * Detect whether the Strava user prefers imperial units.
 * Uses page context bridge to read Strava.I18n or currentAthlete,
 * falls back to scraping page text for 'mi' vs 'km'.
 */
export function detectUnits() {
  if (_imperial !== null) return;

  // Try to read from the injected bridge (set by injectUnitDetector)
  const flag = document.documentElement.dataset.di2vaUnits;
  if (flag === 'imperial') { _imperial = true; return; }
  if (flag === 'metric')   { _imperial = false; return; }

  // Fallback: scrape visible stat labels for 'mi' vs 'km'
  const statsText = document.querySelector('.inline-stats, .activity-stats, [class*="Stat"]')?.textContent || '';
  if (/\bmi\b/.test(statsText)) { _imperial = true; return; }
  if (/\bkm\b/.test(statsText)) { _imperial = false; return; }

  _imperial = false; // default metric
}

/**
 * Inject a tiny script into the Strava page context to read globals.
 * Must be called early, before detectUnits().
 */
export function injectUnitDetector() {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      try {
        var u = 'metric';
        if (typeof Strava !== 'undefined' && Strava.I18n && Strava.I18n.DistanceFormatter) {
          u = new Strava.I18n.DistanceFormatter().unitSystem || 'metric';
        } else if (typeof currentAthlete !== 'undefined' && currentAthlete.get) {
          var p = currentAthlete.get('measurement_preference');
          u = (p === 'feet') ? 'imperial' : 'metric';
        }
        document.documentElement.dataset.di2vaUnits = u;
      } catch(e) {
        document.documentElement.dataset.di2vaUnits = 'metric';
      }
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

export function isImperial() {
  if (_imperial === null) detectUnits();
  return _imperial;
}

export function distFromMetres(m) {
  return isImperial() ? (m / 1000) * KM_TO_MI : m / 1000;
}

export function speedFromMs(ms) {
  return isImperial() ? ms * 3.6 * KM_TO_MI : ms * 3.6;
}

export function elevFromMetres(m) {
  return isImperial() ? m * M_TO_FT : m;
}

export function distUnit()  { return isImperial() ? 'mi' : 'km'; }
export function speedUnit() { return isImperial() ? 'mph' : 'km/h'; }
export function elevUnit()  { return isImperial() ? 'ft' : 'm'; }
