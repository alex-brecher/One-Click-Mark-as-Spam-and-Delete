/**
 * Acceptance tests for One-Click Mark as Spam & Delete.
 *
 * The content script is a browser IIFE, so every test builds a throwaway jsdom
 * "Gmail", evaluates content.js inside it with autostart disabled, and drives
 * the module through the `window.__OCS__` test hook.
 *
 * Run with `npm test`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const BACKGROUND_JS = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const POPUP_JS = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * jsdom performs no layout, so every getBoundingClientRect() would be 0x0 and
 * the extension's isUsable() guard would reject every element. Elements get a
 * default 24x24 box; `data-rect="left,top,width,height"` overrides it, which is
 * what the drag tests use to lay a toolbar out horizontally.
 */
function installLayout(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    let left = 0;
    let top = 0;
    let width = 24;
    let height = 24;
    const spec = this.getAttribute && this.getAttribute('data-rect');
    if (spec) {
      const parts = spec.split(',').map(Number);
      [left, top, width, height] = parts;
    }
    if (this.hasAttribute && this.hasAttribute('data-hidden')) {
      left = 0; top = 0; width = 0; height = 0;
    }
    return {
      left, top, width, height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() { return this; },
    };
  };
}

function installMatchMedia(window, matches) {
  window.matchMedia = (query) => ({
    media: query,
    matches: Boolean(matches && matches[query]),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
}

/** Minimal chrome.* mock that records every storage call for assertions. */
function makeChrome(initial) {
  const store = { ...(initial || {}) };
  const calls = { get: [], set: [], tabs: [] };
  const listeners = [];
  const messageListeners = [];
  const api = {
    storage: {
      sync: {
        get(defaults, cb) {
          calls.get.push(defaults);
          const out = { ...(defaults || {}) };
          for (const key of Object.keys(defaults || {})) {
            if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          }
          if (cb) cb(out);
        },
        set(patch, cb) {
          calls.set.push({ ...patch });
          Object.assign(store, patch);
          if (cb) cb();
        },
      },
      onChanged: {
        addListener(fn) { listeners.push(fn); },
        removeListener(fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) { messageListeners.push(fn); },
        removeListener(fn) {
          const i = messageListeners.indexOf(fn);
          if (i >= 0) messageListeners.splice(i, 1);
        },
      },
    },
    commands: {
      getAll(cb) { cb([{ name: 'spam-and-delete', shortcut: 'Ctrl+Shift+S' }]); },
    },
    tabs: {
      create(opts) { calls.tabs.push(opts); },
    },
  };
  return { api, store, calls, listeners, messageListeners };
}

/** Boots a jsdom "Gmail" page with content.js loaded but not auto-started. */
function boot(bodyHtml, opts = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  installLayout(window);
  installMatchMedia(window, opts.media);
  const chrome = makeChrome(opts.storage);
  window.chrome = chrome.api;
  window.__OCS_NO_AUTOSTART__ = true;
  window.eval(SETTINGS_JS);
  window.eval(CONTENT_JS);
  const api = window.__OCS__;
  assert.ok(api, 'content.js should expose the __OCS__ test hook');
  if (opts.settings) api.setSettings(opts.settings);
  return { dom, window, document: window.document, api, chrome };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Values produced inside jsdom carry that realm's Object/Array prototypes, so
 * assert.deepStrictEqual would reject them on prototype identity alone. Round
 * them through JSON to compare structure in this realm.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Gmail DOM fixtures
// ---------------------------------------------------------------------------

/** Flat toolbar: Back and Archive are true siblings. */
const FLAT_TOOLBAR = `
  <div gh="mtb" class="G-atb" id="toolbar">
    <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
    <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
    <div id="spam" role="button" aria-label="Report spam" data-rect="100,0,40,40"></div>
    <div id="del" role="button" aria-label="Delete" data-rect="150,0,40,40"></div>
  </div>
`;

/** Wrapped toolbar: each control sits in its own div, like real Gmail. */
const WRAPPED_TOOLBAR = `
  <div gh="mtb" class="G-atb" id="toolbar">
    <div class="wrap" id="backWrap"><div id="back" role="button" guidedhelpid="backButton" data-rect="0,0,40,40"></div></div>
    <div class="wrap" id="archiveWrap"><div id="archive" role="button" act="8" data-rect="50,0,40,40"></div></div>
    <div class="wrap"><div id="spam" role="button" aria-label="Report spam" data-rect="100,0,40,40"></div></div>
  </div>
`;

/** An inbox list row, whose hover buttons share the toolbar's aria-labels. */
const EMAIL_ROW = `
  <tr class="zA" id="row">
    <td><div id="rowSpam" role="button" aria-label="Report spam" data-rect="400,200,20,20"></div></td>
    <td><div id="rowDelete" role="button" aria-label="Delete" data-rect="430,200,20,20"></div></td>
  </tr>
`;

/** Rendered message content — never safe to auto-click into. */
const EMAIL_BODY = `
  <div class="a3s" id="messageBody">
    <div id="fakeBlock" role="button" data-rect="300,300,80,20">Yes, block</div>
    <div id="fakeDelete" role="button" aria-label="Delete" data-rect="300,330,80,20">Delete</div>
  </div>
`;

// ---------------------------------------------------------------------------
// Test registry
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. Back detection -----------------------------------------------------

test('1. findBackButton() resolves the Back to Inbox control', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  assert.strictEqual(api.findBackButton(), document.getElementById('back'));
});

test('1b. findBackButton() falls back to guidedhelpid and data-tooltip', () => {
  const guided = boot('<div gh="mtb"><div id="back" guidedhelpid="backButton"></div></div>');
  assert.strictEqual(guided.api.findBackButton(), guided.document.getElementById('back'));

  const tooltip = boot('<div gh="mtb"><div id="back" data-tooltip="Back to Starred"></div></div>');
  assert.strictEqual(tooltip.api.findBackButton(), tooltip.document.getElementById('back'));

  const none = boot('<div gh="mtb"><div id="other" aria-label="Snooze"></div></div>');
  assert.strictEqual(none.api.findBackButton(), null);
});

test('1c. findBackButton() ignores hidden and per-row controls', () => {
  const { api, document } = boot(`
    <div gh="mtb">
      <div id="hiddenBack" aria-label="Back to Inbox" data-hidden="1"></div>
    </div>
    <table><tbody><tr class="zA"><td><div id="rowBack" aria-label="Back to Inbox"></div></td></tr></tbody></table>
  `);
  assert.strictEqual(api.findBackButton(), null);
  assert.ok(document.getElementById('rowBack'), 'fixture sanity');
});

// --- 2. Archive detection --------------------------------------------------

test('2. findArchiveButton() resolves Archive via aria-label and act codes', () => {
  const labelled = boot(FLAT_TOOLBAR);
  assert.strictEqual(labelled.api.findArchiveButton(), labelled.document.getElementById('archive'));

  const act7 = boot('<div gh="mtb"><div id="archive" act="7"></div></div>');
  assert.strictEqual(act7.api.findArchiveButton(), act7.document.getElementById('archive'));

  const act8 = boot('<div gh="mtb"><div id="archive" act="8"></div></div>');
  assert.strictEqual(act8.api.findArchiveButton(), act8.document.getElementById('archive'));

  const tooltip = boot('<div gh="mtb"><div id="archive" data-tooltip="Archive"></div></div>');
  assert.strictEqual(tooltip.api.findArchiveButton(), tooltip.document.getElementById('archive'));
});

test('2b. findToolbarContainer() resolves the shared toolbar ancestor', () => {
  const flat = boot(FLAT_TOOLBAR);
  assert.strictEqual(flat.api.findToolbarContainer(), flat.document.getElementById('toolbar'));

  const wrapped = boot(WRAPPED_TOOLBAR);
  assert.strictEqual(wrapped.api.findToolbarContainer(), wrapped.document.getElementById('toolbar'));

  const empty = boot('<div id="nothing"></div>');
  assert.strictEqual(empty.api.findToolbarContainer(), null);
});

// --- 3. Toolbar insertion --------------------------------------------------

test('3. widget is inserted between Back and Archive', () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  assert.strictEqual(api.injectToolbarWidget(), true);

  const widget = document.getElementById(api.WIDGET_ID);
  const back = document.getElementById('back');
  const archive = document.getElementById('archive');

  assert.ok(widget, 'widget exists');
  assert.strictEqual(widget.parentNode, back.parentNode, 'sibling insertion');
  assert.strictEqual(back.nextElementSibling, widget, 'directly after Back');
  assert.strictEqual(widget.nextElementSibling, archive, 'directly before Archive');
  assert.ok(
    back.compareDocumentPosition(widget) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'document order is Back -> widget'
  );
  assert.ok(
    widget.compareDocumentPosition(archive) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'document order is widget -> Archive'
  );
  assert.strictEqual(api.getPlacementStatus(), 'toolbar');
});

test('3b. widget lands between the wrapper subtrees in a nested toolbar', () => {
  const { api, document, window } = boot(WRAPPED_TOOLBAR);
  assert.strictEqual(api.injectToolbarWidget(), true);

  const widget = document.getElementById(api.WIDGET_ID);
  const backWrap = document.getElementById('backWrap');
  const archiveWrap = document.getElementById('archiveWrap');

  assert.strictEqual(widget.parentNode, document.getElementById('toolbar'));
  assert.strictEqual(widget.nextElementSibling, archiveWrap);
  assert.ok(
    backWrap.compareDocumentPosition(widget) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'still ordered after Back'
  );
});

test('3c. with Back but no Archive the widget sits right after Back', () => {
  const { api, document } = boot('<div gh="mtb"><div id="back" aria-label="Back to Inbox"></div><div id="x"></div></div>');
  assert.strictEqual(api.injectToolbarWidget(), true);
  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(document.getElementById('back').nextElementSibling, widget);
});

// --- 4. Layout variants ----------------------------------------------------

test('4. insertion works across attribute layout variants', () => {
  const variants = [
    {
      name: 'aria-label pair',
      html: '<div gh="mtb"><div id="back" aria-label="Back to Inbox"></div><div id="archive" aria-label="Archive"></div></div>',
    },
    {
      name: 'guidedhelpid + act=7',
      html: '<div gh="mtb"><div id="back" guidedhelpid="backButton"></div><div id="archive" act="7"></div></div>',
    },
    {
      name: 'data-tooltip + act=8',
      html: '<div class="G-atb"><div id="back" data-tooltip="Back to Inbox"></div><div id="archive" act="8"></div></div>',
    },
    {
      name: 'role=toolbar + data-tooltip Archive',
      html: '<div role="toolbar"><div id="back" aria-label="Back to search results"></div><div id="archive" data-tooltip="Archive"></div></div>',
    },
  ];

  for (const variant of variants) {
    const { api, document } = boot(variant.html);
    assert.strictEqual(api.injectToolbarWidget(), true, variant.name + ': injected');
    const widget = document.getElementById(api.WIDGET_ID);
    assert.strictEqual(document.getElementById('back').nextElementSibling, widget, variant.name + ': after Back');
    assert.strictEqual(widget.nextElementSibling, document.getElementById('archive'), variant.name + ': before Archive');
  }
});

// --- 5. Re-anchoring -------------------------------------------------------

test('5. reAnchorWidget() re-inserts after a Gmail toolbar re-render', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  assert.ok(document.getElementById(api.WIDGET_ID));

  // Gmail blows away and rebuilds the toolbar; our widget goes with it.
  const toolbar = document.getElementById('toolbar');
  toolbar.innerHTML = `
    <div id="back" role="button" aria-label="Back to Inbox"></div>
    <div id="archive" role="button" aria-label="Archive"></div>
  `;
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'widget was destroyed by the re-render');
  assert.strictEqual(api.isWidgetStale(), true);

  assert.strictEqual(api.reAnchorWidget(), true);
  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget, 're-anchored');
  assert.strictEqual(document.getElementById('back').nextElementSibling, widget);
  assert.strictEqual(widget.nextElementSibling, document.getElementById('archive'));
  assert.strictEqual(api.isWidgetStale(), false);
  assert.strictEqual(document.querySelectorAll('#' + api.WIDGET_ID).length, 1);
});

