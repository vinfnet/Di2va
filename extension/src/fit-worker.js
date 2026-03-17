/**
 * Di2va — FIT File Web Worker
 *
 * Runs fit-file-parser in a dedicated worker thread to avoid
 * blocking the main content script on Strava pages.
 *
 * Protocol:
 *   Main → Worker:  { type: 'parse', buffer: ArrayBuffer }
 *   Worker → Main:  { type: 'result', data: { gear_changes, records, … } }
 *   Worker → Main:  { type: 'error', message: string }
 */

// In the built extension, fit-file-parser will be bundled into this file
// by webpack. For development, we import it directly.
import FitParser from 'fit-file-parser';
import { extractDi2Data } from './gear-parser.js';

self.onmessage = function (e) {
  const { type, buffer } = e.data;

  if (type !== 'parse') {
    self.postMessage({ type: 'error', message: `Unknown message type: ${type}` });
    return;
  }

  try {
    const fitParser = new (FitParser.default || FitParser)({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'both'
    });

    // Convert ArrayBuffer to Buffer-like for the parser
    const uint8 = new Uint8Array(buffer);

    fitParser.parse(uint8, (error, data) => {
      if (error) {
        self.postMessage({ type: 'error', message: `FIT parse error: ${error}` });
        return;
      }

      const result = extractDi2Data(data);
      self.postMessage({ type: 'result', data: result });
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || 'Unknown parsing error' });
  }
};
