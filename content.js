/**
 * One-Click Mark as Spam & Delete — Gmail content script.
 *
 * Single-file IIFE (no bundler, no imports) so it can be loaded directly by an
 * MV3 `content_scripts` entry. The widget lives in Gmail's primary toolbar,
 * inserted between "Back to Inbox" and "Archive", and falls back to a floating
 * action button when that toolbar cannot be resolved.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const WIDGET_ID = 'ocs-widget';
  const TOAST_CLASS = 'ocs-toast';
  const DIALOG_CLASS = 'ocs-dialog';

  const WIDGET_STYLES = ['gmail-icon', 'emphasized', 'compact', 'floating'];
  const PLACEMENT_MODES = ['toolbar', 'floating'];

  const DEFAULTS = {
    alsoDelete: true,
    autoBlockSender: true,
    confirmEachClick: false,
    widgetStyle: 'gmail-icon',
    placementMode: 'toolbar',
    // Polymorphic: {x, y} viewport pixels in floating placement, {slot: n} in
    // toolbar placement, null for "wherever the default is".
    fabPosition: null,
  };

  const LABEL = 'Mark as spam and delete';
  const DISABLED_HINT = 'Open an email or select one or more rows first';

  // Gmail control detection. Order matters: the first entry of each list is the
  // primary selector, the rest are locale-independent / older-layout fallbacks.
  const BACK_SELECTORS = [
    '[aria-label="Back to Inbox"]',
    '[guidedhelpid="backButton"]',
    '[data-tooltip^="Back to"]',
    '[aria-label^="Back to"]',
  ];
  const ARCHIVE_SELECTORS = [
    '[aria-label="Archive"]',
    '[act="7"]',
    '[act="8"]',
    '[data-tooltip="Archive"]',
  ];
  const TOOLBAR_SELECTORS = [
    '[gh="mtb"]',
    '.G-atb',
    '[role="toolbar"]',
  ];

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------

  let settings = { ...DEFAULTS };
  let anchorParent = null;      // element the toolbar widget is inserted into
  let toolbarObserver = null;   // scoped observer on the toolbar container
  let deathObserver = null;     // scoped observer on the toolbar's parent (childList only)
  let bootstrapObserver = null; // temporary observer used until first anchor
  let observedToolbar = null;
  let placementStatus = 'pending';
  let fallbackNoticeShown = false;
  let actionInFlight = false;
  let started = false;
  let rafHandle = null;
  let saveTimer = null;
  const timers = new Set();
  const teardown = [];

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function sleep(ms) {
    return new Promise((resolve) => later(resolve, ms));
  }

  function raf(fn) {
    if (typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(fn);
    }
    return later(fn, 16);
  }

  function cancelRaf(handle) {
    if (handle == null) return;
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle);
    }
  }

  /** Coalesces bursts of calls into a single call on the next animation frame. */
  function rafBatched(fn) {
    return function scheduled() {
      if (rafHandle != null) return;
      rafHandle = raf(() => {
        rafHandle = null;
        fn();
      });
    };
  }

  function on(target, type, handler, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, handler, opts);
    teardown.push(() => target.removeEventListener(type, handler, opts));
  }

  function safeMatchMedia(query) {
    try {
      if (typeof window.matchMedia !== 'function') return null;
      return window.matchMedia(query);
    } catch (_) {
      return null;
    }
  }

  function computedStyleOf(el) {
    try {
      return window.getComputedStyle(el);
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function normalizeSettings(raw) {
    const next = { ...DEFAULTS, ...(raw || {}) };
    if (!WIDGET_STYLES.includes(next.widgetStyle)) next.widgetStyle = DEFAULTS.widgetStyle;
    if (!PLACEMENT_MODES.includes(next.placementMode)) next.placementMode = DEFAULTS.placementMode;
    next.alsoDelete = Boolean(next.alsoDelete);
    next.autoBlockSender = Boolean(next.autoBlockSender);
    next.confirmEachClick = Boolean(next.confirmEachClick);
    next.fabPosition = normalizePosition(next.fabPosition);
    return next;
  }

  function normalizePosition(pos) {
    if (!pos || typeof pos !== 'object') return null;
    if (typeof pos.slot === 'number' && Number.isFinite(pos.slot)) {
      return { slot: Math.max(0, Math.round(pos.slot)) };
    }
    if (typeof pos.x === 'number' && typeof pos.y === 'number') {
      return { x: pos.x, y: pos.y };
    }
    return null;
  }

  function storageArea() {
    try {
      if (typeof chrome === 'undefined') return null;
      if (!chrome.storage || !chrome.storage.sync) return null;
      return chrome.storage.sync;
    } catch (_) {
      return null;
    }
  }

  function loadSettings(done) {
    const area = storageArea();
    if (!area) {
      if (done) done();
      return;
    }
    try {
      area.get(DEFAULTS, (stored) => {
        settings = normalizeSettings(stored);
        if (done) done();
      });
    } catch (_) {
      if (done) done();
    }
  }

  function persist(patch) {
    const area = storageArea();
    if (!area) return;
    try {
      area.set(patch);
    } catch (_) {
      /* storage may be unavailable in subframes */
    }
  }

  /** Debounced so a drag writes once when it settles, not on every pointermove. */
  function persistDebounced(patch, delay = 300) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      timers.delete(saveTimer);
    }
    saveTimer = later(() => {
      saveTimer = null;
      persist(patch);
    }, delay);
  }

  function watchStorage() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      const handler = (changes, area) => {
        if (area !== 'sync') return;
        const patch = {};
        for (const key of Object.keys(changes)) patch[key] = changes[key].newValue;
        const before = settings;
        settings = normalizeSettings({ ...settings, ...patch });
        const needsRebuild =
          before.widgetStyle !== settings.widgetStyle ||
          before.placementMode !== settings.placementMode;
        if (needsRebuild) {
          removeWidget();
          injectWidget();
        } else {
          applyPosition();
          updateWidgetState();
        }
      };
      chrome.storage.onChanged.addListener(handler);
      teardown.push(() => {
        try { chrome.storage.onChanged.removeListener(handler); } catch (_) {}
      });
    } catch (_) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Element predicates (preserved safety guards)
  // ---------------------------------------------------------------------------

  function isUsable(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = computedStyleOf(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (style.pointerEvents === 'none') return false;
    }
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  // True for any element that lives inside a Gmail email-list row — those rows
  // expose hover-action buttons with the same aria-labels as the main toolbar
  // ("Delete", "Report spam", ...). Acting on them targets that row, not the
  // selection, which would delete arbitrary nearby emails.
  function isInsideEmailRow(el) {
    if (!el || !el.closest) return false;
    return Boolean(
      el.closest('tr.zA') ||
      el.closest('[role="row"]') ||
      el.closest('.bqe') ||
      el.closest('.bAv')
    );
  }

  // True when the element sits inside rendered email content. We must never
  // auto-click anything inside a message body: a malicious email could embed a
  // fake "Yes, block" / "OK" button and get the extension to click
  // attacker-controlled markup.
  function isInsideEmailContent(el) {
    if (!el || !el.closest) return false;
    return Boolean(el.closest('.a3s, .ii, .adn'));
  }

  function isOurs(el) {
    if (!el || !el.closest) return false;
    return Boolean(el.closest('#' + WIDGET_ID + ', .' + DIALOG_CLASS + ', .' + TOAST_CLASS));
  }

  // Picks the first usable element matching one of the selectors that is NOT a
  // per-row hover action and not part of our own UI. Use this for any toolbar
  // control whose aria-label is also used on per-row hover buttons.
  function findToolbarButton(selectors, root) {
    const scope = root || document;
    for (const sel of selectors) {
      let matches;
      try {
        matches = scope.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of matches) {
        if (!isUsable(el)) continue;
        if (isInsideEmailRow(el)) continue;
        if (isInsideEmailContent(el)) continue;
        if (isOurs(el)) continue;
        return el;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Gmail control finders
  // ---------------------------------------------------------------------------

  function findBackButton() {
    return findToolbarButton(BACK_SELECTORS);
  }

  function findArchiveButton() {
    return findToolbarButton(ARCHIVE_SELECTORS);
  }

  /**
   * Gmail's main action toolbar. Preferred resolution is the nearest common
   * ancestor of Back and Archive, because that is the container that actually
   * re-renders around our widget; the selector list is the fallback.
   */
  function findToolbarContainer() {
    const back = findBackButton();
    const archive = findArchiveButton();
    if (back && archive) {
      const common = commonAncestor(back, archive);
      if (common && common !== document.body && common !== document.documentElement) {
        return common;
      }
    }
    const anchor = back || archive;
    if (anchor && anchor.closest) {
      for (const sel of TOOLBAR_SELECTORS) {
        const hit = anchor.closest(sel);
        if (hit) return hit;
      }
    }
    for (const sel of TOOLBAR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && !isOurs(el)) return el;
    }
    return null;
  }

  function commonAncestor(a, b) {
    const chain = new Set();
    for (let node = a; node; node = node.parentElement) chain.add(node);
    for (let node = b; node; node = node.parentElement) {
      if (chain.has(node)) return node;
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

  /** Dialog/snackbar containers that are safe to search for auto-click targets. */
  function safeDialogContainers() {
    const out = [];
    const containers = document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="alert"], .Kj-JD, .bAp'
    );
    for (const c of containers) {
      if (!isUsable(c)) continue;
      if (isInsideEmailContent(c)) continue;
      if (isOurs(c)) continue;
      out.push(c);
    }
    return out;
  }

  function buttonText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Confirms Gmail's "Delete this message permanently?" alert when the trash
  // icon was the "Delete forever" variant.
  function findDeleteForeverConfirm() {
    for (const d of safeDialogContainers()) {
      const role = d.getAttribute('role');
      if (role !== 'dialog' && role !== 'alertdialog') continue;
      const text = (d.textContent || '').toLowerCase();
      if (!text.includes('permanently') && !text.includes('forever')) continue;
      for (const b of d.querySelectorAll('button, [role="button"]')) {
        if (!isUsable(b) || isInsideEmailContent(b)) continue;
        const t = buttonText(b);
        if (t === 'ok' || t === 'delete' || t === 'delete forever') return b;
      }
    }
    return null;
  }

  // Finds Gmail's "Report spam or unsubscribe?" pre-confirmation dialog and returns
  // its "Report spam" button. To avoid misfiring on any other dialog with a Report
  // spam button, we require both a "Report spam" AND an "Unsubscribe" button to be
  // present in the same dialog.
  function findReportSpamInDialog() {
    for (const d of safeDialogContainers()) {
      const role = d.getAttribute('role');
      if (role !== 'dialog' && role !== 'alertdialog') continue;
      let reportBtn = null;
      let hasUnsub = false;
      for (const b of d.querySelectorAll('button, [role="button"]')) {
        if (!isUsable(b) || isInsideEmailContent(b)) continue;
        const text = buttonText(b);
        if (text === 'report spam') reportBtn = b;
        else if (text === 'unsubscribe') hasUnsub = true;
      }
      if (reportBtn && hasUnsub) return reportBtn;
    }
    return null;
  }

  // Finds Gmail's "Spam reported. Also block sender?" confirmation button.
  // Gmail shows this either as a modal dialog or as a bottom-left snackbar.
  // Search is restricted to dialog/alert containers only — never the message
  // body or the document at large (see isInsideEmailContent).
  function findBlockSenderButton() {
    for (const c of safeDialogContainers()) {
      for (const el of c.querySelectorAll('button, [role="button"]')) {
        if (!isUsable(el) || isInsideEmailContent(el)) continue;
        if (buttonText(el) === 'yes, block') return el;
      }
    }
    return null;
  }

  /** Gmail's own "Undo" affordance in its post-action snackbar. */
  function findGmailUndoButton() {
    for (const c of safeDialogContainers()) {
      for (const el of c.querySelectorAll('button, [role="button"], a[role="link"], span[role="link"]')) {
        if (!isUsable(el) || isInsideEmailContent(el)) continue;
        if (buttonText(el) === 'undo') return el;
      }
    }
    return null;
  }

  // Perm-id of the conversation currently open in reading view, or null when
  // in list view. Used to make sure the Delete step never fires on a different
  // conversation than the one we just reported (e.g. Gmail's auto-advance
  // setting opens the next email right after Report spam).
  function getOpenThreadId() {
    const el = document.querySelector('[data-thread-perm-id]');
    return el ? el.getAttribute('data-thread-perm-id') : null;
  }

  /**
   * True when Gmail auto-advanced to a different conversation between reporting
   * spam and deleting — in that case the Delete step must be skipped.
   */
  function advancedToOtherThread(before, now) {
    return Boolean(before && now && now !== before);
  }

  /** Whether there is anything for the action to operate on right now. */
  function hasActionableTarget() {
    if (findReportSpamButton()) return true;
    if (getOpenThreadId()) return true;
    for (const box of document.querySelectorAll('[role="checkbox"][aria-checked="true"]')) {
      if (isUsable(box)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Theme + motion preferences
  // ---------------------------------------------------------------------------

  function parseColor(value) {
    if (!value) return null;
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i.exec(value);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: alpha };
  }

  function luminance(color) {
    return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  }

  /**
   * Reads Gmail's own toolbar background to decide light vs dark, so custom
   * Gmail themes are honoured. Falls back to the OS preference via matchMedia.
   */
  function detectTheme() {
    const probes = [
      findToolbarContainer(),
      document.querySelector('[role="main"]'),
      document.body,
    ];
    for (const el of probes) {
      if (!el) continue;
      const style = computedStyleOf(el);
      if (!style) continue;
      const color = parseColor(style.backgroundColor);
      if (!color || color.a === 0) continue;
      return luminance(color) < 0.5 ? 'dark' : 'light';
    }
    const mq = safeMatchMedia('(prefers-color-scheme: dark)');
    return mq && mq.matches ? 'dark' : 'light';
  }

  function prefersReducedMotion() {
    const mq = safeMatchMedia('(prefers-reduced-motion: reduce)');
    return Boolean(mq && mq.matches);
  }

  function applyPresentationClasses(el) {
    if (!el) return;
    el.classList.remove('ocs-theme-light', 'ocs-theme-dark');
    el.classList.add('ocs-theme-' + detectTheme());
    el.classList.toggle('ocs-reduce-motion', prefersReducedMotion());
  }

  // ---------------------------------------------------------------------------
  // Widget construction
  // ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function spamIcon(size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('ocs-widget__icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v5h2v-5z');
    svg.appendChild(path);
    return svg;
  }

  /**
   * Builds the widget element for a style variant. Pure: it only creates DOM,
   * it does not insert or wire it up.
   */
  function createWidget(style) {
    const variant = WIDGET_STYLES.includes(style) ? style : DEFAULTS.widgetStyle;
    const el = document.createElement('div');
    el.id = WIDGET_ID;
    el.className = 'ocs-widget ocs-widget--' + variant;
    el.dataset.ocsStyle = variant;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', LABEL);
    el.setAttribute('data-tooltip', LABEL);
    el.title = LABEL;

    if (variant === 'compact') {
      const label = document.createElement('span');
      label.className = 'ocs-widget__label';
      label.textContent = 'Spam';
      el.appendChild(label);
      el.appendChild(spamIcon(16));
    } else if (variant === 'floating') {
      el.appendChild(spamIcon(14));
    } else {
      el.appendChild(spamIcon(20));
    }
    applyPresentationClasses(el);
    return el;
  }

  function getWidget() {
    return document.getElementById(WIDGET_ID);
  }

  function removeWidget() {
    const el = getWidget();
    if (el && el.parentNode) el.parentNode.removeChild(el);
    anchorParent = null;
  }

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------

  /**
   * Placement actually in effect. The classic FAB style always implies floating
   * placement; everything else honours the user's placementMode.
   */
  function effectivePlacement() {
    if (settings.widgetStyle === 'floating') return 'floating';
    return settings.placementMode === 'floating' ? 'floating' : 'toolbar';
  }

  function getPlacementStatus() {
    return placementStatus;
  }

  function placementExplanation() {
    if (placementStatus === 'toolbar') return '';
    if (placementStatus === 'fallback') {
      return 'Gmail toolbar not found — using the floating button instead.';
    }
    return '';
  }

  /** The child of `parent` that contains (or is) `el`. */
  function childContaining(parent, el) {
    let node = el;
    while (node && node.parentElement !== parent) node = node.parentElement;
    return node;
  }

  /**
   * Where the widget goes: directly after Back and directly before Archive.
   * When the two are real siblings this is the plain
   * `back.parentNode.insertBefore(widget, archive)` case; Gmail usually wraps
   * each control in its own div, so we fall back to inserting at their nearest
   * common ancestor, before the subtree that holds Archive.
   */
  function resolveInsertionPoint(back, archive) {
    if (!back || !back.parentNode) return null;
    if (archive) {
      if (back.parentNode === archive.parentNode) {
        return { parent: back.parentNode, before: archive };
      }
      const common = commonAncestor(back, archive);
      if (common) {
        const before = childContaining(common, archive);
        if (before) return { parent: common, before };
      }
    }
    // No Archive control in this view: sit immediately after Back.
    const backSibling = back;
    return { parent: back.parentNode, before: backSibling.nextSibling };
  }

  function ensureWidget() {
    const existing = getWidget();
    if (existing && existing.dataset.ocsStyle === settings.widgetStyle) {
      return { widget: existing, isNew: false };
    }
    if (existing) removeWidget();
    return { widget: createWidget(settings.widgetStyle), isNew: true };
  }

  /** Inserts the widget between Back and Archive. Returns true on success. */
  function injectToolbarWidget() {
    const back = findBackButton();
    const archive = findArchiveButton();
    const point = resolveInsertionPoint(back, archive);
    if (!point) return false;

    const { widget, isNew } = ensureWidget();

    widget.classList.remove('ocs-placement--floating', 'ocs-widget--fallback');
    widget.classList.add('ocs-placement--toolbar');
    widget.style.left = '';
    widget.style.top = '';
    widget.style.right = '';
    widget.style.bottom = '';

    if (point.before && point.before !== widget) {
      point.parent.insertBefore(widget, point.before);
    } else if (widget.parentNode !== point.parent) {
      point.parent.appendChild(widget);
    }

    anchorParent = point.parent;
    placementStatus = 'toolbar';
    if (isNew) wireWidget(widget);
    applyPresentationClasses(widget);
    applyPosition();
    updateWidgetState();
    return true;
  }

  /** Classic FAB placement — also the fallback when the toolbar is unavailable. */
  function injectFloatingWidget(isFallback) {
    const { widget, isNew } = ensureWidget();

    widget.classList.remove('ocs-placement--toolbar');
    widget.classList.add('ocs-placement--floating');
    widget.classList.toggle('ocs-widget--fallback', Boolean(isFallback));

    if (widget.parentNode !== document.body) document.body.appendChild(widget);
    anchorParent = null;
    placementStatus = isFallback ? 'fallback' : 'floating';

    if (isNew) wireWidget(widget);
    applyPresentationClasses(widget);
    applyPosition();
    updateWidgetState();

    if (isFallback && !fallbackNoticeShown) {
      fallbackNoticeShown = true;
      showToast(placementExplanation(), 'warn');
    }
    return true;
  }

  /** Idempotent: repeated calls converge on exactly one correctly-placed widget. */
  function injectWidget() {
    if (!document.body) return false;
    if (effectivePlacement() === 'floating') return injectFloatingWidget(false);
    if (injectToolbarWidget()) return true;
    return injectFloatingWidget(true);
  }

  /** True when the widget is missing or no longer sitting next to Back/Archive. */
  function isWidgetStale() {
    const widget = getWidget();
    if (!widget) return true;
    if (!widget.isConnected) return true;
    if (effectivePlacement() !== 'toolbar') return false;
    if (placementStatus === 'fallback') {
      // A toolbar may have appeared since we fell back.
      return Boolean(findBackButton());
    }
    const point = resolveInsertionPoint(findBackButton(), findArchiveButton());
    if (!point) return true;
    if (widget.parentNode !== point.parent) return true;
    // Partial toolbar rerender: Gmail replaces Back/Archive controls inside
    // the same parent but the widget stays under the same parent.  Check the
    // actual DOM order — the widget must still precede the Archive reference.
    if (point.before && point.before !== widget) {
      const siblings = Array.from(point.parent.children);
      if (siblings.indexOf(point.before) < siblings.indexOf(widget)) return true;
    }
    return false;
  }

  /** Re-resolves Back/Archive after a Gmail re-render and re-inserts the widget. */
  function reAnchorWidget() {
    if (!document.body) return false;
    const result = injectWidget();
    observeToolbar();
    return result;
  }

  const scheduleReAnchor = rafBatched(() => {
    // Defense-in-depth: if the observed toolbar container was removed,
    // re-observe before any staleness check.
    if (observedToolbar && !observedToolbar.isConnected) {
      observeToolbar();
    }
    if (isWidgetStale()) reAnchorWidget();
    else {
      applyPresentationClasses(getWidget());
      updateWidgetState();
    }
  });

  // ---------------------------------------------------------------------------
  // Position (floating x/y, toolbar slot)
  // ---------------------------------------------------------------------------

  function applyPosition() {
    const widget = getWidget();
    if (!widget) return;
    if (effectivePlacement() === 'toolbar' && placementStatus === 'toolbar') {
      const pos = settings.fabPosition;
      if (pos && typeof pos.slot === 'number') moveWidgetToSlot(pos.slot, false);
      return;
    }
    applyFloatingPosition(widget, settings.fabPosition);
  }

  function applyFloatingPosition(widget, pos) {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      widget.style.left = '';
      widget.style.top = '';
      widget.style.right = '24px';
      widget.style.bottom = '24px';
      return;
    }
    const rect = widget.getBoundingClientRect();
    const w = rect.width || 24;
    const h = rect.height || 24;
    const maxX = Math.max(4, window.innerWidth - w - 4);
    const maxY = Math.max(4, window.innerHeight - h - 4);
    widget.style.left = Math.max(4, Math.min(pos.x, maxX)) + 'px';
    widget.style.top = Math.max(4, Math.min(pos.y, maxY)) + 'px';
    widget.style.right = '';
    widget.style.bottom = '';
  }

  /** Sibling controls the widget may be placed among, widget itself excluded. */
  function toolbarSlots() {
    const widget = getWidget();
    if (!widget || !widget.parentNode) return [];
    return Array.from(widget.parentNode.children).filter((c) => c !== widget);
  }

  function currentSlotIndex() {
    const widget = getWidget();
    if (!widget || !widget.parentNode) return -1;
    return Array.from(widget.parentNode.children).indexOf(widget);
  }

  /** Moves the widget to slot `index` among its siblings. Horizontal only. */
  function moveWidgetToSlot(index, save = true) {
    const widget = getWidget();
    if (!widget || !widget.parentNode) return -1;
    const slots = toolbarSlots();
    const clamped = Math.max(0, Math.min(index, slots.length));
    const before = slots[clamped] || null;
    if (before) widget.parentNode.insertBefore(widget, before);
    else widget.parentNode.appendChild(widget);
    const actual = currentSlotIndex();
    if (save) persistDebounced({ fabPosition: { slot: actual } });
    return actual;
  }

  /**
   * Toolbar drag: the pointer's Y coordinate is deliberately ignored so the
   * widget can never leave the toolbar row — only its slot changes.
   */
  function handleToolbarDragTo(clientX /* clientY intentionally unused */) {
    const widget = getWidget();
    if (!widget || !widget.parentNode) return -1;
    const slots = toolbarSlots();
    let index = slots.length;
    for (let i = 0; i < slots.length; i += 1) {
      const rect = slots[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
        index = i;
        break;
      }
    }
    // Keep the widget pinned to the toolbar row: never set free coordinates.
    widget.style.left = '';
    widget.style.top = '';
    return moveWidgetToSlot(index);
  }

  function handleFloatingDragTo(clientX, clientY) {
    const widget = getWidget();
    if (!widget) return null;
    const rect = widget.getBoundingClientRect();
    const w = rect.width || 24;
    const h = rect.height || 24;
    const x = Math.max(4, Math.min(clientX, Math.max(4, window.innerWidth - w - 4)));
    const y = Math.max(4, Math.min(clientY, Math.max(4, window.innerHeight - h - 4)));
    widget.style.left = x + 'px';
    widget.style.top = y + 'px';
    widget.style.right = '';
    widget.style.bottom = '';
    const pos = { x: Math.round(x), y: Math.round(y) };
    persistDebounced({ fabPosition: pos });
    return pos;
  }

  // ---------------------------------------------------------------------------
  // Widget wiring: pointer, keyboard, state
  // ---------------------------------------------------------------------------

  function wireWidget(widget) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;

    widget.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const rect = widget.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      moved = false;
      try { widget.setPointerCapture(pointerId); } catch (_) {}
    });

    widget.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        widget.classList.add('ocs-widget--dragging');
      }
      if (isToolbarPlaced()) handleToolbarDragTo(e.clientX);
      else handleFloatingDragTo(originLeft + dx, originTop + dy);
    });

    const finish = (e) => {
      if (pointerId !== e.pointerId) return;
      try { widget.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      if (moved) {
        widget.classList.remove('ocs-widget--dragging');
        widget.dataset.justDragged = '1';
      }
    };
    widget.addEventListener('pointerup', finish);
    widget.addEventListener('pointercancel', finish);

    widget.addEventListener('click', (e) => {
      if (widget.dataset.justDragged === '1') {
        delete widget.dataset.justDragged;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleAction();
    });

    widget.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (!isToolbarPlaced()) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        moveWidgetToSlot(currentSlotIndex() + delta);
        widget.focus();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        handleAction();
      }
    });
  }

  function isToolbarPlaced() {
    const widget = getWidget();
    return Boolean(widget && widget.classList.contains('ocs-placement--toolbar'));
  }

  /**
   * Greys the widget out when there is nothing to act on. State is conveyed by
   * aria-disabled + tooltip text as well as colour, never colour alone.
   */
  function updateWidgetState() {
    const widget = getWidget();
    if (!widget) return false;
    const enabled = hasActionableTarget();
    widget.classList.toggle('ocs-widget--disabled', !enabled);
    widget.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    const suffix = placementExplanation();
    const base = enabled ? LABEL : LABEL + ' (unavailable — ' + DISABLED_HINT + ')';
    const text = suffix ? base + ' — ' + suffix : base;
    widget.setAttribute('aria-label', text);
    widget.setAttribute('data-tooltip', text);
    widget.title = text;
    return enabled;
  }

  // ---------------------------------------------------------------------------
  // Toast + confirmation dialog
  // ---------------------------------------------------------------------------

  function removeToasts() {
    for (const el of document.querySelectorAll('.' + TOAST_CLASS)) el.remove();
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} type
   * @param {{undo?: boolean, duration?: number}} [opts]
   */
  function showToast(message, type = 'info', opts = {}) {
    if (!document.body) return null;
    removeToasts();
    const reduced = prefersReducedMotion();
    const toast = document.createElement('div');
    toast.className = TOAST_CLASS + ' ' + TOAST_CLASS + '--' + type;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    if (reduced) toast.classList.add('ocs-reduce-motion');
    toast.classList.add('ocs-theme-' + detectTheme());

    const text = document.createElement('span');
    text.className = 'ocs-toast__text';
    text.textContent = message;
    toast.appendChild(text);

    const duration = typeof opts.duration === 'number' ? opts.duration : (opts.undo ? 5000 : 2400);

    if (opts.undo) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'ocs-toast__undo';
      undo.textContent = 'Undo';
      undo.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const gmailUndo = findGmailUndoButton();
        if (gmailUndo) {
          nativeClick(gmailUndo);
          showToast('Undo requested', 'info');
        } else {
          showToast('Gmail\'s undo is no longer available', 'warn');
        }
      });
      toast.appendChild(undo);
      toast.style.pointerEvents = 'auto';
    }

    document.body.appendChild(toast);
    if (reduced) toast.classList.add(TOAST_CLASS + '--visible');
    else raf(() => toast.classList.add(TOAST_CLASS + '--visible'));

    later(() => {
      toast.classList.remove(TOAST_CLASS + '--visible');
      later(() => toast.remove(), reduced ? 0 : 300);
    }, duration);
    return toast;
  }

  /**
   * Gmail-styled, non-destructive confirmation. Deliberately not window.confirm:
   * that blocks Gmail's event loop and cannot be styled or made accessible.
   * @returns {Promise<boolean>}
   */
  function showConfirmDialog(message) {
    return new Promise((resolve) => {
      if (!document.body) {
        resolve(false);
        return;
      }
      const previousFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = DIALOG_CLASS + '__overlay';
      if (prefersReducedMotion()) overlay.classList.add('ocs-reduce-motion');

      const dialog = document.createElement('div');
      dialog.className = DIALOG_CLASS + ' ocs-theme-' + detectTheme();
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'Confirm mark as spam');

      const title = document.createElement('h2');
      title.className = DIALOG_CLASS + '__title';
      title.textContent = 'Mark as spam?';

      const body = document.createElement('p');
      body.className = DIALOG_CLASS + '__body';
      body.textContent = message;

      const actions = document.createElement('div');
      actions.className = DIALOG_CLASS + '__actions';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = DIALOG_CLASS + '__button ' + DIALOG_CLASS + '__button--cancel';
      cancel.textContent = 'Cancel';

      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = DIALOG_CLASS + '__button ' + DIALOG_CLASS + '__button--confirm';
      confirm.textContent = 'Confirm';

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      dialog.appendChild(title);
      dialog.appendChild(body);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        try { if (previousFocus && previousFocus.focus) previousFocus.focus(); } catch (_) {}
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Tab') {
          // Minimal focus trap between the two buttons.
          e.preventDefault();
          (document.activeElement === confirm ? cancel : confirm).focus();
        }
      };
      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      try { confirm.focus(); } catch (_) {}
    });
  }

  // ---------------------------------------------------------------------------
  // The action (behaviour preserved from v1)
  // ---------------------------------------------------------------------------

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

  async function waitFor(finder, timeoutMs = 1500, intervalMs = 80) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = finder();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  async function spamAndDelete() {
    if (actionInFlight) return false;
    const spamBtn = findReportSpamButton();
    if (!spamBtn) {
      showToast(DISABLED_HINT, 'warn');
      return false;
    }
    actionInFlight = true;
    try {
      return await runSpamAndDelete(spamBtn);
    } catch (err) {
      showToast('Spam & Delete failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      return false;
    } finally {
      actionInFlight = false;
      updateWidgetState();
    }
  }

  async function runSpamAndDelete(spamBtn) {
    const threadBefore = getOpenThreadId();
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

    let deleted = false;
    let skippedDelete = false;
    if (settings.alsoDelete) {
      await sleep(450);
      // If a conversation was open when we reported spam but a DIFFERENT one is
      // open now (Gmail auto-advance), do NOT click Delete — it would trash an
      // unrelated email. Reporting spam already removed the target from the inbox.
      const threadNow = getOpenThreadId();
      if (advancedToOtherThread(threadBefore, threadNow)) {
        skippedDelete = true;
      } else {
        const delBtn = findDeleteButton();
        if (delBtn) {
          nativeClick(delBtn);
          deleted = true;
          // "Delete forever" pops its own "Delete this message permanently?" confirm.
          const confirmBtn = await waitFor(findDeleteForeverConfirm, 900);
          if (confirmBtn) {
            nativeClick(confirmBtn);
            await sleep(150);
          }
        } else {
          skippedDelete = true;
        }
      }
    }

    const parts = ['Marked as spam'];
    if (blocked) parts.push('sender blocked');
    if (deleted) parts.push('deleted');
    let message = parts.join(' & ');
    if (skippedDelete) message += ' — delete skipped (Gmail moved on)';
    showToast(message, skippedDelete ? 'warn' : 'success', { undo: true });
    return true;
  }

  async function handleAction() {
    const widget = getWidget();
    if (widget && widget.getAttribute('aria-disabled') === 'true' && !hasActionableTarget()) {
      showToast(DISABLED_HINT, 'warn');
      return false;
    }
    if (settings.confirmEachClick) {
      const ok = await showConfirmDialog(
        settings.alsoDelete
          ? 'This reports the selected email as spam and then deletes it.'
          : 'This reports the selected email as spam.'
      );
      if (!ok) return false;
    }
    return spamAndDelete();
  }

  // ---------------------------------------------------------------------------
  // Observers, listeners, lifecycle
  // ---------------------------------------------------------------------------

  /** Scoped observer on the toolbar container — never on document.body. */
  function observeToolbar() {
    const container = findToolbarContainer();
    if (!container) return false;
    if (toolbarObserver && deathObserver && observedToolbar === container) return true;
    if (toolbarObserver) toolbarObserver.disconnect();
    if (deathObserver) deathObserver.disconnect();
    observedToolbar = container;

    // Main observer on the toolbar itself — fires when children are added/removed
    // inside the toolbar (e.g. Gmail replaces Back/Archive controls).
    toolbarObserver = new MutationObserver(() => {
      scheduleReAnchor();
    });
    toolbarObserver.observe(container, { childList: true, subtree: true });

    // Death-watch observer on the toolbar's direct parent — fires when the
    // toolbar container itself is removed or replaced (childList on the parent
    // catches removals, while childList on the toolbar does not).
    if (container.parentNode) {
      deathObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (removed === container || removed.contains(container)) {
              observeToolbar();
              reAnchorWidget();
              return;
            }
          }
        }
      });
      deathObserver.observe(container.parentNode, { childList: true });
    }

    return true;
  }

  /**
   * Gmail boots its toolbar asynchronously, well after document_idle. This
   * observer exists only to catch that first paint and disconnects the moment
   * the widget is anchored, so no broad observer stays alive.
   */
  function startBootstrapObserver() {
    if (bootstrapObserver || !document.body) return;
    bootstrapObserver = new MutationObserver(() => {
      if (findBackButton()) {
        stopBootstrapObserver();
        reAnchorWidget();
      }
    });
    bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopBootstrapObserver() {
    if (!bootstrapObserver) return;
    bootstrapObserver.disconnect();
    bootstrapObserver = null;
  }

  function isEditableTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(el.isContentEditable);
  }

  /** Ctrl+Shift+S (Cmd+Shift+S on macOS) — mirrors the manifest `commands` entry. */
  function isShortcutEvent(e) {
    if (!e || e.repeat) return false;
    if (!e.shiftKey) return false;
    if (!(e.ctrlKey || e.metaKey)) return false;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    return key === 's';
  }

  function onGlobalKeydown(e) {
    if (!isShortcutEvent(e)) return;
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    handleAction();
  }

  function start() {
    if (started) return;
    started = true;

    loadSettings(() => {
      injectWidget();
      observeToolbar();
      if (placementStatus !== 'toolbar' && effectivePlacement() === 'toolbar') {
        startBootstrapObserver();
      }
    });
    watchStorage();

    // Gmail navigates via the URL hash; these fire on every view change and cost
    // nothing while idle — no polling, no intervals.
    on(window, 'hashchange', scheduleReAnchor);
    on(window, 'popstate', scheduleReAnchor);
    on(window, 'resize', scheduleReAnchor);

    // Event delegation: one capture-phase listener keeps the enabled/disabled
    // state in sync with the user's selection without any polling.
    on(document, 'click', scheduleReAnchor, true);
    on(document, 'keyup', scheduleReAnchor, true);
    on(document, 'keydown', onGlobalKeydown, true);

    const motionMq = safeMatchMedia('(prefers-reduced-motion: reduce)');
    if (motionMq && typeof motionMq.addEventListener === 'function') {
      const handler = () => applyPresentationClasses(getWidget());
      motionMq.addEventListener('change', handler);
      teardown.push(() => motionMq.removeEventListener('change', handler));
    }

    // Optional: a future background page can relay the manifest command.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        const msgHandler = (msg) => {
          if (msg && msg.type === 'ocs-spam-and-delete') handleAction();
        };
        chrome.runtime.onMessage.addListener(msgHandler);
        teardown.push(() => {
          try { chrome.runtime.onMessage.removeListener(msgHandler); } catch (_) {}
        });
      }
    } catch (_) {
      /* ignore */
    }

    on(window, 'pagehide', destroy);
    on(window, 'beforeunload', destroy);
  }

  function destroy() {
    if (toolbarObserver) toolbarObserver.disconnect();
    toolbarObserver = null;
    if (deathObserver) deathObserver.disconnect();
    deathObserver = null;
    observedToolbar = null;
    stopBootstrapObserver();
    cancelRaf(rafHandle);
    rafHandle = null;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    saveTimer = null;
    while (teardown.length) {
      const fn = teardown.pop();
      try { fn(); } catch (_) {}
    }
    removeToasts();
    removeWidget();
    started = false;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  const autostart = !(typeof window !== 'undefined' && window.__OCS_NO_AUTOSTART__);
  if (autostart) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  // Test hook. The content script runs in an isolated world, so this is not
  // reachable from the page; test/acceptance.js drives the module through it.
  window.__OCS__ = {
    DEFAULTS,
    WIDGET_ID,
    WIDGET_STYLES,
    PLACEMENT_MODES,
    observedToolbar: () => observedToolbar,
    start,
    destroy,
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => { settings = normalizeSettings({ ...settings, ...patch }); return { ...settings }; },
    normalizeSettings,
    normalizePosition,
    loadSettings,
    isUsable,
    isInsideEmailRow,
    isInsideEmailContent,
    findToolbarButton,
    findToolbarContainer,
    findBackButton,
    findArchiveButton,
    findReportSpamButton,
    findDeleteButton,
    findDeleteForeverConfirm,
    findReportSpamInDialog,
    findBlockSenderButton,
    findGmailUndoButton,
    getOpenThreadId,
    advancedToOtherThread,
    hasActionableTarget,
    detectTheme,
    prefersReducedMotion,
    createWidget,
    getWidget,
    removeWidget,
    injectWidget,
    injectToolbarWidget,
    injectFloatingWidget,
    resolveInsertionPoint,
    reAnchorWidget,
    isWidgetStale,
    effectivePlacement,
    getPlacementStatus,
    placementExplanation,
    toolbarSlots,
    currentSlotIndex,
    moveWidgetToSlot,
    handleToolbarDragTo,
    handleFloatingDragTo,
    applyPosition,
    updateWidgetState,
    showToast,
    showConfirmDialog,
    isShortcutEvent,
    observeToolbar,
    handleAction,
    runSpamAndDelete,
    nativeClick,
  };
})();
