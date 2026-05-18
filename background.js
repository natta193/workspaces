'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_COLORS = [
  { name: 'Purple', value: '#8764B8' },
  { name: 'Blue',   value: '#0078D4' },
  { name: 'Teal',   value: '#038387' },
  { name: 'Green',  value: '#107C10' },
  { name: 'Yellow', value: '#C19C00' },
  { name: 'Orange', value: '#CA5010' },
  { name: 'Red',    value: '#C50F1F' },
  { name: 'Pink',   value: '#E3008C' },
  { name: 'Gray',   value: '#7A7574' },
];

const STORAGE_KEY_WORKSPACES = 'workspaces';
const STORAGE_KEY_WINDOW_MAP  = 'windowWorkspaceMap';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getWorkspaces() {
  const data = await browser.storage.sync.get(STORAGE_KEY_WORKSPACES);
  return data[STORAGE_KEY_WORKSPACES] || {};
}

async function saveWorkspaces(ws) {
  await browser.storage.sync.set({ [STORAGE_KEY_WORKSPACES]: ws });
}

async function getWindowMap() {
  const data = await browser.storage.local.get(STORAGE_KEY_WINDOW_MAP);
  return data[STORAGE_KEY_WINDOW_MAP] || {};
}

async function saveWindowMap(map) {
  await browser.storage.local.set({ [STORAGE_KEY_WINDOW_MAP]: map });
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId() {
  return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Toolbar icon (canvas, per-window)
// ---------------------------------------------------------------------------

function buildIconImageData(color) {
  const sizes = [16, 32, 48, 64];
  const result = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const pad = Math.max(1, Math.round(size * 0.07));
    const gap = Math.max(1, Math.round(size * 0.09));
    const sq  = Math.floor((size - pad * 2 - gap) / 2);
    const r   = Math.max(1, Math.round(sq * 0.18));
    const x1 = pad, x2 = pad + sq + gap, y1 = pad, y2 = pad + sq + gap;
    function rr(x, y, w, h) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#B0B0B8'; rr(x1,y1,sq,sq); rr(x2,y1,sq,sq); rr(x1,y2,sq,sq);
    ctx.fillStyle = color || WORKSPACE_COLORS[0].value; rr(x2,y2,sq,sq);
    result[size] = ctx.getImageData(0, 0, size, size);
  }
  return result;
}

async function updateWindowIcon(windowId, color, name) {
  try {
    await browser.browserAction.setIcon({ imageData: buildIconImageData(color), windowId });
    await browser.browserAction.setTitle({ title: `Workspaces – ${name}`, windowId });
  } catch (_) {}
}

async function resetWindowIcon(windowId) {
  try {
    await browser.browserAction.setIcon({ imageData: buildIconImageData('#9B9B9B'), windowId });
    await browser.browserAction.setTitle({ title: 'Workspaces', windowId });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Window frame theme (title bar colour)
// ---------------------------------------------------------------------------

async function applyWindowTheme(windowId, color) {
  const text = contrastColor(color);
  try {
    await browser.theme.update(windowId, {
      colors: {
        frame:                color,
        frame_inactive:       color,
        tab_background_text:  text,
        bookmark_text:        text,
        icons:                text,
      }
    });
  } catch (_) {}
}

async function resetWindowTheme(windowId) {
  try { await browser.theme.reset(windowId); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Refresh all windows (icons + themes)
// ---------------------------------------------------------------------------

async function refreshAllWindows() {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const windows   = await browser.windows.getAll({ windowTypes: ['normal'] });
  const validIds  = new Set(windows.map(w => String(w.id)));

  for (const win of windows) {
    const wsId = map[String(win.id)];
    if (wsId && workspaces[wsId]) {
      await updateWindowIcon(win.id, workspaces[wsId].color, workspaces[wsId].name);
      await applyWindowTheme(win.id, workspaces[wsId].color);
    }
  }

  // Purge stale window map entries
  let dirty = false;
  for (const winIdStr of Object.keys(map)) {
    if (!validIds.has(winIdStr)) { delete map[winIdStr]; dirty = true; }
  }
  if (dirty) await saveWindowMap(map);
}

// ---------------------------------------------------------------------------
// URL filtering
// ---------------------------------------------------------------------------

function isRestorableUrl(url) {
  if (!url) return false;
  if (url === 'about:blank' || url === 'about:newtab' || url === 'about:home') return false;
  if (url.startsWith('moz-extension://') || url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('about:') && !url.startsWith('about:reader')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

async function createWorkspace(name, color, tabs) {
  const workspaces = await getWorkspaces();
  const id = generateId();
  workspaces[id] = {
    id, name, color,
    tabs: (tabs || []).filter(t => isRestorableUrl(t.url)),
    createdAt: Date.now(),
    lastUsed:  Date.now()
  };
  await saveWorkspaces(workspaces);
  return workspaces[id];
}

async function deleteWorkspace(workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  delete workspaces[workspaceId];
  await saveWorkspaces(workspaces);

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      delete map[winIdStr];
      await resetWindowIcon(winId);
      await resetWindowTheme(winId);
    }
  }
  await saveWindowMap(map);
}

async function renameWorkspace(workspaceId, name) {
  const workspaces = await getWorkspaces();
  if (!workspaces[workspaceId]) return;
  workspaces[workspaceId].name = name.trim() || workspaces[workspaceId].name;
  await saveWorkspaces(workspaces);
}

async function recolorWorkspace(workspaceId, color) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  if (!workspaces[workspaceId]) return;
  workspaces[workspaceId].color = color;
  await saveWorkspaces(workspaces);

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      await updateWindowIcon(winId, color, workspaces[workspaceId].name);
      await applyWindowTheme(winId, color);
    }
  }
}

// ---------------------------------------------------------------------------
// Assign a window to a workspace
// ---------------------------------------------------------------------------

async function assignWindowToWorkspace(windowId, workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const workspace = workspaces[workspaceId];
  if (!workspace) return;

  // If this workspace was open in another window, remove that link and reset that window's chrome
  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId && parseInt(winIdStr) !== windowId) {
      delete map[winIdStr];
      await resetWindowIcon(parseInt(winIdStr));
      await resetWindowTheme(parseInt(winIdStr));
    }
  }

  map[String(windowId)] = workspaceId;
  await saveWindowMap(map);

  await updateWindowIcon(windowId, workspace.color, workspace.name);
  await applyWindowTheme(windowId, workspace.color);

  workspace.lastUsed = Date.now();
  await saveWorkspaces(workspaces);
}