test('5b. a widget moved out of the toolbar is detected as stale', () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div id="elsewhere"></div>');
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  document.getElementById('elsewhere').appendChild(widget);
  assert.strictEqual(api.isWidgetStale(), true);
  api.reAnchorWidget();
  assert.strictEqual(document.getElementById('back').nextElementSibling, document.getElementById(api.WIDGET_ID));
});

test('5c. observers are scoped to the toolbar and its parent, not document.body', () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  const observed = [];
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = function (cb) {
    const inner = new NativeObserver(cb);
    return {
      observe(target, opts) { observed.push({ target, opts }); inner.observe(target, opts); },
      disconnect() { inner.disconnect(); },
      takeRecords() { return inner.takeRecords(); },
    };
  };
  api.injectWidget();
  assert.strictEqual(api.observeToolbar(), true);
  assert.ok(observed.length >= 1, 'an observer was installed');
  const toolbar = document.getElementById('toolbar');
  assert.ok(toolbar, 'toolbar exists');

  // The primary (childList+subtree) observer must be on the toolbar itself,
  // never on document.body.  The death-watch (childList only) observer is on
  // the toolbar's parent, which in the test fixture is document.body —
  // that is acceptable because it watches only childList with no subtree.
  const mainObs = observed.find(o => o.opts.childList === true && o.opts.subtree === true);
  const deathObs = observed.find(o => o.opts.childList === true && !o.opts.subtree);

  assert.ok(mainObs, 'main toolbar observer present');
  assert.strictEqual(mainObs.target, toolbar, 'main observer is on the toolbar');
  assert.strictEqual(mainObs.target, document.getElementById('toolbar'));
  assert.notStrictEqual(mainObs.target, document.body, 'main observer never on document.body');

  assert.ok(deathObs, 'death-watch observer present');
  assert.strictEqual(deathObs.target, toolbar.parentNode, 'death observer on toolbar parent');
  assert.ok(!deathObs.opts.subtree, 'death observer has no subtree');
});

// --- 6. Fallback -----------------------------------------------------------

test('6. floating fallback activates when no toolbar can be resolved', () => {
  const { api, document } = boot('<div id="app">No Gmail toolbar here</div>');
  assert.strictEqual(api.effectivePlacement(), 'toolbar', 'user still prefers the toolbar');
  assert.strictEqual(api.injectWidget(), true);

  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget);
  assert.strictEqual(widget.parentNode, document.body);
  assert.strictEqual(api.getPlacementStatus(), 'fallback');
  assert.ok(widget.classList.contains('ocs-placement--floating'));
  assert.ok(widget.classList.contains('ocs-widget--fallback'));

  // The reason is explained visibly, not just implied by styling.
  const explanation = api.placementExplanation();
  assert.match(explanation, /toolbar not found/i);
  assert.ok(widget.getAttribute('aria-label').includes(explanation), 'aria-label explains the fallback');
  const toast = document.querySelector('.ocs-toast');
  assert.ok(toast && /toolbar not found/i.test(toast.textContent), 'a status toast explains the fallback');
});

test('6b. explicit floating placement is not treated as a fallback', () => {
  const { api, document } = boot(FLAT_TOOLBAR, { settings: { placementMode: 'floating' } });
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(api.getPlacementStatus(), 'floating');
  assert.ok(widget.classList.contains('ocs-placement--floating'));
  assert.ok(!widget.classList.contains('ocs-widget--fallback'));
  assert.strictEqual(api.placementExplanation(), '');
});

// --- 7. Style selection ----------------------------------------------------

test('7. each widgetStyle produces its own DOM classes', () => {
  const { api } = boot(FLAT_TOOLBAR);
  assert.deepStrictEqual(plain(api.WIDGET_STYLES), ['gmail-icon', 'emphasized', 'compact', 'floating']);

  for (const style of api.WIDGET_STYLES) {
    const el = api.createWidget(style);
    assert.strictEqual(el.id, api.WIDGET_ID);
    assert.ok(el.classList.contains('ocs-widget'), style + ': base class');
    assert.ok(el.classList.contains('ocs-widget--' + style), style + ': variant class');
    assert.strictEqual(el.dataset.ocsStyle, style);
    assert.strictEqual(el.getAttribute('role'), 'button');
    assert.strictEqual(el.getAttribute('tabindex'), '0');
    assert.ok(el.getAttribute('aria-label'), style + ': has an aria-label');
    assert.ok(el.querySelector('svg'), style + ': has an icon');
  }

  const compact = api.createWidget('compact');
  assert.strictEqual(compact.querySelector('.ocs-widget__label').textContent, 'Spam');
  assert.strictEqual(api.createWidget('gmail-icon').querySelector('.ocs-widget__label'), null);
  assert.ok(api.createWidget('nonsense').classList.contains('ocs-widget--gmail-icon'), 'unknown style falls back');
});

