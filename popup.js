/**
 * Options popup. Mirrors the settings schema used by content.js; every change
 * is written straight to chrome.storage.sync, which the content script watches.
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

  const shortcutLink = document.getElementById('shortcutSettings');
  if (shortcutLink) {
    shortcutLink.addEventListener('click', (e) => {
      e.preventDefault();
      // chrome:// URLs cannot be opened from an anchor; use the tabs API.
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }
}

/** Shows the shortcut the user actually has bound, not just the suggested one. */
function showShortcut() {
  const el = document.getElementById('shortcut');
  if (!el || !chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((commands) => {
    const command = (commands || []).find((c) => c.name === 'spam-and-delete');
    if (command && command.shortcut) el.textContent = command.shortcut;
    else el.textContent = 'Not set';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  bind();
  showShortcut();
});