// ---------------------------------------------------------------------------
// Tab snapshot — called while tabs still exist
// ---------------------------------------------------------------------------

const _tabSaveTimers = {};

function scheduleTabSave(windowId) {
  clearTimeout(_tabSaveTimers[windowId]);
  _tabSaveTimers[windowId] = setTimeout(async () => {
    delete _tabSaveTimers[windowId];
    await snapshotWindowTabs(windowId);
  }, 600);
}

async function snapshotWindowTabs(windowId) {
  // Query tabs FIRST before any storage reads — when a window is closing,
  // tab-removed events fire in rapid succession. Any await before tabs.query
  // yields to the event loop and lets more tabs disappear before we capture them.
  let tabs;
  try { tabs = await browser.tabs.query({ windowId }); }
  catch (_) { return; }
  if (!tabs.length) return; // window already fully closed — don't wipe saved tabs

  const map = await getWindowMap();
  const workspaceId = map[String(windowId)];
  if (!workspaceId) return;

  const workspaces = await getWorkspaces();
  const workspace  = workspaces[workspaceId];
  if (!workspace) return;

  workspace.tabs = tabs
    .map(t => ({ url: t.url, title: t.title || t.url, pinned: t.pinned }))
    .filter(t => isRestorableUrl(t.url));
  workspace.lastUsed = Date.now();
  await saveWorkspaces(workspaces);
}

