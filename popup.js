const DEFAULTS = {
  alsoDelete: true,
  autoBlockSender: true,
  confirmEachClick: false,
};

const FIELDS = Object.keys(DEFAULTS);

function setStatus(text) {
  const status = document.getElementById('status');
  status.textContent = text;
  if (text) {
    setTimeout(() => {
      if (status.textContent === text) status.textContent = '';
    }, 1500);
  }
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    for (const key of FIELDS) {
      const el = document.getElementById(key);
      if (el) el.checked = Boolean(stored[key]);
    }
  });
}

function bind() {
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: el.checked }, () => setStatus('Saved'));
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  bind();
});