test('7b. switching style re-builds the widget in place', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  assert.ok(document.getElementById(api.WIDGET_ID).classList.contains('ocs-widget--gmail-icon'));

  api.setSettings({ widgetStyle: 'emphasized' });
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget.classList.contains('ocs-widget--emphasized'));
  assert.ok(!widget.classList.contains('ocs-widget--gmail-icon'));
  assert.strictEqual(document.querySelectorAll('.ocs-widget').length, 1);

  // The classic FAB style implies floating placement even in toolbar mode.
  api.setSettings({ widgetStyle: 'floating', placementMode: 'toolbar' });
  assert.strictEqual(api.effectivePlacement(), 'floating');
  api.injectWidget();
  assert.strictEqual(document.getElementById(api.WIDGET_ID).parentNode, document.body);
});

// --- 8. Drag placement -----------------------------------------------------

test('8. toolbar drag is horizontal-only and slot-constrained', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  const toolbar = document.getElementById('toolbar');

  assert.strictEqual(api.handleToolbarDragTo.length, 1, 'drag handler takes clientX only');
  assert.strictEqual(api.toolbarSlots().length, 4);
  assert.strictEqual(api.currentSlotIndex(), 1, 'starts between Back and Archive');

  // Drag left of Back's midpoint (x=20).
  assert.strictEqual(api.handleToolbarDragTo(5), 0);
  assert.strictEqual(toolbar.firstElementChild, widget);

  // Drag past every midpoint -> last slot.
  assert.strictEqual(api.handleToolbarDragTo(900), 4);
  assert.strictEqual(toolbar.lastElementChild, widget);

  // Vertical never applies: no free coordinates are ever written, and the
  // widget never leaves the toolbar row.
  assert.strictEqual(widget.style.left, '');
  assert.strictEqual(widget.style.top, '');
  assert.strictEqual(widget.parentNode, toolbar);

  // Slot index is clamped to the available slots.
  assert.strictEqual(api.moveWidgetToSlot(99), 4);
  assert.strictEqual(api.moveWidgetToSlot(-5), 0);
});

test('8b. keyboard Ctrl+Arrow moves the widget one slot at a time', () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(api.currentSlotIndex(), 1);

  const press = (key) => widget.dispatchEvent(new window.KeyboardEvent('keydown', {
    key, ctrlKey: true, bubbles: true, cancelable: true,
  }));

  press('ArrowRight');
  assert.strictEqual(api.currentSlotIndex(), 2);
  press('ArrowLeft');
  press('ArrowLeft');
  assert.strictEqual(api.currentSlotIndex(), 0);
  assert.strictEqual(widget.style.top, '', 'still no vertical movement');
});

test('8c. floating drag is free but clamped to the viewport', () => {
  const { api, document } = boot('<div id="app"></div>', { settings: { placementMode: 'floating' } });
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);

  const pos = api.handleFloatingDragTo(120, 240);
  assert.deepStrictEqual(plain(pos), { x: 120, y: 240 });
  assert.strictEqual(widget.style.left, '120px');
  assert.strictEqual(widget.style.top, '240px');

  const clamped = api.handleFloatingDragTo(99999, 99999);
  assert.ok(clamped.x < 99999 && clamped.y < 99999, 'clamped into the viewport');
  assert.ok(clamped.x > 0 && clamped.y > 0);
});

// --- 9. Persistence / reset ------------------------------------------------

test('9. settings load from chrome.storage.sync and normalize bad values', () => {
  const { api, chrome } = boot(FLAT_TOOLBAR, {
    storage: { alsoDelete: false, widgetStyle: 'compact', placementMode: 'floating' },
  });
  api.loadSettings();
  assert.deepStrictEqual(plain(chrome.calls.get[0]), plain(api.DEFAULTS), 'get() is called with the default schema');

  const loaded = api.getSettings();
  assert.strictEqual(loaded.alsoDelete, false);
  assert.strictEqual(loaded.widgetStyle, 'compact');
  assert.strictEqual(loaded.placementMode, 'floating');
  assert.strictEqual(loaded.autoBlockSender, true, 'unset keys keep their defaults');

  const bad = api.normalizeSettings({ widgetStyle: 'nope', placementMode: 'nope', fabPosition: 'nope' });
  assert.strictEqual(bad.widgetStyle, 'gmail-icon');
  assert.strictEqual(bad.placementMode, 'toolbar');
  assert.strictEqual(bad.fabPosition, null);
  assert.deepStrictEqual(plain(api.normalizePosition({ slot: 2.4 })), { slot: 2 });
  assert.deepStrictEqual(plain(api.normalizePosition({ x: 10, y: 20 })), { x: 10, y: 20 });
  assert.strictEqual(api.normalizePosition({ x: Infinity, y: 20 }), null);
  assert.strictEqual(api.normalizePosition({ x: NaN, y: 20 }), null);
  const wrongTypes = api.normalizeSettings({ alsoDelete: 'false', unexpected: 'value' });
  assert.strictEqual(wrongTypes.alsoDelete, true, 'invalid booleans use the documented default');
  assert.ok(!Object.prototype.hasOwnProperty.call(wrongTypes, 'unexpected'), 'unknown settings are removed');

  assert.deepStrictEqual(plain(Object.keys(api.DEFAULTS).sort()), [
    'alsoDelete', 'autoBlockSender', 'confirmEachClick', 'fabPosition', 'placementMode', 'widgetStyle',
  ]);
});

test('9b. a drag writes its position back to storage, debounced', async () => {
  const { api, chrome } = boot(FLAT_TOOLBAR, { settings: { placementMode: 'floating' } });
  api.injectWidget();

  api.handleFloatingDragTo(100, 100);
  api.handleFloatingDragTo(140, 160);
  api.handleFloatingDragTo(180, 200);
  assert.deepStrictEqual(plain(api.getSettings().fabPosition), { x: 180, y: 200 }, 'position updates in memory');
  assert.strictEqual(chrome.calls.set.length, 0, 'nothing written mid-drag');

  await wait(420);
  assert.strictEqual(chrome.calls.set.length, 1, 'one coalesced write');
  assert.deepStrictEqual(plain(chrome.calls.set[0]), { fabPosition: { x: 180, y: 200 } });
  api.destroy();
});

test('9c. a saved toolbar slot is restored on injection', () => {
  const { api, document } = boot(FLAT_TOOLBAR, { storage: { fabPosition: { slot: 3 } } });
  api.loadSettings();
  api.injectWidget();
  assert.strictEqual(api.currentSlotIndex(), 3);
  assert.ok(document.getElementById(api.WIDGET_ID));
});

test('9c2. an intentional toolbar move is not undone by the re-anchor observer', async () => {
  const { api } = boot(FLAT_TOOLBAR);
  api.start();
  api.moveWidgetToSlot(4);
  assert.strictEqual(api.currentSlotIndex(), 4);
  assert.deepStrictEqual(plain(api.getSettings().fabPosition), { slot: 4 });
  await wait(120);
  assert.strictEqual(api.currentSlotIndex(), 4, 'observer keeps the user-selected slot');
  assert.strictEqual(api.isWidgetStale(), false);
  api.destroy();
});

test('9c3. a saved slot is restored after Gmail inserts another toolbar control', async () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.start();
  api.moveWidgetToSlot(3);
  const added = document.createElement('div');
  added.id = 'new-control';
  document.getElementById('toolbar').insertBefore(added, document.getElementById(api.WIDGET_ID));
  assert.strictEqual(api.isWidgetStale(), true);
  await wait(120);
  assert.strictEqual(api.currentSlotIndex(), 3);
  api.destroy();
});

