'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPEN_URL_PREFIX = 'https://workspaces.firefox.ext/open/';

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
const STORAGE_KEY_LIVE_TABS   = 'workspaceLiveTabs';
const STORAGE_KEY_LAST_SYNC   = 'lastSyncAt';

const SYNC_QUOTA_BYTES = 102400;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getWorkspaces() {
  const data = await browser.storage.sync.get(STORAGE_KEY_WORKSPACES);
  return data[STORAGE_KEY_WORKSPACES] || {};
}

async function saveWorkspaces(ws) {
  const bytes = new TextEncoder().encode(JSON.stringify(ws)).length;
  if (bytes > SYNC_QUOTA_BYTES * 0.85) {
    console.warn(`[Workspaces] sync storage at ${Math.round(bytes / 1024)}KB / ${Math.round(SYNC_QUOTA_BYTES / 1024)}KB`);
  }
  await browser.storage.sync.set({ [STORAGE_KEY_WORKSPACES]: ws });
  await browser.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: Date.now() });
}

async function getWindowMap() {
  const data = await browser.storage.local.get(STORAGE_KEY_WINDOW_MAP);
  return data[STORAGE_KEY_WINDOW_MAP] || {};
}

async function saveWindowMap(map) {
  await browser.storage.local.set({ [STORAGE_KEY_WINDOW_MAP]: map });
}

async function getLiveTabs() {
  const data = await browser.storage.local.get(STORAGE_KEY_LIVE_TABS);
  return data[STORAGE_KEY_LIVE_TABS] || {};
}

async function getQuotaInfo() {
  const ws = await getWorkspaces();
  const bytes = new TextEncoder().encode(JSON.stringify(ws)).length;
  return { bytes, total: SYNC_QUOTA_BYTES, pct: bytes / SYNC_QUOTA_BYTES };
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
  } catch (err) {
    console.warn('[Workspaces] updateWindowIcon failed:', err.message);
  }
}

