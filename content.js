(function () {
  'use strict';

  const FAB_ID = 'ocs-fab';
  const TOAST_CLASS = 'ocs-toast';

  const DEFAULTS = {
    alsoDelete: true,
    confirmEachClick: false,
  };

  let settings = { ...DEFAULTS };

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        if (stored) settings = { ...DEFAULTS, ...stored };
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const k of Object.keys(changes)) {
          settings[k] = changes[k].newValue;
        }
      });
    } catch (e) {
      // chrome.storage may be unavailable in subframes; ignore.
    }
  }

  function showToast(message, type = 'info') {
    const existing = document.querySelector('.' + TOAST_CLASS);
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `${TOAST_CLASS} ${TOAST_CLASS}--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('ocs-toast--visible'));
    setTimeout(() => {
      toast.classList.remove('ocs-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 2400);
  }

  function isUsable(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.pointerEvents === 'none') return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function findFirstUsable(selectors, root = document) {
    for (const sel of selectors) {
      const matches = root.querySelectorAll(sel);
      for (const el of matches) {
        if (isUsable(el)) return el;
      }
    }
    return null;
  }

  // Gmail's "Report spam" toolbar control — try both ARIA labels and Gmail's
  // internal action codes. Works in inbox list (when rows are checked) and in
  // the open-email view.
  function findReportSpamButton() {
    return findFirstUsable([
      '[aria-label="Report spam"]',
      '[data-tooltip="Report spam"]',
      '[aria-label^="Report spam"]',
      '[data-tooltip^="Report spam"]',
      'div[act="9"]',
      'div[act="55"]',
    ]);
  }

  // Gmail's "Delete" (trash) toolbar control — explicitly avoid "Delete forever",
  // "Delete draft", etc. by matching with an exact-equals selector first.
  function findDeleteButton() {
    const exact = findFirstUsable([
      '[aria-label="Delete"]',
      '[data-tooltip="Delete"]',
    ]);
    if (exact) return exact;
    return findFirstUsable(['div[act="10"]']);
  }

  function nativeClick(el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (_) { return false; }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function spamAndDelete() {
    const spamBtn = findReportSpamButton();
    if (!spamBtn) {
      showToast('Open an email or select one or more rows first', 'warn');
      return false;
    }
    nativeClick(spamBtn);

    if (settings.alsoDelete) {
      await sleep(450);
      const delBtn = findDeleteButton();
      if (delBtn) nativeClick(delBtn);
    }

    showToast(settings.alsoDelete ? 'Marked as spam & deleted' : 'Marked as spam', 'success');
    return true;
  }

  function handleAction() {
    if (settings.confirmEachClick && !confirm('Mark as spam?')) return;
    spamAndDelete();
  }

  function injectFab() {
    if (document.getElementById(FAB_ID)) return;
    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.title = 'Mark as Spam & Delete (One-Click)';
    fab.setAttribute('aria-label', 'Mark as Spam and Delete');
    fab.innerHTML = `
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
        <path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v5h2v-5z"/>
      </svg>
      <span class="ocs-fab__label">Spam &amp; Delete</span>
    `;
    fab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleAction();
    });
    document.body.appendChild(fab);
  }

  function start() {
    loadSettings();
    injectFab();
    // Gmail re-renders the document body during navigation; if our FAB is ever
    // removed, drop it back in.
    const observer = new MutationObserver(() => {
      if (!document.getElementById(FAB_ID)) injectFab();
    });
    observer.observe(document.body, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
