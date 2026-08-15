# One-Click Mark as Spam & Delete

A Chrome (MV3) extension that adds a one-click **Spam & Delete** control to
Gmail's primary toolbar, between **Back** and **Archive**.

## What it does

- Injects a widget into Gmail's main action toolbar, inserted between the
  "Back to Inbox" and "Archive" controls. If that toolbar can't be resolved
  (unusual layout, Gmail still booting), it falls back to a floating button and
  says so — in a toast and in the widget's own tooltip/`aria-label`.
- One activation fires Gmail's **Report spam** action, dismisses the follow-up
  dialogs, and then fires Gmail's **Delete** — the same clicks you'd do by hand
  to actually get a thread out of the inbox.
- Handles Gmail's follow-up dialogs automatically:
  - "Report spam or unsubscribe?" — clicks **Report spam**.
  - "Spam reported. Also block sender?" — clicks **Yes, block** (optional).
  - "Delete this message permanently?" (when the message is already in
    Spam/Trash) — confirms the delete.
- Works whether you have a single email open or several rows checkbox-selected.
- If Gmail's auto-advance opens the next conversation right after Report spam,
  the Delete step is skipped so it never trashes an unrelated email.
- Shows a result toast with an **Undo** button that hands off to Gmail's own
  undo. Auto-dismisses after 5 seconds.
- Greys itself out, with an explanatory tooltip, when there is nothing selected
  or open to act on.

> The Delete step normally moves the message to Trash, where Gmail purges it
> after 30 days. Reporting spam already removes the thread from the inbox on its
> own; the Delete step just keeps Spam tidy.

## Widget styles

Pick one in the popup (the extension icon in Chrome's toolbar):

| Style | Looks like |
| --- | --- |
| `gmail-icon` *(default)* | A Gmail toolbar icon button — grey icon, transparent background. |
| `emphasized` | Same shape, red destructive treatment with a white icon. |
| `compact` | A small "Spam" label next to a smaller icon. |
| `floating` | The classic round red floating action button. |

## Placement

- **Gmail toolbar** *(default)* — sits between Back and Archive. Drag it
  horizontally to reorder it among the toolbar's controls; it can never leave
  the toolbar row.
- **Floating button** — drag it anywhere on the page.

Either way the position is saved to `chrome.storage.sync` (debounced, so a drag
writes once when it settles) and roams with your Chrome profile. The `floating`
widget style always implies floating placement.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+S` (`Cmd+Shift+S` on macOS) | Spam & Delete the open or selected email. |
| `Tab` | Focus the widget (it's a real `role="button"` with `tabindex="0"`). |
| `Enter` / `Space` | Activate it. |
| `Ctrl+←` / `Ctrl+→` | Move it one slot left/right along the toolbar. |

The shortcut is declared in the manifest's `commands` key and can be rebound at
`chrome://extensions/shortcuts`; the popup shows whatever you actually have
bound. The content script also matches the same chord in-page so it works
without a background service worker.

## Settings

Click the extension icon:

- Also click Delete after marking as spam *(on)*
- Auto-click "Yes, block" when Gmail asks to block the sender *(on)*
- Ask for confirmation before each action *(off)* — shows a Gmail-styled,
  keyboard-accessible dialog, not `window.confirm()`
- Widget style (4 options) and placement mode (toolbar / floating)
- Keyboard shortcut display
- **Reset to recommended defaults**

Schema stored in `chrome.storage.sync`:

```js
{
  alsoDelete: true,
  autoBlockSender: true,
  confirmEachClick: false,
  widgetStyle: 'gmail-icon',   // gmail-icon | emphasized | compact | floating
  placementMode: 'toolbar',    // toolbar | floating
  fabPosition: null,           // {slot} in toolbar mode, {x, y} when floating
}
```

## Theme, motion and accessibility

- **Theme sync** — the widget reads Gmail's own toolbar background colour to
  decide light vs dark, so custom Gmail themes are honoured; it falls back to
  `matchMedia('(prefers-color-scheme: dark)')`.
- **Reduced motion** — `prefers-reduced-motion: reduce` disables every
  transition and animation, and the toast appears without a fade.
- **Accessibility** — `role="button"`, `tabindex="0"`, a live `aria-label` that
  states the current state, `aria-disabled` when unavailable, a `:focus-visible`
  outline, and `forced-colors` / `prefers-contrast` support. No state is
  signalled by colour alone.

## Limitations

- Dialog detection matches Gmail's **English** UI text ("Yes, block",
  "Report spam", "Unsubscribe"). The toolbar buttons fall back to Gmail's
  locale-independent internal action codes, but dialog auto-confirm only works
  with Gmail's display language set to English.
- Gmail's DOM changes without notice; selectors may need occasional updates.

## Installation (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar for quick access to the popup.
5. Open [Gmail](https://mail.google.com/). The widget appears in the toolbar,
   between Back and Archive.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration, including the `commands` shortcut. |
| `content.js` | Single-file IIFE: placement, widget styles, action, toast, dialog. |
| `styles.css` | All four widget styles, both placements, toast and dialog. |
| `popup.html` / `popup.css` / `popup.js` | Settings popup. |
| `test/acceptance.js` | jsdom acceptance suite (`npm test`). |
| `icons/` | 16/48/128 px PNG icons. |
| `scripts/make_icons.py` | Regenerates the PNG icons (no third-party deps). |

## Development notes

- `content.js` is deliberately one IIFE with no imports and no bundler, so it
  can be listed directly in `content_scripts` and run at `document_idle`.
- Control detection: Back via `[aria-label="Back to Inbox"]`,
  `[guidedhelpid="backButton"]`, `[data-tooltip^="Back to"]`; Archive via
  `[aria-label="Archive"]`, `[act="7"]`, `[act="8"]`. Report spam and Delete
  use `aria-label` / `data-tooltip` with Gmail's `act` codes as a
  locale-independent fallback.
- Per-row hover buttons (which share the toolbar's aria-labels) are explicitly
  excluded, so an action always targets the selection or the open email — never
  whichever row the mouse happens to be over.
- Auto-confirm searches only `role="dialog"` / `role="alertdialog"` /
  `role="alert"` containers and never rendered email content, so a malicious
  email can't plant a fake button for the extension to click.
- **Performance**: no polling and no `setInterval`. A `MutationObserver` scoped
  to the toolbar container (never `document.body`) triggers a
  `requestAnimationFrame`-batched re-anchor; a one-shot bootstrap observer
  catches Gmail's first paint and disconnects itself immediately. Injection is
  idempotent, listeners are registered once, and everything is torn down on
  `pagehide` / `beforeunload`.
- Permissions: `storage` only. No network calls, no analytics, no host
  permissions beyond the `https://mail.google.com/*` content-script match.
- Settings live in `chrome.storage.sync` and are watched via
  `chrome.storage.onChanged`, so changing a setting in the popup updates an open
  Gmail tab immediately.

## Tests

```bash
npm install   # jsdom
npm test
```

`test/acceptance.js` boots a throwaway jsdom "Gmail" per test and drives the
content script through its `window.__OCS__` hook. It covers Back/Archive
detection across layout variants, Back → widget → Archive ordering, re-anchoring
after a toolbar re-render, observer scoping, the floating fallback, all four
widget styles, horizontal-only drag and keyboard slot moves, storage
get/set/reset (including the popup), theme detection, reduced motion, the
`isInsideEmailContent` / `isInsideEmailRow` / `isUsable` safety guards, dialog
isolation, the thread-id auto-advance guard, and idempotent injection.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