test('9d. popup renders settings, saves changes, and resets to defaults', () => {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  installLayout(window);
  installMatchMedia(window, {});
  const chrome = makeChrome({ widgetStyle: 'compact', alsoDelete: false });
  window.chrome = chrome.api;
  window.eval(SETTINGS_JS);
  window.eval(POPUP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const doc = window.document;
  assert.strictEqual(doc.getElementById('alsoDelete').checked, false, 'stored value rendered');
  assert.strictEqual(doc.getElementById('autoBlockSender').checked, true, 'default rendered');
  assert.strictEqual(doc.querySelector('input[name="widgetStyle"][value="compact"]').checked, true);
  assert.strictEqual(doc.querySelector('input[name="placementMode"][value="toolbar"]').checked, true);
  assert.strictEqual(doc.getElementById('shortcut').textContent, 'Ctrl+Shift+S');
  doc.getElementById('customizeShortcut').click();
  assert.deepStrictEqual(plain(chrome.calls.tabs.pop()), { url: 'chrome://extensions/shortcuts' });

  // Every one of the four styles and both placements has a control.
  assert.strictEqual(doc.querySelectorAll('input[name="widgetStyle"]').length, 4);
  assert.strictEqual(doc.querySelectorAll('input[name="placementMode"]').length, 2);

  const emphasized = doc.querySelector('input[name="widgetStyle"][value="emphasized"]');
  emphasized.checked = true;
  emphasized.dispatchEvent(new window.Event('change'));
  assert.deepStrictEqual(plain(chrome.calls.set.pop()), { widgetStyle: 'emphasized', fabPosition: null });

  const alsoDelete = doc.getElementById('alsoDelete');
  alsoDelete.checked = true;
  alsoDelete.dispatchEvent(new window.Event('change'));
  assert.deepStrictEqual(plain(chrome.calls.set.pop()), { alsoDelete: true });

  doc.getElementById('resetDefaults').dispatchEvent(new window.Event('click'));
  const reset = plain(chrome.calls.set.pop());
  assert.deepStrictEqual(reset, {
    alsoDelete: true,
    autoBlockSender: true,
    confirmEachClick: false,
    widgetStyle: 'gmail-icon',
    placementMode: 'toolbar',
    fabPosition: null,
  });
  assert.strictEqual(doc.querySelector('input[name="widgetStyle"][value="gmail-icon"]').checked, true);
});

// --- 10. Theme detection ---------------------------------------------------

test('10. theme follows Gmail chrome, then the system preference', () => {
  const light = boot('<div gh="mtb" id="toolbar" style="background-color: #ffffff"></div>');
  assert.strictEqual(light.api.detectTheme(), 'light');

  const dark = boot('<div gh="mtb" id="toolbar" style="background-color: rgb(32, 33, 36)"></div>');
  assert.strictEqual(dark.api.detectTheme(), 'dark');

  // No usable Gmail colour -> matchMedia decides.
  const systemDark = boot('<div id="app"></div>', { media: { '(prefers-color-scheme: dark)': true } });
  assert.strictEqual(systemDark.api.detectTheme(), 'dark');

  const systemLight = boot('<div id="app"></div>', { media: {} });
  assert.strictEqual(systemLight.api.detectTheme(), 'light');
});

test('10b. the theme class lands on the widget', () => {
  const dark = boot('<div gh="mtb" id="toolbar" style="background-color: rgb(32, 33, 36)"><div aria-label="Back to Inbox" id="back"></div></div>');
  dark.api.injectWidget();
  const widget = dark.document.getElementById(dark.api.WIDGET_ID);
  assert.ok(widget.classList.contains('ocs-theme-dark'));
  assert.ok(!widget.classList.contains('ocs-theme-light'));
});

// --- 11. Reduced motion ----------------------------------------------------

test('11. prefers-reduced-motion disables transitions on injected UI', () => {
  const reduced = boot(FLAT_TOOLBAR, { media: { '(prefers-reduced-motion: reduce)': true } });
  assert.strictEqual(reduced.api.prefersReducedMotion(), true);
  reduced.api.injectWidget();
  const widget = reduced.document.getElementById(reduced.api.WIDGET_ID);
  assert.ok(widget.classList.contains('ocs-reduce-motion'));

  const toast = reduced.api.showToast('hello', 'info');
  assert.ok(toast.classList.contains('ocs-reduce-motion'));
  assert.ok(toast.classList.contains('ocs-toast--visible'), 'shown immediately, without an animation frame');
  reduced.api.destroy();

  const normal = boot(FLAT_TOOLBAR, { media: {} });
  assert.strictEqual(normal.api.prefersReducedMotion(), false);
  normal.api.injectWidget();
  assert.ok(!normal.document.getElementById(normal.api.WIDGET_ID).classList.contains('ocs-reduce-motion'));
  normal.api.destroy();
});

// --- 12. Action safety -----------------------------------------------------

test('12. isInsideEmailContent / isInsideEmailRow guards', () => {
  const { api, document } = boot(`<table><tbody>${EMAIL_ROW}</tbody></table>` + EMAIL_BODY);

  assert.strictEqual(api.isInsideEmailContent(document.getElementById('fakeBlock')), true);
  assert.strictEqual(api.isInsideEmailContent(document.getElementById('messageBody')), true);
  assert.strictEqual(api.isInsideEmailContent(document.getElementById('rowSpam')), false);
  assert.strictEqual(api.isInsideEmailContent(null), false);

  assert.strictEqual(api.isInsideEmailRow(document.getElementById('rowSpam')), true);
  assert.strictEqual(api.isInsideEmailRow(document.getElementById('row')), true);
  assert.strictEqual(api.isInsideEmailRow(document.getElementById('fakeBlock')), false);
  assert.strictEqual(api.isInsideEmailRow(null), false);
});

test('12b. toolbar finders never return per-row hover buttons or email content', () => {
  const { api, document } = boot(FLAT_TOOLBAR + `<table><tbody>${EMAIL_ROW}</tbody></table>` + EMAIL_BODY);
  assert.strictEqual(api.findReportSpamButton(), document.getElementById('spam'));
  assert.strictEqual(api.findDeleteButton(), document.getElementById('del'));

  // With only per-row and in-message buttons available, nothing is returned.
  const rowsOnly = boot(`<table><tbody>${EMAIL_ROW}</tbody></table>` + EMAIL_BODY);
  assert.strictEqual(rowsOnly.api.findReportSpamButton(), null);
  assert.strictEqual(rowsOnly.api.findDeleteButton(), null);
});

test('12c. isUsable() rejects invisible, disabled and zero-size elements', () => {
  const { api, document } = boot(`
    <div gh="mtb">
      <div id="ok" aria-label="Report spam"></div>
      <div id="zero" aria-label="Report spam" data-hidden="1"></div>
      <div id="none" aria-label="Report spam" style="display: none"></div>
      <div id="invisible" aria-label="Report spam" style="visibility: hidden"></div>
      <div id="disabled" aria-label="Report spam" aria-disabled="true"></div>
      <div id="inert" aria-label="Report spam" style="pointer-events: none"></div>
    </div>
  `);
  assert.strictEqual(api.isUsable(document.getElementById('ok')), true);
  for (const id of ['zero', 'none', 'invisible', 'disabled', 'inert']) {
    assert.strictEqual(api.isUsable(document.getElementById(id)), false, id + ' is not usable');
  }
  assert.strictEqual(api.isUsable(null), false);
  assert.strictEqual(api.findReportSpamButton(), document.getElementById('ok'));
});

test('12d. Delete forever is accepted, and its confirm is scoped to a dialog', () => {
  const { api, document } = boot(`
    <div gh="mtb"><div id="del" aria-label="Delete forever"></div></div>
    <div role="alertdialog" id="confirm">
      <p>Delete this message permanently?</p>
      <button id="ok">OK</button>
    </div>
  `);
  assert.strictEqual(api.findDeleteButton(), document.getElementById('del'));
  assert.strictEqual(api.findDeleteForeverConfirm(), document.getElementById('ok'));
});

// --- 13. Dialog isolation --------------------------------------------------

test('13. auto-confirm only fires inside role=dialog containers', () => {
  const inDialog = boot(`
    <div role="dialog" id="dlg"><div id="block" role="button">Yes, block</div></div>
  `);
  assert.strictEqual(inDialog.api.findBlockSenderButton(), inDialog.document.getElementById('block'));

  // The same markup planted by a malicious email must never be clicked.
  const inEmail = boot(EMAIL_BODY);
  assert.strictEqual(inEmail.api.findBlockSenderButton(), null);

  // ...not even when the email wraps it in its own fake dialog.
  const fakeDialog = boot('<div class="a3s"><div role="dialog"><div role="button">Yes, block</div></div></div>');
  assert.strictEqual(fakeDialog.api.findBlockSenderButton(), null);

  // A loose button in the page body is not a dialog either.
  const loose = boot('<div role="button">Yes, block</div>');
  assert.strictEqual(loose.api.findBlockSenderButton(), null);
});

test('13a. the block-sender dismiss control must share the verified prompt', () => {
  const { api, document } = boot(`
    <div role="dialog" id="prompt">
      <button id="accept">Yes, block</button>
      <button id="dismiss">No, thanks</button>
    </div>
    <div role="dialog"><button id="unrelated">Cancel</button></div>
  `);
  const prompt = api.findBlockSenderPrompt();
  assert.strictEqual(prompt.accept, document.getElementById('accept'));
  assert.strictEqual(prompt.dismiss, document.getElementById('dismiss'));
  assert.strictEqual(prompt.blocking, true);
  assert.strictEqual(api.findBlockSenderDismissButton(), document.getElementById('dismiss'));
  assert.notStrictEqual(api.findBlockSenderDismissButton(), document.getElementById('unrelated'));
});

test('13b. the report-spam pre-confirm requires both Report spam and Unsubscribe', () => {
  const both = boot(`
    <div role="dialog">
      <button id="report">Report spam</button>
      <button id="unsub">Unsubscribe</button>
    </div>
  `);
  assert.strictEqual(both.api.findReportSpamInDialog(), both.document.getElementById('report'));

  const onlyReport = boot('<div role="dialog"><button id="report">Report spam</button></div>');
  assert.strictEqual(onlyReport.api.findReportSpamInDialog(), null);

  const alertNotDialog = boot('<div role="alert"><button>Report spam</button><button>Unsubscribe</button></div>');
  assert.strictEqual(alertNotDialog.api.findReportSpamInDialog(), null);
});

test('13c. our own dialog and toast are never treated as Gmail UI', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.showConfirmDialog('Are you sure?');
  const ours = document.querySelector('.ocs-dialog');
  assert.ok(ours, 'our dialog rendered');
  assert.strictEqual(ours.getAttribute('role'), 'dialog');
  assert.strictEqual(ours.getAttribute('aria-modal'), 'true');
  assert.strictEqual(api.findBlockSenderButton(), null);
  assert.strictEqual(api.findReportSpamInDialog(), null);
  assert.strictEqual(api.findReportSpamButton(), document.getElementById('spam'), 'Gmail controls still resolve');
});

