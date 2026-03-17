/**
 * Di2va — Background Service Worker
 *
 * Handles messaging between content script and popup.
 * Stores per-tab gear data summary for popup display.
 */

// Cache of gear data summary by tab ID
const tabData = new Map();

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'gearDataReady' && sender.tab) {
    tabData.set(sender.tab.id, {
      activityId: message.activityId,
      source: message.source,
      rating: message.rating,
      overall: message.overall,
      shiftCount: message.shiftCount,
      gearCount: message.gearCount,
      timestamp: Date.now()
    });

    // Update badge
    const badgeText = message.rating ? `${message.rating}★` : '✓';
    chrome.action.setBadgeText({ text: badgeText, tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#fc4c02', tabId: sender.tab.id });
  }

  if (message.type === 'getTabData') {
    sendResponse(tabData.get(message.tabId) || null);
    return true; // async response
  }
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  tabData.delete(tabId);
});

// Clean up old entries periodically (> 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [tabId, data] of tabData) {
    if (data.timestamp < cutoff) tabData.delete(tabId);
  }
}, 600000);