// ---------------------------------------------------------------------------
// Open a workspace in a window
// ---------------------------------------------------------------------------

// Flag so windows.onCreated knows not to auto-assign extension-opened windows
let _extensionIsCreatingWindow = false;

async function openWorkspace(workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const workspace = workspaces[workspaceId];
  if (!workspace) return { error: 'Workspace not found' };

  // Already open → focus it
  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      try {
        await browser.windows.update(parseInt(winIdStr), { focused: true });
        return { success: true };
      } catch (_) {
        delete map[winIdStr];
        await saveWindowMap(map);
        break;
      }
    }
  }

  const restorableUrls = workspace.tabs.map(t => t.url).filter(isRestorableUrl);
  // Omit url entirely when empty — Firefox opens its default new-tab page.
  // Never pass about:newtab — Firefox blocks privileged about: URLs from extensions.
  const createOpts = restorableUrls.length > 0 ? { url: restorableUrls } : {};

  _extensionIsCreatingWindow = true;
  let win;
  try {
    win = await browser.windows.create(createOpts);
  } finally {
    _extensionIsCreatingWindow = false;
  }

  // Restore pinned tabs
  if (workspace.tabs.some(t => t.pinned)) {
    const opened = await browser.tabs.query({ windowId: win.id });
    for (let i = 0; i < opened.length; i++) {
      if (workspace.tabs[i]?.pinned) {
        await browser.tabs.update(opened[i].id, { pinned: true }).catch(() => {});
      }
    }
  }

  map[String(win.id)] = workspaceId;
  await saveWindowMap(map);

  workspace.lastUsed = Date.now();
  await saveWorkspaces(workspaces);

  await updateWindowIcon(win.id, workspace.color, workspace.name);
  await applyWindowTheme(win.id, workspace.color);

  return { success: true, windowId: win.id };
}

// ---------------------------------------------------------------------------
// Tab event listeners
// ---------------------------------------------------------------------------

browser.tabs.onCreated.addListener(tab => {
  if (tab.windowId) scheduleTabSave(tab.windowId);
});

// KEY FIX: snapshot tabs while they still exist (isWindowClosing = tabs are mid-removal,
// remaining tabs are still queryable). Do NOT snapshot in windows.onRemoved — by then
// tabs.query returns empty, which would wipe the saved tab list.
const _closingWindowsSnapshotted = new Set();

browser.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) {
    if (!_closingWindowsSnapshotted.has(info.windowId)) {
      _closingWindowsSnapshotted.add(info.windowId);
      // Cancel any pending debounced save so it doesn't race with our snapshot
      clearTimeout(_tabSaveTimers[info.windowId]);
      delete _tabSaveTimers[info.windowId];
      // Snapshot NOW — the other tabs are still alive at this point
      snapshotWindowTabs(info.windowId);
    }
  } else {
    scheduleTabSave(info.windowId);
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
    scheduleTabSave(tab.windowId);
  }
});

browser.tabs.onMoved.addListener((tabId, info) => { scheduleTabSave(info.windowId); });
browser.tabs.onDetached.addListener((tabId, info) => { scheduleTabSave(info.oldWindowId); });
browser.tabs.onAttached.addListener((tabId, info) => { scheduleTabSave(info.newWindowId); });

// ---------------------------------------------------------------------------
// Window event listeners
// ---------------------------------------------------------------------------

// New window opened by the user (not by our extension) → auto-assign to a workspace
browser.windows.onCreated.addListener(async win => {
  if (win.type !== 'normal' || _extensionIsCreatingWindow) return;

  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const entries = Object.values(workspaces);
  if (!entries.length) return;

  // Find workspaces not currently open in any window, sorted by lastUsed desc
  const openWsIds = new Set(Object.values(map));
  const candidates = entries
    .filter(ws => !openWsIds.has(ws.id))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

  if (!candidates.length) return; // all workspaces are already in windows — leave unassigned

  await assignWindowToWorkspace(win.id, candidates[0].id);
});

