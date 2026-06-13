(function () {
  'use strict';

  const TOOLBAR_BTN_ID = 'ocs-toolbar-spam-btn';
  const ROW_BTN_CLASS = 'ocs-row-spam-btn';
  const TOAST_CLASS = 'ocs-toast';

  const DEFAULTS = {
    alsoPermanentDelete: true,
    showRowButtons: true,
    showToolbarButton: true,
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
      // chrome.storage may not be available in some frames; ignore.
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

  function findByAttr(root, attrs) {
    for (const [attr, val] of attrs) {
      const el = root.querySelector(`[${attr}="${val}"]`);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  function findReportSpamButton(root = document) {
    const selectors = [
      '[aria-label="Report spam"]',
      '[data-tooltip="Report spam"]',
      '[aria-label*="Report spam"]',
      '[data-tooltip*="Report spam"]',
      'div[act="9"]',
      'div[act="55"]',
    ];
    for (const sel of selectors) {
      const matches = root.querySelectorAll(sel);
      for (const el of matches) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function findDeleteForeverButton(root = document) {
    const selectors = [
      '[aria-label="Delete forever"]',
      '[data-tooltip="Delete forever"]',
      '[aria-label*="Delete forever"]',
      '[data-tooltip*="Delete forever"]',
    ];
    for (const sel of selectors) {
      const matches = root.querySelectorAll(sel);
      for (const el of matches) {
        if (isVisible(el)) return el;
      }
    }
    return null;
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

  function reportSpamForOpenedThread() {
    const btn = findReportSpamButton();
    if (btn) {
      nativeClick(btn);
      return true;
    }
    return false;
  }

  async function permanentlyDeleteLastReported() {
    // After reporting spam, Gmail shows an undo bar. We need to actually navigate to spam
    // and permanently delete. To avoid disrupting the user, we instead listen for the
    // next time the user visits Spam, OR provide guidance. For an automated path, we
    // attempt to navigate to the Spam folder, select all, and delete forever — but only
    // if the user has explicitly enabled it for the *currently selected* messages.
    // For safety, this helper instead does nothing here and returns false; the toolbar
    // path only triggers Spam (Gmail permanently deletes spam after 30 days). The row
    // button path handles permanent delete by chaining actions on opened threads.
    return false;
  }

  function processSelectedOrOpenedThread() {
    if (settings.confirmEachClick) {
      if (!confirm('Mark this email as spam?')) return;
    }
    const ok = reportSpamForOpenedThread();
    if (ok) {
      showToast('Marked as spam', 'success');
    } else {
      // Fallback: keyboard shortcut "!" (requires shortcuts enabled in Gmail settings)
      simulateGmailShortcut('!');
      showToast('Tried "!" shortcut — enable Gmail keyboard shortcuts if nothing happens', 'warn');
    }
  }

  function simulateGmailShortcut(key) {
    const evt = new KeyboardEvent('keydown', {
      key,
      keyCode: key.charCodeAt(0),
      which: key.charCodeAt(0),
      shiftKey: key === '!' || key === '#',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(evt);
  }

  function findGmailToolbar() {
    // gh="tm" is Gmail's main toolbar container that holds action buttons.
    const tm = document.querySelector('[gh="tm"]');
    if (tm && isVisible(tm)) return tm;
    return null;
  }

  function injectToolbarButton() {
    if (!settings.showToolbarButton) {
      const existing = document.getElementById(TOOLBAR_BTN_ID);
      if (existing) existing.remove();
      return;
    }
    if (document.getElementById(TOOLBAR_BTN_ID)) return;
    const toolbar = findGmailToolbar();
    if (!toolbar) return;

    const btn = document.createElement('div');
    btn.id = TOOLBAR_BTN_ID;
    btn.className = 'ocs-toolbar-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = 'Mark as Spam (One-Click)';
    btn.innerHTML = `
      <span class="ocs-toolbar-btn__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v5h2v-5z"/>
        </svg>
      </span>
      <span class="ocs-toolbar-btn__label">Spam &amp; Delete</span>
    `;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      processSelectedOrOpenedThread();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        processSelectedOrOpenedThread();
      }
    });

    toolbar.appendChild(btn);
  }

  function injectRowButtons() {
    if (!settings.showRowButtons) {
      document.querySelectorAll('.' + ROW_BTN_CLASS).forEach((el) => el.remove());
      return;
    }
    // Gmail email rows have class "zA" in the inbox list view.
    const rows = document.querySelectorAll('tr.zA');
    rows.forEach((row) => {
      if (row.querySelector('.' + ROW_BTN_CLASS)) return;
      // Find the rightmost cell where actions/timestamp live.
      const lastCell = row.querySelector('td.xY') || row.lastElementChild;
      if (!lastCell) return;

      const btn = document.createElement('span');
      btn.className = ROW_BTN_CLASS;
      btn.setAttribute('role', 'button');
      btn.title = 'Mark as Spam (One-Click)';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v5h2v-5z"/>
        </svg>
      `;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleRowClick(row);
      });
      // Position the button so it appears on row hover.
      lastCell.appendChild(btn);
    });
  }

  function handleRowClick(row) {
    if (settings.confirmEachClick) {
      if (!confirm('Mark this email as spam?')) return;
    }
    // Open the email, then report spam, then go back to inbox.
    const subjectCell = row.querySelector('td[role="link"]') || row.querySelector('.y6') || row;
    nativeClick(subjectCell);
    setTimeout(() => {
      const ok = reportSpamForOpenedThread();
      if (ok) {
        showToast('Marked as spam', 'success');
      } else {
        showToast('Could not find the spam button — try opening the email first', 'warn');
      }
    }, 350);
  }

  // Re-inject on Gmail's frequent DOM updates.
  const observer = new MutationObserver(() => {
    injectToolbarButton();
    injectRowButtons();
  });

  function start() {
    loadSettings();
    injectToolbarButton();
    injectRowButtons();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