async function resetWindowIcon(windowId) {
  try {
    await browser.browserAction.setIcon({ imageData: buildIconImageData('#9B9B9B'), windowId });
    await browser.browserAction.setTitle({ title: 'Workspaces', windowId });
  } catch (err) {
    console.warn('[Workspaces] resetWindowIcon failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Window frame theme
// ---------------------------------------------------------------------------

async function applyWindowTheme(windowId, color) {
  const text = contrastColor(color);
  try {
    await browser.theme.update(windowId, {
      colors: {
        frame:               color,
        frame_inactive:      color,
        tab_background_text: text,
        bookmark_text:       text,
        icons:               text,
      }
    });
  } catch (err) {
    console.warn('[Workspaces] applyWindowTheme failed:', err.message);
  }
}

async function resetWindowTheme(windowId) {
  try {
    await browser.theme.reset(windowId);
  } catch (err) {
    console.warn('[Workspaces] resetWindowTheme failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Refresh all windows (icons + themes)
// ---------------------------------------------------------------------------

async function refreshAllWindows() {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const windows  = await browser.windows.getAll({ windowTypes: ['normal'] });
  const validIds = new Set(windows.map(w => String(w.id)));

  for (const win of windows) {
    const wsId = map[String(win.id)];
    if (wsId && workspaces[wsId]) {
      await updateWindowIcon(win.id, workspaces[wsId].color, workspaces[wsId].name);
      await applyWindowTheme(win.id, workspaces[wsId].color);
    }
  }

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
  if (url.startsWith(OPEN_URL_PREFIX)) return false;
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
    lastUsed:  Date.now(),
  };
  await saveWorkspaces(workspaces);
  return workspaces[id];
}

async function deleteWorkspace(workspaceId) {
  const [workspaces, map, live] = await Promise.all([
    getWorkspaces(), getWindowMap(), getLiveTabs(),
  ]);
  delete workspaces[workspaceId];
  delete live[workspaceId];
  await Promise.all([
    saveWorkspaces(workspaces),
    browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: live }),
  ]);

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      delete map[winIdStr];
      await unmarkWindowAsWorkspace(winId);
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
// Sessions API — marks workspace windows so Firefox session restore can be
// detected and suppressed on next startup
// ---------------------------------------------------------------------------

async function markWindowAsWorkspace(windowId, workspaceId) {
  try {
    await browser.sessions.setWindowValue(windowId, 'workspaceId', workspaceId);
  } catch (err) {
    console.warn('[Workspaces] setWindowValue failed:', err.message);
  }
}

async function unmarkWindowAsWorkspace(windowId) {
  try {
    await browser.sessions.removeWindowValue(windowId, 'workspaceId');
  } catch (err) {
    console.warn('[Workspaces] removeWindowValue failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Assign a window to a workspace (enforces single-window-per-workspace)
// ---------------------------------------------------------------------------

async function assignWindowToWorkspace(windowId, workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const workspace = workspaces[workspaceId];
  if (!workspace) return;

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId && parseInt(winIdStr) !== windowId) {
      const oldWinId = parseInt(winIdStr);
      delete map[winIdStr];
      await unmarkWindowAsWorkspace(oldWinId);
      await resetWindowIcon(oldWinId);
      await resetWindowTheme(oldWinId);
    }
  }

  map[String(windowId)] = workspaceId;
  await saveWindowMap(map);
  await markWindowAsWorkspace(windowId, workspaceId);

  await updateWindowIcon(windowId, workspace.color, workspace.name);
  await applyWindowTheme(windowId, workspace.color);

  workspace.lastUsed = Date.now();
  await saveWorkspaces(workspaces);
}

// ---------------------------------------------------------------------------
// Tab snapshot
// Live changes → local storage only (debounced, avoids hammering sync)
// Window closing → local + sync (immediate, ensures data is persisted)
// ---------------------------------------------------------------------------

const _tabSaveTimers = {};
const _closingWindowsSnapshotted = new Set();

function scheduleTabSave(windowId) {
  clearTimeout(_tabSaveTimers[windowId]);
  _tabSaveTimers[windowId] = setTimeout(async () => {
    delete _tabSaveTimers[windowId];
    await snapshotToLocal(windowId);
  }, 600);
}

async function snapshotToLocal(windowId) {
  let tabs;
  try { tabs = await browser.tabs.query({ windowId }); }
  catch (err) { console.warn('[Workspaces] tabs.query failed:', err.message); return; }
  if (!tabs.length) return;

  const map = await getWindowMap();
  const workspaceId = map[String(windowId)];
  if (!workspaceId) return;

  const live = await getLiveTabs();
  live[workspaceId] = tabs
    .map(t => ({ url: t.url, title: t.title || t.url, pinned: t.pinned }))
    .filter(t => isRestorableUrl(t.url));
  await browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: live });
}

async function snapshotAndFlushToSync(windowId) {
  // Query tabs FIRST before any awaits — tabs disappear fast when closing
  let tabs;
  try { tabs = await browser.tabs.query({ windowId }); }
  catch (err) { console.warn('[Workspaces] tabs.query failed:', err.message); return; }
  if (!tabs.length) return;

  const map = await getWindowMap();
  const workspaceId = map[String(windowId)];
  if (!workspaceId) return;

  const workspaces = await getWorkspaces();
  const workspace  = workspaces[workspaceId];
  if (!workspace) return;

  const snappedTabs = tabs
    .map(t => ({ url: t.url, title: t.title || t.url, pinned: t.pinned }))
    .filter(t => isRestorableUrl(t.url));

  workspace.tabs    = snappedTabs;
  workspace.lastUsed = Date.now();

  const live = await getLiveTabs();
  live[workspaceId] = snappedTabs;

  await Promise.all([
    saveWorkspaces(workspaces),
    browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: live }),
  ]);
}

// ---------------------------------------------------------------------------
// Open a workspace in a window
// ---------------------------------------------------------------------------

let _extensionIsCreatingWindow = false;

async function openWorkspace(workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const workspace = workspaces[workspaceId];
  if (!workspace) return { error: 'Workspace not found' };

  // Already open in a window → focus it (enforces single-window-per-workspace)
  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      try {
        // Confirm the window still belongs to this workspace — Firefox reuses
        // window IDs, so a stale map entry can silently point to a different window.
        const sessionWsId = await browser.sessions.getWindowValue(winId, 'workspaceId').catch(() => null);
        if (sessionWsId !== workspaceId) throw new Error('stale map entry');
        const existingWin = await browser.windows.get(winId);
        const updateOpts = { focused: true };
        if (existingWin.state === 'minimized') updateOpts.state = 'normal';
        await browser.windows.update(winId, updateOpts);
        return { success: true };
      } catch (err) {
        console.warn('[Workspaces] Could not focus existing window:', err.message);
        delete map[winIdStr];
        await saveWindowMap(map);
        break;
      }
    }
  }

  // Prefer live (in-progress) tabs, fall back to last-saved sync tabs
  const live = await getLiveTabs();
  const tabs = live[workspaceId] || workspace.tabs || [];
  const restorableUrls = tabs.map(t => t.url).filter(isRestorableUrl);
  const createOpts = restorableUrls.length > 0 ? { url: restorableUrls, focused: true } : { focused: true };

  _extensionIsCreatingWindow = true;
  let win;
  try {
    win = await browser.windows.create(createOpts);
  } catch (err) {
    console.error('[Workspaces] Failed to create window:', err.message);
    return { error: err.message };
  } finally {
    _extensionIsCreatingWindow = false;
  }

  if (tabs.some(t => t.pinned)) {
    const opened = await browser.tabs.query({ windowId: win.id });
    for (let i = 0; i < opened.length; i++) {
      if (tabs[i]?.pinned) {
        await browser.tabs.update(opened[i].id, { pinned: true }).catch(
          err => console.warn('[Workspaces] pin failed:', err.message)
        );
      }
    }
  }

  map[String(win.id)] = workspaceId;
  await saveWindowMap(map);
  await markWindowAsWorkspace(win.id, workspaceId);

  workspace.lastUsed = Date.now();
  await saveWorkspaces(workspaces);

  await updateWindowIcon(win.id, workspace.color, workspace.name);
  await applyWindowTheme(win.id, workspace.color);

  return { success: true, windowId: win.id };
}

