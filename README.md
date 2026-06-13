# One-Click Mark as Spam

A Chrome extension that adds a single-click "Mark as Spam" button to Gmail —
one in the main toolbar and one on each inbox row (visible on hover).

## What it does

- Adds a red **Mark as Spam** button to Gmail's main toolbar. Click it while an
  email (or set of emails) is selected and the extension fires Gmail's "Report
  spam" action.
- Adds a small hover button to each row in the inbox list. Clicking it selects
  just that row's checkbox and then drives Gmail's toolbar — no need to open the
  email first.
- Includes an **"Also archive"** safety net (on by default). After reporting
  spam the extension also clicks Archive, which removes the Inbox label even
  for stubborn conversation threads where Gmail occasionally leaves the
  message visible after a spam report. The email lives in Spam after this,
  not the inbox.
- Provides an options popup (click the extension icon in the toolbar) to toggle
  the toolbar button, the row buttons, the archive safety net, and a "confirm
  before mark as spam" guard.

> Messages in Gmail's Spam folder are auto-deleted after 30 days. Immediate
> permanent delete in one click would require the Gmail API (OAuth) because
> "Delete forever" sits behind a Gmail confirmation dialog that the page
> doesn't expose to extensions.

## Installation (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar if you'd like quick access to the popup.
5. Open [Gmail](https://mail.google.com/). The red **Spam & Delete** button
   appears in the toolbar and on each inbox row when hovered.

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
- It locates Gmail's "Report spam" control by `aria-label` and `data-tooltip`,
  with a fallback that simulates the `!` keyboard shortcut (requires Gmail's
  keyboard shortcuts to be enabled in Settings -> See all settings ->
  Keyboard shortcuts on).
- A `MutationObserver` re-injects the button after Gmail's frequent client-side
  re-renders.
- Settings live in `chrome.storage.sync` so they roam with the user's profile.

## Regenerating icons

```bash
python3 scripts/make_icons.py
```