test('13d. the confirmation dialog resolves without touching Gmail', async () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  let clicked = 0;
  document.getElementById('spam').addEventListener('click', () => { clicked += 1; });

  const cancelled = api.showConfirmDialog('Really?');
  document.querySelector('.ocs-dialog__button--cancel').click();
  assert.strictEqual(await cancelled, false);
  assert.strictEqual(document.querySelector('.ocs-dialog'), null, 'dialog removed');

  const confirmed = api.showConfirmDialog('Really?');
  document.querySelector('.ocs-dialog__button--confirm').click();
  assert.strictEqual(await confirmed, true);
  assert.strictEqual(clicked, 0, 'the dialog itself never acts on Gmail');
});

// --- 14. Selection / open-thread protection --------------------------------

test('14. the thread-id guard skips Delete after Gmail auto-advances', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div id="thread" data-thread-perm-id="thread-a"></div>', {
    settings: { alsoDelete: true, autoBlockSender: false, confirmEachClick: false },
  });
  assert.strictEqual(api.getOpenThreadId(), 'thread-a');
  assert.strictEqual(api.advancedToOtherThread('a', 'b'), true);
  assert.strictEqual(api.advancedToOtherThread('a', 'a'), false);
  assert.strictEqual(api.advancedToOtherThread(null, 'b'), false, 'list view is not an auto-advance');

  let deleted = 0;
  document.getElementById('del').addEventListener('click', () => { deleted += 1; });
  // Gmail auto-advance: reporting spam opens the *next* conversation.
  document.getElementById('spam').addEventListener('click', () => {
    document.getElementById('thread').setAttribute('data-thread-perm-id', 'thread-b');
  });

  await api.runSpamAndDelete(document.getElementById('spam'));
  assert.strictEqual(deleted, 0, 'Delete must not fire on the newly-opened thread');
  const toast = document.querySelector('.ocs-toast');
  assert.match(toast.textContent, /delete skipped/i, 'the skip is reported explicitly');
  api.destroy();
});

test('14a. hidden stale thread IDs do not defeat the active-thread guard', () => {
  const { api } = boot(`
    <div data-thread-perm-id="thread-old" data-hidden="1"></div>
    <div data-thread-perm-id="thread-current"></div>
  `);
  assert.strictEqual(api.getOpenThreadId(), 'thread-current');
});

test('14b. widget is disabled with an explanatory label when nothing is selected', () => {
  const { api, document } = boot(`
    <div gh="mtb" id="toolbar">
      <div id="back" aria-label="Back to Inbox"></div>
      <div id="archive" aria-label="Archive"></div>
    </div>
  `);
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(api.hasActionableTarget(), false);
  assert.strictEqual(api.updateWidgetState(), false);
  assert.strictEqual(widget.getAttribute('aria-disabled'), 'true');
  assert.ok(widget.classList.contains('ocs-widget--disabled'));
  assert.match(widget.getAttribute('aria-label'), /unavailable/i, 'state is not conveyed by colour alone');
  assert.strictEqual(widget.title, widget.getAttribute('aria-label'));

  // Checking a row makes it actionable again.
  const row = document.createElement('div');
  row.setAttribute('role', 'row');
  row.setAttribute('jslog', '1:["#thread-f:123"]');
  const box = document.createElement('div');
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', 'true');
  row.appendChild(box);
  document.body.appendChild(row);
  assert.strictEqual(api.hasActionableTarget(), true);
  assert.strictEqual(api.updateWidgetState(), true);
  assert.strictEqual(widget.getAttribute('aria-disabled'), 'false');
  assert.ok(!widget.classList.contains('ocs-widget--disabled'));
});

test('14b2. changed row selection skips Delete instead of acting on another message', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + `
    <div role="row" id="row-a" jslog='1:["#thread-f:100"]'>
      <div role="checkbox" id="box-a" aria-checked="true"></div>
    </div>
    <div role="row" id="row-b" jslog='1:["#thread-f:200"]'>
      <div role="checkbox" id="box-b" aria-checked="false"></div>
    </div>
  `, {
    settings: { alsoDelete: true, autoBlockSender: false, confirmEachClick: false },
  });
  assert.strictEqual(api.getRowThreadId(document.getElementById('row-a')), '#thread-f:100');
  let deleted = 0;
  document.getElementById('del').addEventListener('click', () => { deleted += 1; });
  document.getElementById('spam').addEventListener('click', () => {
    document.getElementById('box-a').setAttribute('aria-checked', 'false');
    document.getElementById('box-b').setAttribute('aria-checked', 'true');
    const prompt = document.createElement('div');
    prompt.setAttribute('role', 'dialog');
    prompt.innerHTML = '<button>Yes, block</button><button id="decline">No, thanks</button>';
    document.body.appendChild(prompt);
    document.getElementById('decline').addEventListener('click', () => prompt.remove());
  });

  await api.runSpamAndDelete(document.getElementById('spam'));
  assert.strictEqual(deleted, 0);
  assert.match(document.querySelector('.ocs-toast').textContent, /selected messages changed/i);
  api.destroy();
});

test('14b3. disabling auto-block dismisses its modal before Delete', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="thread-a"></div>', {
    settings: { alsoDelete: true, autoBlockSender: false, confirmEachClick: false },
  });
  const order = [];
  document.getElementById('del').addEventListener('click', () => order.push('delete'));
  document.getElementById('spam').addEventListener('click', () => {
    order.push('spam');
    const prompt = document.createElement('div');
    prompt.setAttribute('role', 'dialog');
    prompt.innerHTML = '<button>Yes, block</button><button id="decline">No, thanks</button>';
    document.body.appendChild(prompt);
    document.getElementById('decline').addEventListener('click', () => {
      order.push('dismiss');
      prompt.remove();
    });
  });

  await api.runSpamAndDelete(document.getElementById('spam'));
  assert.deepStrictEqual(plain(order), ['spam', 'dismiss', 'delete']);
  api.destroy();
});

test('14b4. an unrecognized new Gmail dialog prevents the Delete click', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="thread-a"></div>', {
    settings: { alsoDelete: true, autoBlockSender: true, confirmEachClick: false },
  });
  let deleted = 0;
  document.getElementById('del').addEventListener('click', () => { deleted += 1; });
  document.getElementById('spam').addEventListener('click', () => {
    const unknown = document.createElement('div');
    unknown.setAttribute('role', 'dialog');
    unknown.innerHTML = '<button>Translated Gmail action</button>';
    document.body.appendChild(unknown);
  });

  await api.runSpamAndDelete(document.getElementById('spam'));
  assert.strictEqual(deleted, 0);
  assert.match(document.querySelector('.ocs-toast').textContent, /dialog needs your response/i);
  api.destroy();
});

