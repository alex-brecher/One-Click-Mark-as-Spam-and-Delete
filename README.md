# One-Click Mark as Spam

A Chrome extension that adds a draggable one-click "Spam & Delete" button
to Gmail.

## What it does

- Adds a small red floating button (default: bottom-right) to every Gmail
  page. Drag it anywhere; the position is saved and synced.
- When clicked, it fires Gmail's "Report spam" toolbar action and then,
  immediately after, fires Gmail's "Delete" action — the same two clicks
  you'd do by hand to actually get a thread out of the inbox.
- Handles Gmail's follow-up dialogs automatically:
  - "Report spam or unsubscribe?" — clicks **Report spam**.
  - "Spam reported. Also block sender?" — clicks **Yes, block** (optional).
  - "Delete this message permanently?" (when viewing a message already in
    Spam/Trash) — confirms the delete.
- Works whether you have a single email open or multiple rows checkbox-selected.
- If Gmail's auto-advance opens the next conversation right after Report spam,
  the Delete step is skipped so it never trashes an unrelated email.
- Provides an options popup (click the extension icon in Chrome's toolbar) to
  toggle auto-delete, auto-block-sender, a "confirm before mark as spam"
  guard, and to reset the button position.

> The "Delete" step normally moves the message to Trash, where Gmail purges
> it after 30 days. Reporting spam already removes the thread from the inbox
> on its own; the Delete step just keeps Spam tidy.

## Limitations

- Dialog detection matches Gmail's **English** UI text ("Yes, block",
  "Report spam", "Unsubscribe"). The toolbar buttons fall back to Gmail's
  locale-independent internal action codes, but dialog auto-confirm only
  works with Gmail's display language set to English.
- Gmail's DOM changes without notice; selectors may need occasional updates.

## Installation (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar if you'd like quick access to the popup.
5. Open [Gmail](https://mail.google.com/). The red floating **Spam & Delete**
   button appears in the bottom-right corner.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration. |
| `content.js` | Injects UI into Gmail and wires the click handlers. |
| `styles.css` | Styling for the toolbar button, row buttons, and toast. |
| `popup.html` / `popup.css` / `popup.js` | Options popup. |
| `icons/` | 16/48/128 px PNG icons. |
| `scripts/make_icons.py` | Regenerates the PNG icons (no third-party deps). |

## Development notes

- The extension targets Gmail's standard web UI on `https://mail.google.com/`.
- It locates Gmail's "Report spam" and "Delete" controls by `aria-label` and
  `data-tooltip`, with Gmail's internal `act` codes as a locale-independent
  fallback. Per-row hover buttons (which share the same aria-labels) are
  explicitly excluded so actions always target the selection or open email.
- Auto-confirm searches only `role="dialog"` / `role="alertdialog"` /
  `role="alert"` containers and never rendered email content, so a malicious
  email can't plant a fake button for the extension to click.
- A `MutationObserver` re-injects the button after Gmail's frequent client-side
  re-renders.
- Settings live in `chrome.storage.sync` so they roam with the user's profile.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
