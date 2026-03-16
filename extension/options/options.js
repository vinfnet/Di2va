/**
 * Di2va — Options Page Script
 * Persists drivetrain config to chrome.storage.local
 */

const DEFAULTS = {
  chainrings: '34,50',
  cassette: '11,12,13,14,15,17,19,21,24,28',
  wheelCirc: '2.105',
  autoExpand: true
};

document.addEventListener('DOMContentLoaded', () => {
  const chainringsEl = document.getElementById('chainrings');
  const cassetteEl = document.getElementById('cassette');
  const wheelCircEl = document.getElementById('wheelCirc');
  const autoExpandEl = document.getElementById('autoExpand');
  const savedEl = document.getElementById('saved');

  // Load saved settings
  chrome.storage.local.get('di2vaSettings', (result) => {
    const s = result.di2vaSettings || DEFAULTS;
    chainringsEl.value = s.chainrings || DEFAULTS.chainrings;
    cassetteEl.value = s.cassette || DEFAULTS.cassette;
    wheelCircEl.value = s.wheelCirc || DEFAULTS.wheelCirc;
    autoExpandEl.checked = s.autoExpand !== false;
  });

  // Save
  document.getElementById('save').addEventListener('click', () => {
    const settings = {
      chainrings: chainringsEl.value.trim(),
      cassette: cassetteEl.value.trim(),
      wheelCirc: wheelCircEl.value.trim(),
      autoExpand: autoExpandEl.checked
    };

    // Validate
    const chainrings = settings.chainrings.split(',').map(Number).filter(n => n > 0);
    const cassette = settings.cassette.split(',').map(Number).filter(n => n > 0);
    const wheelCirc = parseFloat(settings.wheelCirc);

    if (chainrings.length < 1 || chainrings.length > 3) {
      alert('Chainrings: enter 1-3 tooth counts separated by commas');
      return;
    }
    if (cassette.length < 5 || cassette.length > 15) {
      alert('Cassette: enter 5-15 tooth counts separated by commas');
      return;
    }
    if (isNaN(wheelCirc) || wheelCirc < 1 || wheelCirc > 3) {
      alert('Wheel circumference must be between 1.0 and 3.0 metres');
      return;
    }

    chrome.storage.local.set({ di2vaSettings: settings }, () => {
      savedEl.classList.add('visible');
      setTimeout(() => savedEl.classList.remove('visible'), 2000);
    });
  });
});