test('14c. a disabled widget explains itself instead of acting', async () => {
  const { api, document } = boot(`
    <div gh="mtb"><div id="back" aria-label="Back to Inbox"></div><div id="archive" aria-label="Archive"></div></div>
  `);
  api.injectWidget();
  assert.strictEqual(await api.handleAction(), false);
  const toast = document.querySelector('.ocs-toast');
  assert.ok(toast && /open an email/i.test(toast.textContent));
  api.destroy();
});

test('14d. the full flow reports spam, blocks the sender, deletes, and offers Undo', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="thread-a"></div>', {
    settings: { alsoDelete: true, autoBlockSender: true, confirmEachClick: false },
  });
  const order = [];
  document.getElementById('del').addEventListener('click', () => order.push('delete'));
  document.getElementById('spam').addEventListener('click', () => {
    order.push('spam');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<div role="button" id="block">Yes, block</div>';
    document.body.appendChild(dialog);
    dialog.querySelector('#block').addEventListener('click', () => {
      order.push('block');
      dialog.remove();
      const snack = document.createElement('div');
      snack.className = 'bAp';
      snack.setAttribute('role', 'alert');
      snack.innerHTML = '<span role="button" id="gmailUndo">Undo</span>';
      document.body.appendChild(snack);
    });
  });

  assert.strictEqual(await api.handleAction(), true);
  assert.deepStrictEqual(plain(order), ['spam', 'block', 'delete']);

  const toast = document.querySelector('.ocs-toast');
  assert.match(toast.textContent, /marked as spam/i);
  assert.match(toast.textContent, /sender blocked/i);
  assert.match(toast.textContent, /deleted/i);
  assert.ok(toast.classList.contains('ocs-toast--success'));

  // Undo hands off to Gmail's own undo affordance.
  const undo = toast.querySelector('.ocs-toast__undo');
  assert.ok(undo, 'undo button present');
  assert.strictEqual(api.findGmailUndoButton(), document.getElementById('gmailUndo'));
  let undone = 0;
  document.getElementById('gmailUndo').addEventListener('click', () => { undone += 1; });
  undo.click();
  assert.strictEqual(undone, 1);
  api.destroy();
});

test('14d2. Undo targets Gmail\'s newest action snackbar', () => {
  const { api, document } = boot(`
    <div class="bAp" role="alert"><button id="oldUndo">Undo</button></div>
    <div class="bAp" role="alert"><button id="newUndo">Undo</button></div>
  `);
  assert.strictEqual(api.findGmailUndoButton(), document.getElementById('newUndo'));
});

test('14d3. duplicate action requests cannot open duplicate confirmations', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="thread-a"></div>', {
    settings: { confirmEachClick: true },
  });
  const first = api.handleAction();
  const second = api.handleAction();
  assert.strictEqual(document.querySelectorAll('.ocs-dialog').length, 1);
  assert.strictEqual(await second, false);
  document.querySelector('.ocs-dialog__button--cancel').click();
  assert.strictEqual(await first, false);
  api.destroy();
});

test('14d4. a pre-existing Gmail action dialog blocks a new destructive action', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + `
    <div role="dialog"><button>Yes, block</button><button>No, thanks</button></div>
  `);
  let fired = 0;
  document.getElementById('spam').addEventListener('click', () => { fired += 1; });
  assert.strictEqual(await api.handleAction(), false);
  assert.strictEqual(fired, 0);
  assert.match(document.querySelector('.ocs-toast').textContent, /close the open Gmail dialog/i);
  api.destroy();
});

test('14e. the undo toast auto-dismisses after 5 seconds', async () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  const toast = api.showToast('Marked as spam', 'success', { undo: true, duration: 120 });
  assert.ok(document.querySelector('.ocs-toast'));
  assert.ok(toast.querySelector('.ocs-toast__undo'));
  await wait(500);
  assert.strictEqual(document.querySelector('.ocs-toast'), null, 'toast removed after its duration');
  api.destroy();
});

// --- 15. Idempotent injection ----------------------------------------------

test('15. repeated injection never duplicates the widget', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  api.injectWidget();
  api.injectWidget();
  api.reAnchorWidget();
  api.injectToolbarWidget();
  assert.strictEqual(document.querySelectorAll('#' + api.WIDGET_ID).length, 1);
  assert.strictEqual(document.querySelectorAll('.ocs-widget').length, 1);
  assert.strictEqual(document.getElementById('back').nextElementSibling, document.getElementById(api.WIDGET_ID));
});

test('15b. start() is idempotent and destroy() removes everything', () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.start();
  api.start();
  assert.strictEqual(document.querySelectorAll('.ocs-widget').length, 1);
  api.destroy();
  assert.strictEqual(document.querySelector('.ocs-widget'), null);
  assert.strictEqual(document.querySelector('.ocs-toast'), null);
});

test('15c. the floating fallback notice is shown once, not on every re-anchor', () => {
  const { api, document } = boot('<div id="app"></div>');
  api.injectWidget();
  document.querySelectorAll('.ocs-toast').forEach((t) => t.remove());
  api.injectWidget();
  api.reAnchorWidget();
  assert.strictEqual(document.querySelectorAll('.ocs-toast').length, 0, 'notice is not re-shown');
  api.destroy();
});

// --- Cross-file consistency + performance/accessibility contracts ----------

test('16. manifest declares the keyboard command and no extra permissions', () => {
  assert.strictEqual(MANIFEST.manifest_version, 3);
  assert.deepStrictEqual(plain(MANIFEST.permissions), ['storage'], 'storage permission only');
  assert.ok(!MANIFEST.host_permissions, 'no host permissions');
  assert.strictEqual(MANIFEST.content_scripts[0].run_at, 'document_idle');
  assert.strictEqual(MANIFEST.background.service_worker, 'background.js');
  const command = MANIFEST.commands['spam-and-delete'];
  assert.ok(command, 'commands key present');
  assert.strictEqual(command.suggested_key.default, 'Ctrl+Shift+S');
  assert.ok(command.description);
});

test('16b. the service worker relays only the declared command', () => {
  let commandListener = null;
  const sends = [];
  const queries = [];
  const chrome = {
    commands: {
      onCommand: { addListener(fn) { commandListener = fn; } },
    },
    tabs: {
      sendMessage(tabId, message, cb) {
        sends.push({ tabId, message });
        if (cb) cb();
      },
      query(options, cb) {
        queries.push(options);
        cb([{ id: 99 }]);
      },
    },
    runtime: { lastError: null },
  };
  vm.runInNewContext(BACKGROUND_JS, { chrome });
  assert.ok(commandListener);

  commandListener('other-command', { id: 7 });
  assert.strictEqual(sends.length, 0);
  commandListener('spam-and-delete', { id: 7 });
  assert.deepStrictEqual(plain(sends.pop()), { tabId: 7, message: { type: 'ocs-spam-and-delete' } });
  commandListener('spam-and-delete');
  assert.deepStrictEqual(plain(queries.pop()), { active: true, lastFocusedWindow: true });
  assert.deepStrictEqual(plain(sends.pop()), { tabId: 99, message: { type: 'ocs-spam-and-delete' } });
});

test('16b2. the relayed command does not run while the user types', () => {
  const { api, document, chrome } = boot(FLAT_TOOLBAR + '<input id="compose">', {
    storage: { alsoDelete: false, autoBlockSender: false },
  });
  let fired = 0;
  document.getElementById('spam').addEventListener('click', () => { fired += 1; });
  api.start();
  assert.strictEqual(chrome.messageListeners.length, 1);

  document.getElementById('compose').focus();
  chrome.messageListeners[0]({ type: 'ocs-spam-and-delete' });
  assert.strictEqual(fired, 0);
  assert.match(document.querySelector('.ocs-toast').textContent, /while you type/i);

  document.getElementById('compose').blur();
  chrome.messageListeners[0]({ type: 'ocs-spam-and-delete' });
  assert.strictEqual(fired, 1);
  api.destroy();
});

