(function () {
  'use strict';

  const TOOLBAR_BTN_ID = 'ocs-toolbar-spam-btn';
  const ROW_BTN_CLASS = 'ocs-row-spam-btn';
  const TOAST_CLASS = 'ocs-toast';

  const DEFAULTS = {
    alsoArchive: true,        // belt-and-suspenders: ensure the thread leaves the inbox
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

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  function findFirstVisible(selectors, root = document) {
    for (const sel of selectors) {
      const matches = root.querySelectorAll(sel);
      for (const el of matches) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function findReportSpamButton(root = document) {
    return findFirstVisible(
      [
        '[aria-label="Report spam"]',
        '[data-tooltip="Report spam"]',
        '[aria-label*="Report spam"]',
        '[data-tooltip*="Report spam"]',
        'div[act="9"]',
        'div[act="55"]',
      ],
      root
    );
  }

  function findArchiveButton(root = document) {
    return findFirstVisible(
      [
        '[aria-label="Archive"]',
        '[data-tooltip="Archive"]',
        '[aria-label*="Archive"]',
        '[data-tooltip*="Archive"]',
        'div[act="7"]',
      ],
      root
    );
  }

  function findRowCheckbox(row) {
    return row.querySelector('[role="checkbox"]');
  }

  function isChecked(checkbox) {
    return checkbox && checkbox.getAttribute('aria-checked') === 'true';
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

  // Click Gmail's "Report spam" button, then — if requested — click "Archive" as a
  // safety net so the conversation can't linger in the inbox due to per-message
  // labels in a multi-message thread. If "Report spam" is missing, fall back to the
  // "!" keyboard shortcut (requires Gmail keyboard shortcuts enabled).
  async function reportSpamAndEnsureGone() {
    const spamBtn = findReportSpamButton();
    if (spamBtn) {
      nativeClick(spamBtn);
    } else {
      simulateGmailShortcut('!');
    }

    if (!settings.alsoArchive) return Boolean(spamBtn);

    // After Gmail processes the spam action, the toolbar's Archive button may still
    // be present if any selection / open thread remains. Clicking it removes the
    // Inbox label without un-doing the spam label, guaranteeing the thread leaves
    // the inbox view.
    await sleep(450);
    const archiveBtn = findArchiveButton();
    if (archiveBtn) nativeClick(archiveBtn);
    return true;
  }

  function processSelectedOrOpenedThread() {
    if (settings.confirmEachClick && !confirm('Mark this email as spam?')) return;
    reportSpamAndEnsureGone().then((ok) => {
      if (ok) {
        showToast(settings.alsoArchive ? 'Marked as spam & removed from inbox' : 'Marked as spam', 'success');
      } else {
        showToast('Could not find Gmail\'s Report Spam control', 'warn');
      }
    });
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
      <span class="ocs-toolbar-btn__label">Mark as Spam</span>
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
    const rows = document.querySelectorAll('tr.zA');
    rows.forEach((row) => {
      if (row.querySelector('.' + ROW_BTN_CLASS)) return;
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
      lastCell.appendChild(btn);
    });
  }

  // Row click path: select just this row's checkbox, then drive Gmail's toolbar.
  // This avoids opening the email and avoids accidentally including other selected
  // rows in the action.
  async function handleRowClick(row) {
    if (settings.confirmEachClick && !confirm('Mark this email as spam?')) return;

    // Deselect any other currently-selected rows so we don't act on them.
    document
      .querySelectorAll('tr.zA [role="checkbox"][aria-checked="true"]')
      .forEach((cb) => {
        const otherRow = cb.closest('tr.zA');
        if (otherRow && otherRow !== row) nativeClick(cb);
      });

    const checkbox = findRowCheckbox(row);
    if (checkbox && !isChecked(checkbox)) {
      nativeClick(checkbox);
    }

    // Gmail needs a tick to update the toolbar with action buttons.
    await sleep(180);

    const ok = await reportSpamAndEnsureGone();
    if (ok) {
      showToast(settings.alsoArchive ? 'Marked as spam & removed from inbox' : 'Marked as spam', 'success');
    } else {
      showToast('Could not find Gmail\'s Report Spam control', 'warn');
      // Roll back our selection so we don't leave the row in a weird state.
      if (checkbox && isChecked(checkbox)) nativeClick(checkbox);
    }
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
