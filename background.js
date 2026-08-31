/** Relays the Chrome command to the content script in the active tab. */
'use strict';

const COMMAND = 'spam-and-delete';
const MESSAGE = { type: 'ocs-spam-and-delete' };

function sendToTab(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  chrome.tabs.sendMessage(tab.id, MESSAGE, () => {
    // A non-Gmail tab has no receiver. Read lastError to suppress the expected
    // console warning without requesting a broad tab or host permission.
    void chrome.runtime.lastError;
  });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND) return;
  if (tab && typeof tab.id === 'number') {
    sendToTab(tab);
    return;
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    sendToTab(tabs && tabs[0]);
  });
});
