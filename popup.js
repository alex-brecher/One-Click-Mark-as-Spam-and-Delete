/**
 * Options popup. Mirrors the settings schema used by content.js; every change
 * is written straight to chrome.storage.sync, which the content script watches.
 *
 * The service worker relays the registered Chrome command to the active Gmail
 * tab. The popup shows the user's current binding from chrome.commands.getAll.
 */

// Shared schema from settings.js, loaded first by popup.html.
const { DEFAULTS, BOOLEAN_KEYS: CHECKBOXES, normalizeSettings } = globalThis.OCS_SETTINGS;
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
  chrome.storage.sync.set(patch, () => {
    setStatus(chrome.runtime && chrome.runtime.lastError ? 'Could not save' : message);
  });
}

function render(stored) {
  for (const key of CHECKBOXES) {
    const el = document.getElementById(key);
    if (el) el.checked = stored[key];
  }
  for (const group of RADIO_GROUPS) {
    const value = stored[group];
    for (const input of document.querySelectorAll(`input[name="${group}"]`)) {
      input.checked = input.value === value;
    }
  }
}

function load() {
  // normalizeSettings also repairs bad stored values, so a radio group is
  // never left with nothing selected.
  chrome.storage.sync.get(DEFAULTS, (stored) => render(normalizeSettings(stored)));
}

function loadShortcut() {
  const shortcut = document.getElementById('shortcut');
  const state = document.getElementById('shortcutState');
  if (!shortcut || !chrome.commands || !chrome.commands.getAll) return;

  chrome.commands.getAll((commands) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      shortcut.textContent = 'Unavailable';
      if (state) state.textContent = 'Chrome could not read the shortcut.';
      return;
    }
    const command = (commands || []).find((item) => item.name === 'spam-and-delete');
    const binding = command && command.shortcut ? command.shortcut : '';
    shortcut.textContent = binding || 'Not assigned';
    if (state) {
      state.textContent = binding
        ? 'Use this shortcut while Gmail is focused.'
        : 'Assign a shortcut before you use the keyboard command.';
    }
  });
}

// Feedback goes to the hosted form, opened in a new tab. The extension itself
// sends nothing: the form page collects the report only when the user presses
// Send. The URL fragment is read by the page and never reaches a server.
const FEEDBACK_URL = 'https://feedback.netrition.com/';

function feedbackUrl(kind) {
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (_) {}
  const params = new URLSearchParams({ app: 'one-click-spam', k: kind });
  if (version) params.set('p', '/v' + version + '/popup');
  return FEEDBACK_URL + '#' + params.toString();
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
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus('Could not restore defaults');
          return;
        }
        render(DEFAULTS);
        setStatus('Defaults restored');
      });
    });
  }

  for (const [id, kind] of [['suggestIdea', 'idea'], ['reportProblem', 'bug']]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => chrome.tabs.create({ url: feedbackUrl(kind) }));
  }

  const customizeShortcut = document.getElementById('customizeShortcut');
  if (customizeShortcut) {
    customizeShortcut.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  loadShortcut();
  bind();
});