async function openWorkspaceByName(name) {
  const workspaces = await getWorkspaces();
  const ws = Object.values(workspaces).find(w => w.name === name);
  if (ws) return openWorkspace(ws.id);
  console.warn('[Workspaces] No workspace named:', name);
  return { error: 'Not found: ' + name };
}

// ---------------------------------------------------------------------------
// URL interception — allows CLI script / school.sh to open a workspace
// URL format: https://workspaces.firefox.ext/open/<encoded-name>
// ---------------------------------------------------------------------------

// Guards against tabs.onUpdated and init()'s URL scan both firing at startup,
// which would call openWorkspace twice before the window map is updated.
const _handledOpenTabs = new Set();

async function handleWorkspaceOpenUrl(tabId, url) {
  if (!url.startsWith(OPEN_URL_PREFIX)) return;
  if (_handledOpenTabs.has(tabId)) return;
  _handledOpenTabs.add(tabId);
  const name = decodeURIComponent(url.slice(OPEN_URL_PREFIX.length));
  browser.tabs.remove(tabId).catch(() => {});
  await openWorkspaceByName(name);
}

// ---------------------------------------------------------------------------
// Tab event listeners
// ---------------------------------------------------------------------------

browser.tabs.onCreated.addListener(tab => {
  if (tab.windowId) scheduleTabSave(tab.windowId);
});

browser.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) {
    if (!_closingWindowsSnapshotted.has(info.windowId)) {
      _closingWindowsSnapshotted.add(info.windowId);
      clearTimeout(_tabSaveTimers[info.windowId]);
      delete _tabSaveTimers[info.windowId];
      snapshotAndFlushToSync(info.windowId);
    }
  } else {
    scheduleTabSave(info.windowId);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (changeInfo.url.startsWith(OPEN_URL_PREFIX)) {
      await handleWorkspaceOpenUrl(tabId, changeInfo.url);
      return;
    }
    scheduleTabSave(tab.windowId);
  } else if (changeInfo.title !== undefined) {
    scheduleTabSave(tab.windowId);
  }
});

browser.tabs.onMoved.addListener((tabId, info)   => { scheduleTabSave(info.windowId); });
browser.tabs.onDetached.addListener((tabId, info) => { scheduleTabSave(info.oldWindowId); });
browser.tabs.onAttached.addListener((tabId, info) => { scheduleTabSave(info.newWindowId); });

// ---------------------------------------------------------------------------
// Window event listeners
// ---------------------------------------------------------------------------

// New windows opened by the user get no automatic workspace assignment.
// The user opens workspaces explicitly via the popup or the CLI script.
browser.windows.onCreated.addListener(win => {
  if (win.type !== 'normal' || _extensionIsCreatingWindow) return;
  // intentionally no auto-assignment
});

browser.windows.onRemoved.addListener(async windowId => {
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
    await browser.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: Date.now() });
    await refreshAllWindows();
  }
});

// ---------------------------------------------------------------------------
// Periodic alarm — fallback for missed onChanged events (e.g. browser was
// closed when the other device synced)
// ---------------------------------------------------------------------------

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'ws-sync-check') {
    await refreshAllWindows();
  }
});

