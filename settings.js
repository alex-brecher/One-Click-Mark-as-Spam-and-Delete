/**
 * Settings schema shared by the content script and the popup.
 *
 * Loaded ahead of content.js (manifest content_scripts) and popup.js
 * (popup.html), so both read the same defaults and the same validation.
 * Exposes one global, OCS_SETTINGS; content scripts run in an isolated world,
 * so Gmail's page cannot see it.
 */
(function (root) {
  'use strict';

  const WIDGET_STYLES = ['gmail-icon', 'emphasized', 'compact', 'floating'];
  const PLACEMENT_MODES = ['toolbar', 'floating'];
  const BOOLEAN_KEYS = ['alsoDelete', 'autoBlockSender', 'confirmEachClick'];

  const DEFAULTS = Object.freeze({
    alsoDelete: true,
    autoBlockSender: true,
    confirmEachClick: false,
    widgetStyle: 'gmail-icon',
    placementMode: 'toolbar',
    // Polymorphic: {x, y} viewport pixels in floating placement, {slot: n} in
    // toolbar placement, null for "wherever the default is".
    fabPosition: null,
  });

  function normalizePosition(pos) {
    if (!pos || typeof pos !== 'object') return null;
    if (typeof pos.slot === 'number' && Number.isFinite(pos.slot)) {
      return { slot: Math.max(0, Math.round(pos.slot)) };
    }
    if (
      typeof pos.x === 'number' && Number.isFinite(pos.x) &&
      typeof pos.y === 'number' && Number.isFinite(pos.y)
    ) {
      return { x: pos.x, y: pos.y };
    }
    return null;
  }

  /** Returns a complete, valid settings object; bad or missing values fall back to defaults. */
  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
    }
    if (!WIDGET_STYLES.includes(next.widgetStyle)) next.widgetStyle = DEFAULTS.widgetStyle;
    if (!PLACEMENT_MODES.includes(next.placementMode)) next.placementMode = DEFAULTS.placementMode;
    for (const key of BOOLEAN_KEYS) {
      if (typeof next[key] !== 'boolean') next[key] = DEFAULTS[key];
    }
    next.fabPosition = normalizePosition(next.fabPosition);
    return next;
  }

  root.OCS_SETTINGS = Object.freeze({
    DEFAULTS,
    WIDGET_STYLES,
    PLACEMENT_MODES,
    BOOLEAN_KEYS,
    normalizePosition,
    normalizeSettings,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
