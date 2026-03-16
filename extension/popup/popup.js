/**
 * Di2va — Popup Script
 * Fetches current tab's gear data summary from background and displays it.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const noData = document.getElementById('no-data');
  const card = document.getElementById('activity-card');

  // Open options page
  document.getElementById('options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // Request data from background
    const data = await chrome.runtime.sendMessage({ type: 'getTabData', tabId: tab.id });
    if (!data) return;

    noData.style.display = 'none';
    card.style.display = '';

    // Source
    const sourceEl = document.getElementById('source');
    sourceEl.textContent = data.source === 'fit' ? 'FIT (Di2)' : 'Estimated';
    sourceEl.className = `source-badge source-${data.source}`;

    // Rating
    const ratingEl = document.getElementById('rating');
    if (data.rating) {
      ratingEl.textContent = '★'.repeat(data.rating) + '☆'.repeat(5 - data.rating);
    } else {
      ratingEl.textContent = '—';
    }

    // Overall
    document.getElementById('overall').textContent = data.overall ? `${data.overall}%` : '—';

    // Shifts
    document.getElementById('shifts').textContent = data.shiftCount ?? '—';

    // Gears
    document.getElementById('gears').textContent = data.gearCount ?? '—';

  } catch (err) {
    console.error('[Di2va popup]', err);
  }
});