test('16c. Enter and Space activate the widget', async () => {
  const { api, document, window } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="t1"></div>', {
    settings: { alsoDelete: false, autoBlockSender: false, confirmEachClick: false },
  });
  api.injectWidget();
  const widget = document.getElementById(api.WIDGET_ID);
  let fired = 0;
  document.getElementById('spam').addEventListener('click', () => { fired += 1; });

  for (const key of ['Enter', ' ']) {
    widget.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await wait(1100); // let the in-flight action settle before the next press
  }
  assert.strictEqual(fired, 2, 'both Enter and Space activate the widget');
  api.destroy();
});

test('16d. no polling: content.js uses no setInterval and no body-wide observer at rest', () => {
  assert.ok(!/setInterval\s*\(/.test(CONTENT_JS), 'no setInterval anywhere');
  assert.ok(!/requestIdleCallback\s*\(\s*function\s*poll/.test(CONTENT_JS));
  // document.body is observed only by the one-shot bootstrap observer, which
  // disconnects itself as soon as the toolbar appears.
  const bodyObserves = CONTENT_JS.match(/\.observe\(document\.body/g) || [];
  assert.strictEqual(bodyObserves.length, 1, 'only the bootstrap observer touches document.body');
  assert.ok(/stopBootstrapObserver\(\);\s*\n\s*reAnchorWidget\(\);/.test(CONTENT_JS), 'bootstrap observer self-disconnects');
});

test('16e. styles.css covers every variant, focus, motion and contrast case', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  for (const style of ['gmail-icon', 'emphasized', 'compact', 'floating']) {
    assert.ok(css.includes('.ocs-widget--' + style), 'styles for ' + style);
  }
  assert.ok(css.includes(':focus-visible'), 'focus-visible outline');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion');
  assert.ok(css.includes('forced-colors'), 'high contrast');
  assert.ok(css.includes('.ocs-theme-dark'), 'dark theme');
});

// --- 17. Partial toolbar rerender — widget stays under same parent -------

test('17. isWidgetStale() detects widget displaced by partial toolbar rerender', () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.start();
  assert.strictEqual(api.getPlacementStatus(), 'toolbar');

  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget, 'widget exists initially');

  // Replace all children in the toolbar (simulates Gmail re-render).
  const toolbar = document.getElementById('toolbar');
  toolbar.innerHTML = `
    <div id="back" role="button" aria-label="Back to Inbox"></div>
    <div id="archive" role="button" aria-label="Archive"></div>
  `;

  // Widget was destroyed by innerHTML replacement.
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'widget destroyed');

  // Dispatch resize — this listener is registered by start().
  window.dispatchEvent(new window.Event('resize'));
  return wait(120).then(() => {
    const reWidget = document.getElementById(api.WIDGET_ID);
    assert.ok(reWidget, 'widget re-anchored after resize');
    assert.strictEqual(
      document.getElementById('back').nextElementSibling, reWidget,
      'widget is after Back'
    );
    assert.strictEqual(
      reWidget.nextElementSibling, document.getElementById('archive'),
      'widget is before Archive'
    );
    api.destroy();
  });
});

test('17b. isWidgetStale() detects displaced widget even under the same parent', () => {
  // Scenario: Gmail replaces Back/Archive inside the existing toolbar container
  // but our widget is left under the same parent — only the DOM order is wrong.
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.start();  // registers window/document listeners
  const widget = document.getElementById(api.WIDGET_ID);
  const toolbar = document.getElementById('toolbar');

  // Displace the widget after Archive within the same parent.
  const archive = document.getElementById('archive');
  toolbar.insertBefore(widget, archive.nextSibling);
  assert.strictEqual(widget.parentNode, toolbar, 'same parent');
  assert.strictEqual(
    Array.from(toolbar.children).indexOf(widget),
    2, 'widget is last child (after Archive)'
  );

  // isWidgetStale must detect this even though parentNode matches.
  assert.strictEqual(api.isWidgetStale(), true, 'stale despite same parent');

  // Trigger via capture-phase click (registered by start).
  document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return wait(120).then(() => {
    const reWidget = document.getElementById(api.WIDGET_ID);
    assert.ok(reWidget, 'widget present after event');
    // Check DOM order: back → widget → archive.
    const back = document.getElementById('back');
    assert.strictEqual(
      reWidget.parentNode, toolbar,
      'widget in toolbar'
    );
    assert.strictEqual(
      back.nextElementSibling, reWidget,
      'widget is after Back'
    );
    assert.strictEqual(
      reWidget.nextElementSibling, document.getElementById('archive'),
      'widget is before Archive'
    );
    api.destroy();
  });
});

// --- 18. Full toolbar container replacement -------------------------------

test('18. widget recovers when the entire toolbar container is replaced — no other event needed', async () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.start();
  assert.ok(document.getElementById(api.WIDGET_ID), 'widget present');

  // Replace the toolbar container element itself.
  const oldToolbar = document.getElementById('toolbar');
  const newToolbar = document.createElement('div');
  newToolbar.setAttribute('gh', 'mtb');
  newToolbar.setAttribute('class', 'G-atb');
  newToolbar.id = 'toolbar';
  newToolbar.innerHTML = `
    <div id="back" role="button" aria-label="Back to Inbox"></div>
    <div id="archive" role="button" aria-label="Archive"></div>
  `;
  oldToolbar.parentNode.replaceChild(newToolbar, oldToolbar);

  // Widget destroyed with old container.
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'widget destroyed');

  // The death observer fires automatically when the parent's childList mutation
  // removes the old toolbar.  Yield to let the microtask drain.
  await wait(20);

  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget, 'widget re-anchored after toolbar replacement (no resize/click needed)');
  assert.strictEqual(
    document.getElementById('back').nextElementSibling, widget,
    'widget after Back in new toolbar'
  );
  // Observer should now be on the new container.
  const observed = api.observedToolbar();
  assert.strictEqual(observed, newToolbar, 'observer migrated to new container');
  assert.ok(observed.isConnected, 'observed container is connected');
  api.destroy();
});

test('18b. widget recovers when replacement toolbar arrives in a later mutation', async () => {
  const { api, document } = boot(FLAT_TOOLBAR);
  api.start();
  document.getElementById('toolbar').remove();

  await wait(60);
  const fallback = document.getElementById(api.WIDGET_ID);
  assert.ok(fallback && fallback.classList.contains('ocs-widget--fallback'));

  const replacement = document.createElement('div');
  replacement.id = 'toolbar';
  replacement.setAttribute('gh', 'mtb');
  replacement.innerHTML = `
    <div id="back" aria-label="Back to Inbox"></div>
    <div id="archive" aria-label="Archive"></div>
  `;
  document.body.appendChild(replacement);
  await wait(60);

  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(widget.parentNode, replacement);
  assert.ok(widget.classList.contains('ocs-placement--toolbar'));
  assert.strictEqual(api.observedToolbar(), replacement);
  api.destroy();
});

// --- 19. Live theme synchronization on resize -----------------------------

test('19. resize event triggers theme class update on the widget', () => {
  const { api, document, window } = boot(`
    <div gh="mtb" id="toolbar" style="background-color: #ffffff">
      <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
      <div id="archive" role="button" aria-label="Archive" data-rect="50,0,40,40"></div>
    </div>
  `);
  api.start();
  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget.classList.contains('ocs-theme-light'), 'starts light');

  // Gmail switches toolbar to dark background.
  document.getElementById('toolbar').style.backgroundColor = 'rgb(32, 33, 36)';

  // Dispatch resize — the non-stale path must call applyPresentationClasses().
  window.dispatchEvent(new window.Event('resize'));
  return wait(120).then(() => {
    assert.ok(widget.classList.contains('ocs-theme-dark'), 'switched to dark');
    assert.ok(!widget.classList.contains('ocs-theme-light'), 'light class removed');
    api.destroy();
  });
});

// --- 20. Keyboard shortcut command contract -------------------------------

