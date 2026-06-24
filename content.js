(function () {
  'use strict';

  const FAB_ID = 'ocs-fab';
  const TOAST_CLASS = 'ocs-toast';

  const DEFAULTS = {
    alsoDelete: true,
    autoBlockSender: true,
    confirmEachClick: false,
    fabPosition: null,        // {x, y} viewport pixels; null = default bottom-right
  };

  let settings = { ...DEFAULTS };

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        if (stored) settings = { ...DEFAULTS, ...stored };
        const fab = document.getElementById(FAB_ID);
        if (fab) applyFabPosition(fab, settings.fabPosition);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const k of Object.keys(changes)) {
          settings[k] = changes[k].newValue;
        }
        if (changes.fabPosition) {
          const fab = document.getElementById(FAB_ID);
          if (fab) applyFabPosition(fab, settings.fabPosition);
        }
      });
    } catch (e) {
      // chrome.storage may be unavailable in subframes; ignore.
    }
  }

  function applyFabPosition(fab, pos) {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      fab.style.left = '';
      fab.style.top = '';
      fab.style.right = '24px';
      fab.style.bottom = '24px';
      return;
    }
    const size = fab.offsetWidth || 24;
    const maxX = window.innerWidth - size - 4;
    const maxY = window.innerHeight - size - 4;
    const x = Math.max(4, Math.min(pos.x, maxX));
    const y = Math.max(4, Math.min(pos.y, maxY));
    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
    fab.style.right = '';
    fab.style.bottom = '';
  }

  function attachDragHandlers(fab) {
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;
    let pointerId = null;
    let moved = false;

    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const rect = fab.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      moved = false;
      try { fab.setPointerCapture(pointerId); } catch (_) {}
    });

    fab.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        fab.classList.add('ocs-fab--dragging');
      }
      const size = fab.offsetWidth || 24;
      const maxX = window.innerWidth - size - 4;
      const maxY = window.innerHeight - size - 4;
      const x = Math.max(4, Math.min(originLeft + dx, maxX));
      const y = Math.max(4, Math.min(originTop + dy, maxY));
      fab.style.left = `${x}px`;
      fab.style.top = `${y}px`;
      fab.style.right = '';
      fab.style.bottom = '';
    });

    const finish = (e) => {
      if (pointerId !== e.pointerId) return;
      try { fab.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      if (moved) {
        fab.classList.remove('ocs-fab--dragging');
        fab.dataset.justDragged = '1';
        const rect = fab.getBoundingClientRect();
        const pos = { x: Math.round(rect.left), y: Math.round(rect.top) };
        try { chrome.storage.sync.set({ fabPosition: pos }); } catch (_) {}
      }
    };
    fab.addEventListener('pointerup', finish);
    fab.addEventListener('pointercancel', finish);
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

  // True for any element that lives inside a Gmail email-list row — those rows
  // expose hover-action buttons with the same aria-labels as the main toolbar
  // ("Delete", "Report spam", etc.). Acting on them targets that row, not the
  // selection, which would delete arbitrary nearby emails.
  function isInsideEmailRow(el) {
    return Boolean(
      el.closest('tr.zA') ||
      el.closest('[role="row"]') ||
      el.closest('.bqe') ||
      el.closest('.bAv')
    );
  }

  // Picks the first usable element matching one of the selectors that is NOT a
  // per-row hover action. Use this for any toolbar control whose aria-label is
  // also used on per-row hover buttons (Delete, Report spam, Archive, ...).
  function findToolbarButton(selectors) {
    for (const sel of selectors) {
      const matches = document.querySelectorAll(sel);
      for (const el of matches) {
        if (!isUsable(el)) continue;
        if (isInsideEmailRow(el)) continue;
        return el;
      }
    }
    return null;
  }

  // Gmail's "Report spam" toolbar control — try both ARIA labels and Gmail's
  // internal action codes. Works in inbox list (when rows are checked) and in
  // the open-email view. Excludes per-row hover buttons.
  function findReportSpamButton() {
    return findToolbarButton([
      '[aria-label="Report spam"]',
      '[data-tooltip="Report spam"]',
      '[aria-label^="Report spam"]',
      '[data-tooltip^="Report spam"]',
      'div[act="9"]',
      'div[act="55"]',
    ]);
  }

  // Gmail's trash-can toolbar control. The aria-label is normally "Delete" but
  // flips to "Delete forever" while viewing a message that already has the Spam
  // label, so accept both. Excludes per-row hover Delete buttons — those carry
  // the same aria-label and would act on the hovered row, not on the selection.
  function findDeleteButton() {
    const exact = findToolbarButton([
      '[aria-label="Delete"]',
      '[data-tooltip="Delete"]',
    ]);
    if (exact) return exact;
    const forever = findToolbarButton([
      '[aria-label="Delete forever"]',
      '[data-tooltip="Delete forever"]',
    ]);
    if (forever) return forever;
    return findToolbarButton(['div[act="10"]', 'div[act="61"]']);
  }

  // Confirms Gmail's "Delete this message permanently?" alert when the trash
  // icon was the "Delete forever" variant.
  function findDeleteForeverConfirm() {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const d of dialogs) {
      if (!isUsable(d)) continue;
      const text = (d.textContent || '').toLowerCase();
      if (!text.includes('permanently') && !text.includes('forever')) continue;
      const buttons = Array.from(d.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        if (!isUsable(b)) continue;
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t === 'ok' || t === 'delete' || t === 'delete forever') return b;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(finder, timeoutMs = 1500, intervalMs = 80) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = finder();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  // Finds Gmail's "Report spam or unsubscribe?" pre-confirmation dialog and returns
  // its "Report spam" button. To avoid misfiring on any other dialog with a Report
  // spam button, we require both a "Report spam" AND an "Unsubscribe" button to be
  // present in the same dialog.
  function findReportSpamInDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const d of dialogs) {
      if (!isUsable(d)) continue;
      const buttons = Array.from(d.querySelectorAll('button, [role="button"]'));
      let reportBtn = null;
      let hasUnsub = false;
      for (const b of buttons) {
        if (!isUsable(b)) continue;
        const text = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text === 'report spam') reportBtn = b;
        else if (text === 'unsubscribe') hasUnsub = true;
      }
      if (reportBtn && hasUnsub) return reportBtn;
    }
    return null;
  }

  // Finds Gmail's "Spam reported. Also block sender?" confirmation button.
  // Matches buttons (HTMLButton or role=button) whose visible text is "Yes, block".
  function findBlockSenderButton() {
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], .a3s, .Kj-JD'
    );
    const search = (root) => {
      const candidates = root.querySelectorAll('button, [role="button"]');
      for (const el of candidates) {
        if (!isUsable(el)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text === 'yes, block') return el;
      }
      return null;
    };
    for (const d of dialogs) {
      if (!isUsable(d)) continue;
      const found = search(d);
      if (found) return found;
    }
    return search(document);
  }

  async function spamAndDelete() {
    const spamBtn = findReportSpamButton();
    if (!spamBtn) {
      showToast('Open an email or select one or more rows first', 'warn');
      return false;
    }
    nativeClick(spamBtn);

    // Pre-confirmation dialog: "Report spam or unsubscribe?". Click "Report spam"
    // so the spam action actually goes through (otherwise it just sits there).
    const preConfirmBtn = await waitFor(findReportSpamInDialog, 900);
    if (preConfirmBtn) {
      nativeClick(preConfirmBtn);
      await sleep(250);
    }

    // Post-confirmation dialog: "Spam reported. Also block sender?". While this is
    // open the Delete button is unreachable, so handle it first.
    let blocked = false;
    if (settings.autoBlockSender) {
      const blockBtn = await waitFor(findBlockSenderButton, 1200);
      if (blockBtn) {
        nativeClick(blockBtn);
        blocked = true;
        await sleep(250);
      }
    }

    if (settings.alsoDelete) {
      await sleep(450);
      const delBtn = findDeleteButton();
      if (delBtn) {
        nativeClick(delBtn);
        // "Delete forever" pops its own "Delete this message permanently?" confirm.
        const confirmBtn = await waitFor(findDeleteForeverConfirm, 900);
        if (confirmBtn) {
          nativeClick(confirmBtn);
          await sleep(150);
        }
      }
    }

    const parts = ['Marked as spam'];
    if (blocked) parts.push('sender blocked');
    if (settings.alsoDelete) parts.push('deleted');
    showToast(parts.join(' & '), 'success');
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
    fab.title = 'Mark as Spam & Delete — drag to reposition';
    fab.setAttribute('aria-label', 'Mark as Spam and Delete');
    fab.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v5h2v-5z"/>
      </svg>
    `;
    fab.addEventListener('click', (e) => {
      if (fab.dataset.justDragged === '1') {
        delete fab.dataset.justDragged;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleAction();
    });
    document.body.appendChild(fab);
    applyFabPosition(fab, settings.fabPosition);
    attachDragHandlers(fab);
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
