/**
 * Options popup. Mirrors the settings schema used by content.js; every change
 * is written straight to chrome.storage.sync, which the content script watches.
 *
 * The keyboard shortcut is a fixed in-page default (Ctrl/Cmd+Shift+S).  Rebound
 * Chromium commands are NOT relayed (the extension has no service worker and no
 * broad host permissions), so the popup presents the honest binding rather than
 * the dynamically-resolved one from chrome.commands.getAll.
 */

const DEFAULTS = {
  alsoDelete: true,
  autoBlockSender: true,
  confirmEachClick: false,
  widgetStyle: 'gmail-icon',
  placementMode: 'toolbar',
  fabPosition: null,
};

const CHECKBOXES = ['alsoDelete', 'autoBlockSender', 'confirmEachClick'];
const RADIO_GROUPS = ['placementMode', 'widgetStyle'];

function setStatus(text) {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = text;
  if (text) {
    setTimeout(() => {
      if (status.textContent === text) status.textContent = '';
    }, 1500);
  }
}

function save(patch, message = 'Saved') {
  chrome.storage.sync.set(patch, () => setStatus(message));
}

function render(stored) {
  for (const key of CHECKBOXES) {
    const el = document.getElementById(key);
    if (el) el.checked = Boolean(stored[key]);
  }
  for (const group of RADIO_GROUPS) {
    const value = stored[group] != null ? stored[group] : DEFAULTS[group];
    for (const input of document.querySelectorAll(`input[name="${group}"]`)) {
      input.checked = input.value === value;
    }
  }
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (stored) => render({ ...DEFAULTS, ...stored }));
}

function bind() {
  for (const key of CHECKBOXES) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', () => save({ [key]: el.checked }));
  }

  for (const group of RADIO_GROUPS) {
    for (const input of document.querySelectorAll(`input[name="${group}"]`)) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        // A new placement or style invalidates any saved drag position.
        save({ [group]: input.value, fabPosition: null });
      });
    }
  }

  const reset = document.getElementById('resetDefaults');
  if (reset) {
    reset.addEventListener('click', () => {
      chrome.storage.sync.set({ ...DEFAULTS }, () => {
        render(DEFAULTS);
        setStatus('Defaults restored');
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  bind();
});