test('20. popup displays the active Chrome shortcut', () => {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  installLayout(window);
  installMatchMedia(window, {});
  window.chrome = makeChrome({}).api;
  let getAllCalled = false;
  window.chrome.commands = {
    getAll(cb) {
      getAllCalled = true;
      cb([{ name: 'spam-and-delete', shortcut: 'Alt+Z' }]);
    },
  };
  window.eval(SETTINGS_JS);
  window.eval(POPUP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const shortcutEl = window.document.getElementById('shortcut');
  assert.ok(shortcutEl, 'shortcut element exists');

  assert.strictEqual(getAllCalled, true);
  assert.strictEqual(shortcutEl.textContent, 'Alt+Z');
  assert.match(window.document.getElementById('shortcutState').textContent, /while Gmail is focused/i);
});

test('20b. the content script does not duplicate Chrome command handling', () => {
  assert.ok(BACKGROUND_JS.includes('chrome.commands.onCommand.addListener'));
  assert.ok(!CONTENT_JS.includes('isShortcutEvent'));
  assert.ok(!CONTENT_JS.includes("on(document, 'keydown', onGlobalKeydown"));
});

test('20c. README documents shortcut rebinding and the service worker', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('`chrome://extensions/shortcuts`'));
  assert.ok(readme.includes('Manifest V3 service'));
  assert.ok(readme.includes('background.js'));
  assert.ok(
    readme.includes('death-watch'),
    'README must document the death-watch observer on the toolbar parent'
  );
});

// --- 21. Hot-path performance (audit 2026-11-16) --------------------------

/** Counts layout reads on one element, the cost the hot paths must avoid. */
function countRectReads(el) {
  let reads = 0;
  const original = el.getBoundingClientRect.bind(el);
  el.getBoundingClientRect = () => { reads += 1; return original(); };
  return () => reads;
}

test('21. the list-view bootstrap observer checks Back at most once per frame', async () => {
  // Inbox list view: a hidden Back candidate exists, so no toolbar anchor.
  const { api, document } = boot(
    '<div id="app"><div id="back" aria-label="Back to Inbox" data-hidden></div></div>'
  );
  api.start();
  await wait(40);
  const reads = countRectReads(document.getElementById('back'));
  const app = document.getElementById('app');
  for (let i = 0; i < 10; i += 1) {
    app.appendChild(document.createElement('span'));
    await Promise.resolve(); // separate mutation batches within one frame
  }
  await wait(40);
  assert.ok(reads() <= 2, 'expected at most 2 Back checks, got ' + reads());
  api.destroy();
});

test('21b. typing in a text field does not re-run the toolbar checks', async () => {
  const { api, document, window } = boot(FLAT_TOOLBAR + '<textarea id="compose"></textarea>');
  api.start();
  await wait(40);
  const reads = countRectReads(document.getElementById('back'));
  const compose = document.getElementById('compose');
  for (let i = 0; i < 5; i += 1) {
    compose.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  }
  await wait(40);
  assert.strictEqual(reads(), 0, 'keyup in Compose must not trigger toolbar checks');

  document.body.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'x', bubbles: true }));
  await wait(40);
  assert.ok(reads() > 0, 'keyup outside text fields still refreshes the widget');
  api.destroy();
});

test('21c. moving the widget to its current slot writes nothing to the DOM', async () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.injectWidget();
  const toolbar = document.getElementById('toolbar');
  const records = [];
  const mo = new window.MutationObserver((r) => records.push(...r));
  mo.observe(toolbar, { childList: true });
  api.moveWidgetToSlot(api.currentSlotIndex(), false);
  await Promise.resolve();
  mo.disconnect();
  assert.strictEqual(records.length, 0);
  api.destroy();
});

test('22. a cancelled "Leave site?" prompt does not remove the widget', () => {
  const { api, document, window } = boot(FLAT_TOOLBAR);
  api.start();
  assert.ok(document.getElementById(api.WIDGET_ID));
  window.dispatchEvent(new window.Event('beforeunload'));
  assert.ok(document.getElementById(api.WIDGET_ID), 'widget survives beforeunload');
  window.dispatchEvent(new window.Event('pagehide'));
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'pagehide still cleans up');
});

test('22b. the widget comes back after a back/forward cache restore', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>${FLAT_TOOLBAR}</body></html>`, {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  installLayout(window);
  installMatchMedia(window, {});
  window.chrome = makeChrome({}).api;
  window.eval(SETTINGS_JS);
  window.eval(CONTENT_JS); // autostart on
  const api = window.__OCS__;
  await wait(20); // autostart waits for DOMContentLoaded
  assert.ok(window.document.getElementById(api.WIDGET_ID));
  window.dispatchEvent(new window.Event('pagehide'));
  assert.strictEqual(window.document.getElementById(api.WIDGET_ID), null);
  const restore = new window.Event('pageshow');
  Object.defineProperty(restore, 'persisted', { value: true });
  window.dispatchEvent(restore);
  assert.ok(window.document.getElementById(api.WIDGET_ID), 'widget restored');
  api.destroy();
});

test('23. a second request during a running action is ignored silently', async () => {
  const { api, document } = boot(FLAT_TOOLBAR + '<div data-thread-perm-id="t1"></div>', {
    settings: { alsoDelete: false, autoBlockSender: false, confirmEachClick: false },
  });
  api.injectWidget();
  const first = api.handleAction();
  // Gmail opens its own dialog while the first run waits for it.
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.textContent = 'Report spam or unsubscribe?';
  document.body.appendChild(dialog);
  const second = await api.handleAction();
  assert.strictEqual(second, false);
  const toast = document.querySelector('.ocs-toast');
  assert.ok(!toast || !/close the open gmail dialog/i.test(toast.textContent),
    'no misleading dialog warning while the first run is still going');
  dialog.remove();
  await first;
  api.destroy();
});

test('24. a floating button stays on screen after the window shrinks', async () => {
  const { api, document, window } = boot('<div id="app"></div>', {
    storage: { placementMode: 'floating', fabPosition: { x: 1000, y: 700 } },
  });
  window.innerWidth = 1200;
  window.innerHeight = 800;
  api.start();
  await wait(20);
  const widget = document.getElementById(api.WIDGET_ID);
  assert.strictEqual(widget.style.left, '1000px');
  window.innerWidth = 500;
  window.innerHeight = 400;
  window.dispatchEvent(new window.Event('resize'));
  await wait(40);
  assert.ok(parseFloat(widget.style.left) <= 500 - 24 - 4, 'left clamped: ' + widget.style.left);
  assert.ok(parseFloat(widget.style.top) <= 400 - 24 - 4, 'top clamped: ' + widget.style.top);
  api.destroy();
});

test('25. a placement change from the popup cancels a pending drag save', async () => {
  const { api, chrome } = boot(FLAT_TOOLBAR);
  api.start();
  await wait(20);
  api.moveWidgetToSlot(0); // queues a debounced { slot: 0 } save
  const change = { placementMode: { newValue: 'floating' }, fabPosition: { newValue: null } };
  chrome.store.placementMode = 'floating';
  chrome.store.fabPosition = null;
  for (const fn of chrome.listeners) fn(change, 'sync');
  await wait(400);
  assert.strictEqual(chrome.store.fabPosition, null, 'stale slot must not overwrite the reset');
  api.destroy();
});

test('26. popup and content script share one settings schema', () => {
  assert.deepStrictEqual(plain(MANIFEST.content_scripts[0].js), ['settings.js', 'content.js'],
    'settings.js loads before content.js');
  assert.ok(/<script src="settings.js"><\/script>\s*<script src="popup.js">/.test(POPUP_HTML),
    'popup.html loads settings.js before popup.js');
  assert.ok(!/alsoDelete:\s*true/.test(CONTENT_JS), 'content.js has no own defaults');
  assert.ok(!/alsoDelete:\s*true/.test(POPUP_JS), 'popup.js has no own defaults');
});

test('26b. popup repairs invalid stored values instead of selecting nothing', () => {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  installLayout(window);
  installMatchMedia(window, {});
  window.chrome = makeChrome({ widgetStyle: 'bogus', placementMode: 42, alsoDelete: 'yes' }).api;
  window.eval(SETTINGS_JS);
  window.eval(POPUP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const doc = window.document;
  assert.strictEqual(doc.querySelector('input[name="widgetStyle"][value="gmail-icon"]').checked, true);
  assert.strictEqual(doc.querySelector('input[name="placementMode"][value="toolbar"]').checked, true);
  assert.strictEqual(doc.getElementById('alsoDelete').checked, true);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async function run() {
  let passed = 0;
  const failures = [];

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log('  ✓ ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('  ✗ ' + name);
    }
  }

  console.log('');
  if (failures.length) {
    for (const { name, err } of failures) {
      console.log('FAILED: ' + name);
      console.log(String(err && err.stack ? err.stack : err));
      console.log('');
    }
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exitCode = 1;
    return;
  }
  console.log(passed + '/' + tests.length + ' acceptance tests passed');
})();
