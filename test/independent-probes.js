/**
 * Independent probes — verifies the death-watch observer fix.
 *
 * Tests that the fix passes scenarios that bd4024e failed:
 *  - Full toolbar-container replacement auto-reanchors without any unrelated
 *    event (resize, click, hashchange, popstate). The previous test 18 masked
 *    this defect by manually dispatching resize.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

// ---------------------------------------------------------------------------
// Harness (minimal — matches acceptance.js with only what we need)
// ---------------------------------------------------------------------------

function installLayout(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    let left = 0, top = 0, width = 24, height = 24;
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
      right: left + width, bottom: top + height,
      x: left, y: top, toJSON() { return this; },
    };
  };
}

function makeChrome(initial) {
  const store = { ...(initial || {}) };
  const api = {
    storage: {
      sync: {
        get(defaults, cb) {
          const out = { ...(defaults || {}) };
          for (const k of Object.keys(defaults || {})) {
            if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          }
          if (cb) cb(out);
        },
        set(patch, cb) { Object.assign(store, patch); if (cb) cb(); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: { onMessage: { addListener() {}, removeListener() {} } },
    commands: { getAll(cb) { cb([{ name: 'spam-and-delete', shortcut: 'Ctrl+Shift+S' }]); } },
    tabs: { create() {} },
  };
  return api;
}

function boot(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  installLayout(window);
  window.chrome = makeChrome();
  window.__OCS_NO_AUTOSTART__ = true;
  window.eval(CONTENT_JS);
  return { dom, window, document: window.document, api: window.__OCS__ };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Independent probes
// ---------------------------------------------------------------------------

const probes = [];
function probe(name, fn) { probes.push({ name, fn }); }

async function runProbes() {
  let passed = 0;
  const failures = [];

  for (const { name, fn } of probes) {
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
  console.log(passed + '/' + probes.length + ' independent probes passed');
}

// --- Probe 1: Full toolbar replacement without resize/click/hash/popstate ---

probe('full toolbar-container replacement auto-reanchors without unrelated user event', async () => {
  const { api, document, window } = boot(`
    <div gh="mtb" class="G-atb" id="toolbar">
      <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
      <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
      <div id="other" role="button" data-rect="100,0,40,40"></div>
    </div>
  `);

  // Start — no manual resize/click/hash ever dispatched.
  api.start();
  const initialWidget = document.getElementById(api.WIDGET_ID);
  assert.ok(initialWidget, 'widget present after start');

  // Full container replacement.
  const newToolbar = document.createElement('div');
  newToolbar.setAttribute('gh', 'mtb');
  newToolbar.setAttribute('class', 'G-atb');
  newToolbar.id = 'toolbar';
  newToolbar.innerHTML = `
    <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
    <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
  `;
  const oldToolbar = document.getElementById('toolbar');
  oldToolbar.parentNode.replaceChild(newToolbar, oldToolbar);

  // No resize, click, hashchange, or popstate dispatched.
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'widget destroyed with old toolbar');

  // Yield to let the death observer's MutationCallback fire.
  await wait(20);

  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget, 'widget re-anchored automatically — no resize/click/hash needed');
  assert.strictEqual(
    document.getElementById('back').nextElementSibling, widget,
    'Back → widget → Archive order restored'
  );
  assert.strictEqual(
    widget.nextElementSibling, document.getElementById('archive'),
    'widget before Archive'
  );
  assert.strictEqual(api.getPlacementStatus(), 'toolbar', 'still toolbar placement');

  // Observer migrated to the new container.
  assert.strictEqual(api.observedToolbar(), newToolbar);
  assert.ok(newToolbar.isConnected);

  // Clean up.
  api.destroy();
});

// --- Probe 2: Parent death observer uses childList only (no subtree) ---

probe('death-watch observer uses childList only, does not duplicate subtree surveillance', async () => {
  const { api, document } = boot(`
    <div gh="mtb" class="G-atb" id="toolbar">
      <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
      <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
    </div>
  `);

  const observedCalls = [];
  const NativeObserver = document.defaultView.MutationObserver;
  document.defaultView.MutationObserver = function (cb) {
    const inner = new NativeObserver(cb);
    return {
      observe(target, opts) { observedCalls.push({ target, opts }); inner.observe(target, opts); },
      disconnect() { inner.disconnect(); },
      takeRecords() { return inner.takeRecords(); },
    };
  };

  api.injectWidget();
  api.observeToolbar();

  // The death observer observes with { childList: true } — NO subtree.
  const toolbar = document.getElementById('toolbar');
  const deathObsCall = observedCalls.find(
    c => c.target === toolbar.parentNode
  );
  assert.ok(deathObsCall, 'death observer on toolbar parent');
  assert.strictEqual(deathObsCall.opts.childList, true, 'childList: true');
  assert.strictEqual(deathObsCall.opts.subtree, undefined, 'no subtree — minimal scope');

  api.destroy();
});

// --- Probe 3: Partial toolbar rerender still works via toolbar observer ---

probe('partial toolbar rerender still detected by toolbar-scoped observer', async () => {
  const { api, document } = boot(`
    <div gh="mtb" class="G-atb" id="toolbar">
      <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
      <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
    </div>
  `);

  api.start();
  assert.ok(document.getElementById(api.WIDGET_ID), 'widget present');

  // Replace toolbar children (not the container).
  const toolbar = document.getElementById('toolbar');
  toolbar.innerHTML = `
    <div id="back" role="button" aria-label="Back to Inbox" data-rect="0,0,40,40"></div>
    <div id="archive" role="button" aria-label="Archive" act="7" data-rect="50,0,40,40"></div>
  `;
  assert.strictEqual(document.getElementById(api.WIDGET_ID), null, 'widget destroyed');

  // The toolbar observer fires on childList change of toolbar.
  await wait(20);

  const widget = document.getElementById(api.WIDGET_ID);
  assert.ok(widget, 'widget re-anchored after partial rerender');
  api.destroy();
});

// --- Run everything ---
runProbes();