// ---------------------------------------------------------------------------
// Message handler (popup ↔ background)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener(async message => {
  switch (message.type) {

    case 'GET_STATE': {
      const [workspaces, map, localData, quota] = await Promise.all([
        getWorkspaces(),
        getWindowMap(),
        browser.storage.local.get(STORAGE_KEY_LAST_SYNC),
        getQuotaInfo(),
      ]);
      let currentWindowId = null;
      try {
        const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
        if (win && win.id !== browser.windows.WINDOW_ID_NONE) currentWindowId = win.id;
      } catch (err) {
        console.warn('[Workspaces] getLastFocused failed:', err.message);
      }
      const currentWorkspaceId = currentWindowId ? (map[String(currentWindowId)] || null) : null;
      return {
        workspaces, currentWorkspaceId, currentWindowId,
        windowWorkspaceMap: map,
        colors: WORKSPACE_COLORS,
        lastSyncAt: localData[STORAGE_KEY_LAST_SYNC] || null,
        quota,
      };
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

    case 'OPEN_WORKSPACE':
      return openWorkspace(message.workspaceId);

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

    case 'EXPORT_WORKSPACES': {
      const [workspaces, live] = await Promise.all([getWorkspaces(), getLiveTabs()]);
      const out = JSON.parse(JSON.stringify(workspaces));
      for (const [wsId, tabs] of Object.entries(live)) {
        if (out[wsId]) out[wsId].tabs = tabs;
      }
      return { data: out };
    }

    case 'IMPORT_WORKSPACES': {
      const { data, merge } = message;
      if (!data || typeof data !== 'object') return { error: 'Invalid data' };
      const existing = merge ? await getWorkspaces() : {};
      let count = 0;
      for (const [id, ws] of Object.entries(data)) {
        if (!ws.id || !ws.name || !ws.color) continue;
        existing[id] = {
          id: ws.id,
          name: String(ws.name),
          color: String(ws.color),
          tabs: Array.isArray(ws.tabs) ? ws.tabs : [],
          createdAt: ws.createdAt || Date.now(),
          lastUsed:  ws.lastUsed  || Date.now(),
        };
        count++;
      }
      await saveWorkspaces(existing);
      return { success: true, count };
    }

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  // Flush any live tabs left over from a previous crash into sync
  try {
    const [live, workspaces] = await Promise.all([getLiveTabs(), getWorkspaces()]);
    if (Object.keys(live).length) {
      let changed = false;
      for (const [wsId, tabs] of Object.entries(live)) {
        if (workspaces[wsId]) { workspaces[wsId].tabs = tabs; changed = true; }
      }
      if (changed) await saveWorkspaces(workspaces);
      await browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: {} });
    }
  } catch (err) {
    console.warn('[Workspaces] crash-recovery flush failed:', err.message);
  }

  // Close any windows that Firefox restored from a previous workspace session.
  // These would appear as plain unassigned windows containing workspace tabs,
  // which is confusing. Workspace sessions are marked via browser.sessions so
  // we can reliably detect and suppress them here.
  try {
    const allWins = await browser.windows.getAll({ windowTypes: ['normal'] });
    for (const win of allWins) {
      const wsId = await browser.sessions.getWindowValue(win.id, 'workspaceId').catch(() => null);
      if (wsId) {
        await browser.windows.remove(win.id).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Workspaces] restored-session cleanup failed:', err.message);
  }

  // Clean up stale window map entries
  const [map, windows] = await Promise.all([getWindowMap(), browser.windows.getAll({ windowTypes: ['normal'] })]);
  const validIds = new Set(windows.map(w => String(w.id)));
  let dirty = false;
  for (const winIdStr of Object.keys(map)) {
    if (!validIds.has(winIdStr)) { delete map[winIdStr]; dirty = true; }
  }
  if (dirty) await saveWindowMap(map);

  await refreshAllWindows();

  // Handle any workspace-open URLs already loaded (e.g. Firefox started via open-workspace.sh)
  try {
    const allTabs = await browser.tabs.query({});
    for (const tab of allTabs) {
      if (tab.url && tab.url.startsWith(OPEN_URL_PREFIX)) {
        await handleWorkspaceOpenUrl(tab.id, tab.url);
      }
    }
  } catch (err) {
    console.warn('[Workspaces] startup URL scan failed:', err.message);
  }

  // Periodic alarm — re-checks sync every 2 minutes as a fallback
  await browser.alarms.create('ws-sync-check', { periodInMinutes: 2 });
}

init().catch(err => console.error('[Workspaces] init error:', err));
