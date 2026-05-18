# Firefox Workspaces

A Firefox extension that replicates Microsoft Edge's Workspaces feature — workspace-per-window with colour-coded toolbar icons and automatic cross-device sync.

---

## Features

- **Workspace list** in the toolbar popup — see all workspaces at a glance
- **Create from current tabs** — snapshot your open tabs into a named workspace
- **Create blank workspace** — start fresh in a new window
- **Open in new window** — each workspace opens in its own dedicated window
- **Colour-coded icon** — the toolbar button changes colour to match the active workspace for each window
- **Auto-save** — every tab open/close/navigate/move is automatically persisted (debounced 600 ms)
- **Cross-device sync** — uses Firefox Sync (`storage.sync`) so workspaces are available on every signed-in device, securely end-to-end encrypted by Firefox
- **Rename & Recolor** — edit any workspace's name or colour at any time
- **Delete** — remove a workspace with confirmation

---

## Installing in Firefox (Temporary / Developer Mode)

This is the quickest way — no signing required:

1. Open Firefox and navigate to `about:debugging`
2. Click **This Firefox** in the left sidebar
3. Click **Load Temporary Add-on…**
4. Navigate to the `firefox-workspaces/` folder and select `manifest.json`
5. The **Workspaces** icon (four squares) will appear in your toolbar

> **Note:** Temporary add-ons are removed when Firefox restarts. See the permanent installation section below for a persistent install.

---

## Installing Permanently (Self-Signed)

### Option A — Using `web-ext` (Recommended)

1. Install Node.js (https://nodejs.org) and then install web-ext globally:
   ```bash
   npm install -g web-ext
   ```

2. From inside the `firefox-workspaces/` directory, build a signed XPI:
   ```bash
   web-ext build
   ```
   This produces a `.zip` in `web-ext-artifacts/`.

3. To run in a temporary profile for testing:
   ```bash
   web-ext run
   ```

4. For permanent installation without an AMO listing, sign with your own API key from [addons.mozilla.org/developers](https://addons.mozilla.org/developers):
   ```bash
   web-ext sign --api-key=YOUR_KEY --api-secret=YOUR_SECRET
   ```
   Then open the resulting `.xpi` file in Firefox.

### Option B — Firefox Developer Edition / Nightly (No Signing Required)

1. Open **Firefox Developer Edition** or **Firefox Nightly**
2. Navigate to `about:config`
3. Set `xpinstall.signatures.required` to `false`
4. Drag the extension folder's `manifest.json` (or a built `.xpi`) onto Firefox

---

## Usage

| Action | How |
|---|---|
| View workspaces | Click the toolbar icon |
| Open a workspace | Click its name in the popup — opens in a new window |
| Create from current tabs | Popup → "New workspace from current tabs" |
| Create blank | Popup → "New blank workspace" |
| Rename / Recolor | Hover a workspace → click `···` → Rename / Recolor |
| Delete | Hover a workspace → click `···` → Delete |
| Sync to other devices | Automatic — just sign in to Firefox Sync on each device |

---

## File Structure

```
firefox-workspaces/
├── manifest.json          Extension manifest (Manifest V2)
├── background.js          Core logic: storage, tab tracking, icon rendering
├── popup/
│   ├── popup.html         Popup markup (4 views: main, create, rename, delete)
│   ├── popup.js           Popup logic and state management
│   └── popup.css          Styling with light/dark mode support
├── icons/
│   ├── icon-16.svg
│   ├── icon-32.svg
│   ├── icon-48.svg
│   └── icon-96.svg
└── README.md
```

---

## How Sync Works

Workspaces are stored in `browser.storage.sync`, which is backed by Firefox Sync. This means:

- All workspace data is **end-to-end encrypted** by Firefox before leaving your device
- Changes appear on other signed-in devices within seconds
- No third-party server is involved — everything goes through Mozilla's infrastructure

The window-to-workspace mapping (which window is currently showing which workspace) is stored in `browser.storage.local` since it is per-device and non-persistent between sessions.

---

## Development

```bash
# Install web-ext for easy development reloading
npm install -g web-ext

# Run Firefox with the extension loaded and auto-reload on file changes
cd firefox-workspaces
web-ext run --firefox-binary /usr/bin/firefox
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Icon doesn't change colour | Make sure you are using Firefox 89+ |
| Workspaces don't sync | Ensure Firefox Sync is enabled in Preferences → Sync |
| Extension disappears after restart | Use the permanent install method above |
| Tabs not saved | Check that Firefox hasn't restricted `storage` permission |