browser.windows.onRemoved.addListener(async windowId => {
  // Cancel any pending debounced save — the window is gone, tabs.query returns empty.
  // The actual tab snapshot was taken in tabs.onRemoved (isWindowClosing) above.
  clearTimeout(_tabSaveTimers[windowId]);
  delete _tabSaveTimers[windowId];
  _closingWindowsSnapshotted.delete(windowId);

  const map = await getWindowMap();
  delete map[String(windowId)];
  await saveWindowMap(map);
});

browser.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const wsId = map[String(windowId)];
  if (wsId && workspaces[wsId]) {
    await updateWindowIcon(windowId, workspaces[wsId].color, workspaces[wsId].name);
    await applyWindowTheme(windowId, workspaces[wsId].color);
  }
});

// ---------------------------------------------------------------------------
// Sync change listener
// ---------------------------------------------------------------------------

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEY_WORKSPACES]) {
    await refreshAllWindows();
  }
});

// ---------------------------------------------------------------------------
// Message handler (popup ↔ background)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(async message => {
  switch (message.type) {

    case 'GET_STATE': {
      const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
      let currentWindowId = null;
      try {
        // getLastFocused({windowTypes:['normal']}) returns the most recently focused
        // normal window — reliable even when the popup overlay is active.
        const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
        if (win && win.id !== browser.windows.WINDOW_ID_NONE) currentWindowId = win.id;
      } catch (_) {}
      const currentWorkspaceId = currentWindowId ? (map[String(currentWindowId)] || null) : null;
      return { workspaces, currentWorkspaceId, currentWindowId, windowWorkspaceMap: map, colors: WORKSPACE_COLORS };
    }

    case 'CREATE_WORKSPACE': {
      const { name, color, fromCurrentWindow, windowId } = message;
      let tabs = [];
      if (fromCurrentWindow && windowId) {
        const openTabs = await browser.tabs.query({ windowId });
        tabs = openTabs
          .map(t => ({ url: t.url, title: t.title || t.url, pinned: t.pinned }))
          .filter(t => isRestorableUrl(t.url));
      }
      const workspace = await createWorkspace(name, color, tabs);
      if (fromCurrentWindow && windowId) {
        await assignWindowToWorkspace(windowId, workspace.id);
      }
      return { workspace };
    }

    case 'OPEN_WORKSPACE':  return openWorkspace(message.workspaceId);

    case 'DELETE_WORKSPACE':
      await deleteWorkspace(message.workspaceId);
      return { success: true };

    case 'RENAME_WORKSPACE':
      await renameWorkspace(message.workspaceId, message.name);
      return { success: true };

    case 'RECOLOR_WORKSPACE':
      await recolorWorkspace(message.workspaceId, message.color);
      return { success: true };

    case 'GET_COLORS':
      return { colors: WORKSPACE_COLORS };

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  const [map, windows] = await Promise.all([getWindowMap(), browser.windows.getAll({ windowTypes: ['normal'] })]);
  const validIds = new Set(windows.map(w => String(w.id)));
  let dirty = false;
  for (const winIdStr of Object.keys(map)) {
    if (!validIds.has(winIdStr)) { delete map[winIdStr]; dirty = true; }
  }
  if (dirty) await saveWindowMap(map);

  await refreshAllWindows();

  // Auto-assign any open windows that have no workspace
  const [workspaces, currentMap] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const entries    = Object.values(workspaces);
  const openWsIds  = new Set(Object.values(currentMap));

  for (const win of windows) {
    if (!currentMap[String(win.id)] && entries.length) {
      const candidates = entries
        .filter(ws => !openWsIds.has(ws.id))
        .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      if (candidates.length) {
        await assignWindowToWorkspace(win.id, candidates[0].id);
        openWsIds.add(candidates[0].id);
      }
    }
  }
}

init().catch(err => console.error('[Workspaces] init error:', err));
