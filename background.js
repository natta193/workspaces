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

const STORAGE_KEY_WORKSPACES     = 'workspaces';
const STORAGE_KEY_WINDOW_MAP     = 'windowWorkspaceMap';
const STORAGE_KEY_LIVE_TABS      = 'workspaceLiveTabs';
const STORAGE_KEY_LAST_SYNC      = 'lastSyncAt';
const STORAGE_KEY_PENDING_WRITES = 'pendingWrites';

const FIREBASE_DEFAULT_URL = 'https://workspaces-81907-default-rtdb.firebaseio.com';
const FIREBASE_SECRET      = 'SpCh3Iz27HfzGEYtSNJMDW5JgVSq6Nun24nDwqjl';

// In-memory cache: windowId → { color, name }
const _windowMeta = {};

// Remote sync state
let _isOnline            = navigator.onLine;
const _lastWrittenAt     = {}; // wsId → timestamp (echo suppression)
let _applyingRemoteDelta = false;
let _sseSource           = null;
const _remoteWriteTimers = {};
const _lastRemoteSnapshot = {}; // wsId → snapshot sig — prevents echo writes after applying remote deltas
const _lastSyncedAt       = {}; // wsId → timestamp of last confirmed sync (our write OR received from remote)

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

function getSecret() { return FIREBASE_SECRET; }

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
  _windowMeta[windowId] = { color, name };
  try {
    await browser.browserAction.setIcon({ imageData: buildIconImageData(color), windowId });
    await browser.browserAction.setTitle({ title: `Workspaces – ${name}`, windowId });
  } catch (err) {
    console.warn('[Workspaces] updateWindowIcon failed:', err.message);
  }
}

async function resetWindowIcon(windowId) {
  delete _windowMeta[windowId];
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
  if (url.startsWith('file://') || url.startsWith('blob:') || url.startsWith('data:')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

async function createWorkspace(name, color, tabs) {
  const workspaces = await getWorkspaces();
  const trimmed = name.trim();
  if (Object.values(workspaces).some(w => w.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`A workspace named "${trimmed}" already exists`);
  }
  const id = generateId();
  workspaces[id] = {
    id, name, color,
    tabs: (tabs || []).filter(t => isRestorableUrl(t.url)),
    createdAt: Date.now(),
    lastUsed:  Date.now(),
    updatedAt: Date.now(),
  };
  await saveWorkspaces(workspaces);
  remoteWrite(id, workspaces[id]).catch(() => {});
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
  remoteDelete(workspaceId).catch(() => {});

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
  const trimmed = name.trim() || workspaces[workspaceId].name;
  if (trimmed.toLowerCase() !== workspaces[workspaceId].name.toLowerCase()) {
    if (Object.values(workspaces).some(w => w.id !== workspaceId && w.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`A workspace named "${trimmed}" already exists`);
    }
  }
  workspaces[workspaceId].name      = trimmed;
  workspaces[workspaceId].updatedAt = Date.now();
  await saveWorkspaces(workspaces);
  remoteWrite(workspaceId, workspaces[workspaceId]).catch(() => {});
}

async function recolorWorkspace(workspaceId, color) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  if (!workspaces[workspaceId]) return;
  workspaces[workspaceId].color     = color;
  workspaces[workspaceId].updatedAt = Date.now();
  await saveWorkspaces(workspaces);
  remoteWrite(workspaceId, workspaces[workspaceId]).catch(() => {});

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      await updateWindowIcon(winId, color, workspaces[workspaceId].name);
      await applyWindowTheme(winId, color);
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions API
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

// Recovery helper: re-link a window to its workspace via its persisted session value.
// Mutates map in-place and persists it. Also re-applies icon/theme.
async function recoverWindowMapping(windowId, workspaces, map) {
  try {
    const wsId = await browser.sessions.getWindowValue(windowId, 'workspaceId').catch(() => null);
    if (wsId && workspaces[wsId]) {
      map[String(windowId)] = wsId;
      saveWindowMap(map).catch(() => {});
      updateWindowIcon(windowId, workspaces[wsId].color, workspaces[wsId].name).catch(() => {});
      applyWindowTheme(windowId, workspaces[wsId].color).catch(() => {});
    }
  } catch (err) {
    console.warn('[Workspaces] recoverWindowMapping failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Tab snapshot
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

// Reads current tabs + tab groups for a window.
// Returns { tabs: [{url,title,pinned,groupId}], tabGroups: {key:{title,color,collapsed}} }
// groupId on each tab is a stable string key (not the browser's numeric group ID).
// Gracefully handles Firefox versions without the tabGroups API.
async function buildTabSnapshot(windowId) {
  const allTabs   = await browser.tabs.query({ windowId });
  const restorable = allTabs.filter(t => isRestorableUrl(t.url));

  let tabGroups         = {};
  const browserIdToKey  = {};

  try {
    if (browser.tabGroups) {
      const groups = await browser.tabGroups.query({ windowId });
      for (const g of groups) {
        const key = `g${Object.keys(tabGroups).length}`;
        tabGroups[key] = { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed };
        browserIdToKey[g.id] = key;
      }
    }
  } catch (_) { /* tabGroups API unavailable */ }

  const tabs = restorable.map(t => ({
    url:     t.url,
    title:   t.title || t.url,
    pinned:  t.pinned,
    groupId: (t.groupId && t.groupId !== -1 && browserIdToKey[t.groupId])
             ? browserIdToKey[t.groupId]
             : null,
  }));

  return { tabs, tabGroups: Object.keys(tabGroups).length ? tabGroups : undefined };
}

// Read a live snapshot entry — handles both new {tabs,tabGroups} format and legacy array.
function parseLiveEntry(entry) {
  if (!entry) return { tabs: [], tabGroups: undefined };
  if (Array.isArray(entry)) return { tabs: entry, tabGroups: undefined };
  return { tabs: entry.tabs || [], tabGroups: entry.tabGroups };
}

async function snapshotToLocal(windowId) {
  const [map, workspaces] = await Promise.all([getWindowMap(), getWorkspaces()]);
  if (!map[String(windowId)]) await recoverWindowMapping(windowId, workspaces, map);
  const workspaceId = map[String(windowId)];
  if (!workspaceId) return;

  let snapshot;
  try { snapshot = await buildTabSnapshot(windowId); }
  catch (err) { console.warn('[Workspaces] buildTabSnapshot failed:', err.message); return; }
  if (!snapshot.tabs.length) return;

  const live = await getLiveTabs();
  live[workspaceId] = snapshot;
  await browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: live });
}

async function snapshotAndFlushToSync(windowId) {
  const [map, workspaces, live] = await Promise.all([getWindowMap(), getWorkspaces(), getLiveTabs()]);
  const workspaceId = map[String(windowId)];
  if (!workspaceId) return;

  const workspace = workspaces[workspaceId];
  if (!workspace) return;

  // Try a fresh snapshot; if the window is already closing and tabs are gone, fall back to the
  // last live snapshot (kept current by snapshotToLocal) rather than losing all tab state.
  let snapshot;
  try { snapshot = await buildTabSnapshot(windowId); } catch (_) {}
  if (!snapshot || !snapshot.tabs.length) {
    const entry = live[workspaceId];
    if (entry) snapshot = parseLiveEntry(entry);
  }
  if (!snapshot || !snapshot.tabs.length) return;

  workspace.tabs      = snapshot.tabs;
  workspace.tabGroups = snapshot.tabGroups;
  workspace.lastUsed  = Date.now();
  workspace.updatedAt = Date.now();
  live[workspaceId]   = snapshot;

  await Promise.all([
    saveWorkspaces(workspaces),
    browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: live }),
  ]);

  remoteWrite(workspaceId, workspace).catch(() => {});
}

// ---------------------------------------------------------------------------
// Remote sync — Firebase Realtime Database via REST + SSE
// ---------------------------------------------------------------------------

// Fingerprint of a tab snapshot — used to detect whether state actually changed before writing.
// Includes tab URL, pinned, groupId, and group properties (title/color/collapsed).
function snapshotSig(snapshot) {
  const tabs = (snapshot.tabs || []).map(t => [t.url, !!t.pinned, t.groupId || null]);
  const groups = Object.values(snapshot.tabGroups || {})
    .map(g => `${g.title}|${g.color}|${g.collapsed ? 1 : 0}`)
    .sort()
    .join(',');
  return JSON.stringify(tabs) + '|' + groups;
}

function buildFirebaseUrl(secret, path) {
  const auth = secret ? `?auth=${encodeURIComponent(secret)}` : '';
  return `${FIREBASE_DEFAULT_URL}${path}.json${auth}`;
}

async function remoteWrite(wsId, workspaceState) {
  const secret = getSecret();
  if (!secret) return;

  if (!_isOnline) {
    await queuePendingWrite(wsId, workspaceState);
    return;
  }

  _lastWrittenAt[wsId]      = workspaceState.updatedAt;
  _lastRemoteSnapshot[wsId] = snapshotSig(workspaceState);
  _lastSyncedAt[wsId]       = workspaceState.updatedAt;
  const url = buildFirebaseUrl(secret, `/workspaces/${wsId}`);
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workspaceState),
    });
    if (!resp.ok) {
      console.warn('[Workspaces] Remote write failed:', resp.status);
      await queuePendingWrite(wsId, workspaceState);
    }
  } catch (err) {
    console.warn('[Workspaces] Remote write error:', err.message);
    await queuePendingWrite(wsId, workspaceState);
  }
}

async function remoteDelete(wsId) {
  const secret = getSecret();
  if (!secret) return;
  const url = buildFirebaseUrl(secret, `/workspaces/${wsId}`);
  try {
    await fetch(url, { method: 'DELETE' });
  } catch (err) {
    console.warn('[Workspaces] Remote delete error:', err.message);
  }
}

async function queuePendingWrite(wsId, workspaceState) {
  const data  = await browser.storage.local.get(STORAGE_KEY_PENDING_WRITES);
  const queue = data[STORAGE_KEY_PENDING_WRITES] || {};
  const existing = queue[wsId];
  if (!existing || workspaceState.updatedAt > existing.timestamp) {
    queue[wsId] = { state: workspaceState, timestamp: workspaceState.updatedAt };
    await browser.storage.local.set({ [STORAGE_KEY_PENDING_WRITES]: queue });
  }
}

async function flushOfflineQueue() {
  const secret = getSecret();
  if (!secret) return;

  const data  = await browser.storage.local.get(STORAGE_KEY_PENDING_WRITES);
  const queue = data[STORAGE_KEY_PENDING_WRITES] || {};
  if (!Object.keys(queue).length) return;

  const updated = { ...queue };
  for (const [wsId, { state: queuedState, timestamp }] of Object.entries(queue)) {
    try {
      const url      = buildFirebaseUrl(secret, `/workspaces/${wsId}/updatedAt`);
      const resp     = await fetch(url);
      const remoteTs = resp.ok ? (await resp.json()) || 0 : 0;
      if (timestamp > remoteTs) await remoteWrite(wsId, queuedState);
      delete updated[wsId];
    } catch (err) {
      console.warn('[Workspaces] flushOfflineQueue error for', wsId, ':', err.message);
    }
  }
  await browser.storage.local.set({ [STORAGE_KEY_PENDING_WRITES]: updated });
}

function scheduleRemoteWrite(windowId) {
  clearTimeout(_remoteWriteTimers[windowId]);
  _remoteWriteTimers[windowId] = setTimeout(async () => {
    delete _remoteWriteTimers[windowId];
    if (_applyingRemoteDelta) return;

    let tabs;
    try { tabs = await browser.tabs.query({ windowId }); }
    catch (err) { return; }
    if (!tabs.length) return;

    const [map, workspaces] = await Promise.all([getWindowMap(), getWorkspaces()]);
    if (!map[String(windowId)]) await recoverWindowMapping(windowId, workspaces, map);
    const wsId = map[String(windowId)];
    if (!wsId) return;
    const workspace = workspaces[wsId];
    if (!workspace) return;

    let snapshot;
    try { snapshot = await buildTabSnapshot(windowId); }
    catch (err) { return; }
    if (!snapshot.tabs.length) return;

    // Skip if the tab state matches what was last written/received — prevents echo loops
    // where Device B writes back after applying Device A's delta (tabs still loading)
    if (_lastRemoteSnapshot[wsId] && _lastRemoteSnapshot[wsId] === snapshotSig(snapshot)) return;

    await remoteWrite(wsId, {
      ...workspace,
      tabs:      snapshot.tabs,
      tabGroups: snapshot.tabGroups,
      updatedAt: Date.now(),
    });
  }, 400);
}

async function applyTabGroups(windowId, savedTabs, tabGroups) {
  if (!browser.tabGroups) return;
  try {
    const currentTabs = await browser.tabs.query({ windowId });
    const urlToTabId  = {};
    for (const t of currentTabs) urlToTabId[t.url] = t.id;

    // Remove all existing groups so we start clean
    const existingGroups = await browser.tabGroups.query({ windowId });
    for (const g of existingGroups) {
      const members = await browser.tabs.query({ windowId, groupId: g.id });
      if (members.length) await browser.tabs.ungroup(members.map(t => t.id)).catch(() => {});
    }

    // Build groupKey → tabIds from saved tab list
    const groupKeyToTabIds = {};
    for (const tab of savedTabs) {
      if (tab.groupId && tabGroups[tab.groupId] && urlToTabId[tab.url]) {
        (groupKeyToTabIds[tab.groupId] ??= []).push(urlToTabId[tab.url]);
      }
    }

    for (const [gKey, tabIds] of Object.entries(groupKeyToTabIds)) {
      if (!tabIds.length) continue;
      const def = tabGroups[gKey];
      const gId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
      await browser.tabGroups.update(gId, {
        title:     def.title    || '',
        color:     def.color    || 'grey',
        collapsed: !!def.collapsed,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[Workspaces] applyTabGroups failed:', err.message);
  }
}

async function applyRemoteDelta(windowId, newTabs, tabGroups) {
  _applyingRemoteDelta = true;
  try {
    const currentTabs = await browser.tabs.query({ windowId });
    const currentUrls = new Set(currentTabs.map(t => t.url));
    const newUrls     = new Set(newTabs.map(t => t.url));

    const toClose = currentTabs.filter(t => !newUrls.has(t.url));
    const toOpen  = newTabs.filter(t => !currentUrls.has(t.url) && isRestorableUrl(t.url));

    for (const tab of toClose) await browser.tabs.remove(tab.id).catch(() => {});
    for (const tab of toOpen) {
      await browser.tabs.create({ windowId, url: tab.url, pinned: !!tab.pinned }).catch(() => {});
    }

    if (toClose.length === currentTabs.length && toOpen.length === 0) {
      await browser.tabs.create({ windowId }).catch(() => {});
    }

    if (tabGroups && Object.keys(tabGroups).length) {
      await applyTabGroups(windowId, newTabs, tabGroups);
    }
  } finally {
    _applyingRemoteDelta = false;
  }
}

async function setupRemoteListener() {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }

  const secret = getSecret();
  if (!secret) return;

  const url    = buildFirebaseUrl(secret, '/workspaces');
  const source = new EventSource(url);
  _sseSource   = source;

  async function handleUpdates(updates) {
    if (!updates || typeof updates !== 'object') return;

    const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
    let changed = false;

    for (const [wsId, remoteWs] of Object.entries(updates)) {
      if (!remoteWs || typeof remoteWs !== 'object') {
        if (workspaces[wsId]) { delete workspaces[wsId]; changed = true; }
        continue;
      }

      // Skip our own echoed write
      if (_lastWrittenAt[wsId] && remoteWs.updatedAt === _lastWrittenAt[wsId]) continue;

      const localTs  = workspaces[wsId] ? (workspaces[wsId].updatedAt || 0) : 0;
      const remoteTs = remoteWs.updatedAt || 0;
      if (remoteTs <= localTs) continue;

      workspaces[wsId] = remoteWs;
      changed = true;
      _lastRemoteSnapshot[wsId] = snapshotSig({ tabs: remoteWs.tabs, tabGroups: remoteWs.tabGroups });
      _lastSyncedAt[wsId]       = remoteTs;

      for (const [winIdStr, wId] of Object.entries(map)) {
        if (wId === wsId) {
          applyRemoteDelta(parseInt(winIdStr), remoteWs.tabs || [], remoteWs.tabGroups)
            .catch(err => console.warn('[Workspaces] applyRemoteDelta error:', err.message));
          break;
        }
      }
    }

    if (changed) await saveWorkspaces(workspaces);
  }

  source.addEventListener('put', async event => {
    try {
      const { path, data } = JSON.parse(event.data);
      if (path === '/') {
        await handleUpdates(data || {});
      } else {
        const wsId = path.replace(/^\//, '').split('/')[0];
        if (wsId) await handleUpdates({ [wsId]: data });
      }
    } catch (err) {
      console.warn('[Workspaces] SSE put error:', err.message);
    }
  });

  source.addEventListener('patch', async event => {
    try {
      const { path, data } = JSON.parse(event.data);
      if (!data) return;
      if (path === '/') {
        await handleUpdates(data);
      } else {
        const wsId = path.replace(/^\//, '').split('/')[0];
        if (wsId) await handleUpdates({ [wsId]: data });
      }
    } catch (err) {
      console.warn('[Workspaces] SSE patch error:', err.message);
    }
  });

  // Firebase sends 'cancel' when auth is rejected (not in approved list)
  source.addEventListener('cancel', event => {
    console.warn('[Workspaces] Firebase rejected auth — check approved email list in rules:', event.data);
    source.close();
    _sseSource = null;
  });

  source.addEventListener('open', () => {
    _isOnline = true;
    flushOfflineQueue().catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Open a workspace in a window
// ---------------------------------------------------------------------------

let _extensionIsCreatingWindow = false;

async function openWorkspace(workspaceId) {
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  const workspace = workspaces[workspaceId];
  if (!workspace) return { error: 'Workspace not found' };

  for (const [winIdStr, wsId] of Object.entries(map)) {
    if (wsId === workspaceId) {
      const winId = parseInt(winIdStr);
      try {
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

  const live = await getLiveTabs();
  const { tabs, tabGroups } = live[workspaceId]
    ? parseLiveEntry(live[workspaceId])
    : { tabs: workspace.tabs || [], tabGroups: workspace.tabGroups };
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

  const opened = await browser.tabs.query({ windowId: win.id });

  if (tabs.some(t => t.pinned)) {
    for (let i = 0; i < opened.length; i++) {
      if (tabs[i]?.pinned) {
        await browser.tabs.update(opened[i].id, { pinned: true }).catch(
          err => console.warn('[Workspaces] pin failed:', err.message)
        );
      }
    }
  }

  if (tabGroups && Object.keys(tabGroups).length) {
    // Match opened tabs positionally to saved tabs so we can assign group IDs
    const groupKeyToTabIds = {};
    for (let i = 0; i < Math.min(tabs.length, opened.length); i++) {
      const gKey = tabs[i].groupId;
      if (gKey && tabGroups[gKey]) {
        (groupKeyToTabIds[gKey] ??= []).push(opened[i].id);
      }
    }
    try {
      if (browser.tabGroups) {
        for (const [gKey, tabIds] of Object.entries(groupKeyToTabIds)) {
          if (!tabIds.length) continue;
          const def = tabGroups[gKey];
          const gId = await browser.tabs.group({ tabIds, createProperties: { windowId: win.id } });
          await browser.tabGroups.update(gId, {
            title:     def.title    || '',
            color:     def.color    || 'grey',
            collapsed: !!def.collapsed,
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[Workspaces] Tab group restore failed:', err.message);
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
// URL interception
// ---------------------------------------------------------------------------

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
  if (_applyingRemoteDelta || !tab.windowId) return;
  scheduleTabSave(tab.windowId);
  scheduleRemoteWrite(tab.windowId);
});

browser.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) {
    if (!_closingWindowsSnapshotted.has(info.windowId)) {
      _closingWindowsSnapshotted.add(info.windowId);
      clearTimeout(_tabSaveTimers[info.windowId]);
      delete _tabSaveTimers[info.windowId];
      clearTimeout(_remoteWriteTimers[info.windowId]);
      delete _remoteWriteTimers[info.windowId];
      snapshotAndFlushToSync(info.windowId);
    }
  } else {
    if (!_applyingRemoteDelta) {
      scheduleTabSave(info.windowId);
      scheduleRemoteWrite(info.windowId);
    }
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (changeInfo.url.startsWith(OPEN_URL_PREFIX)) {
      await handleWorkspaceOpenUrl(tabId, changeInfo.url);
      return;
    }
    if (!_applyingRemoteDelta) {
      scheduleTabSave(tab.windowId);
      scheduleRemoteWrite(tab.windowId);
    }
  } else if (changeInfo.title !== undefined) {
    if (!_applyingRemoteDelta) {
      scheduleTabSave(tab.windowId);
      scheduleRemoteWrite(tab.windowId);
    }
  }
});

browser.tabs.onMoved.addListener((tabId, info) => {
  if (!_applyingRemoteDelta) { scheduleTabSave(info.windowId); scheduleRemoteWrite(info.windowId); }
});
browser.tabs.onDetached.addListener((tabId, info) => {
  if (!_applyingRemoteDelta) { scheduleTabSave(info.oldWindowId); scheduleRemoteWrite(info.oldWindowId); }
});
browser.tabs.onAttached.addListener((tabId, info) => {
  if (!_applyingRemoteDelta) { scheduleTabSave(info.newWindowId); scheduleRemoteWrite(info.newWindowId); }
});

// Save when a tab moves between groups or is ungrouped
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined && !_applyingRemoteDelta && tab.windowId) {
    scheduleTabSave(tab.windowId);
    scheduleRemoteWrite(tab.windowId);
  }
}, { properties: ['groupId'] });

// Save when a group is renamed, recolored, or collapsed
if (browser.tabGroups) {
  const onGroupChange = group => {
    if (!_applyingRemoteDelta && group.windowId) {
      scheduleTabSave(group.windowId);
      scheduleRemoteWrite(group.windowId);
    }
  };
  browser.tabGroups.onCreated.addListener(onGroupChange);
  browser.tabGroups.onRemoved.addListener(onGroupChange);
  browser.tabGroups.onUpdated.addListener(onGroupChange);
}

// ---------------------------------------------------------------------------
// Window event listeners
// ---------------------------------------------------------------------------

browser.windows.onCreated.addListener(win => {
  if (win.type !== 'normal' || _extensionIsCreatingWindow) return;
  // intentionally no auto-assignment
});

browser.windows.onRemoved.addListener(async windowId => {
  clearTimeout(_tabSaveTimers[windowId]);
  delete _tabSaveTimers[windowId];
  clearTimeout(_remoteWriteTimers[windowId]);
  delete _remoteWriteTimers[windowId];
  _closingWindowsSnapshotted.delete(windowId);

  const map = await getWindowMap();
  delete map[String(windowId)];
  await saveWindowMap(map);
});

browser.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const [workspaces, map] = await Promise.all([getWorkspaces(), getWindowMap()]);
  if (!map[String(windowId)]) await recoverWindowMapping(windowId, workspaces, map);
  const wsId = map[String(windowId)];
  if (wsId && workspaces[wsId]) {
    await updateWindowIcon(windowId, workspaces[wsId].color, workspaces[wsId].name);
    await applyWindowTheme(windowId, workspaces[wsId].color);
  } else {
    const meta = _windowMeta[windowId];
    if (meta) {
      await updateWindowIcon(windowId, meta.color, meta.name);
      await applyWindowTheme(windowId, meta.color);
    }
  }
});

// ---------------------------------------------------------------------------
// Sync change listener (kept for workspace create/delete/rename from other devices)
// ---------------------------------------------------------------------------

let _refreshTimer = null;
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[STORAGE_KEY_WORKSPACES]) return;
  browser.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: Date.now() });
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    refreshAllWindows().catch(err => console.warn('[Workspaces] refreshAllWindows error:', err));
  }, 2000);
});

// ---------------------------------------------------------------------------
// Periodic alarm fallback
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
        browser.storage.local.get([STORAGE_KEY_LAST_SYNC, STORAGE_KEY_LIVE_TABS]),
        getQuotaInfo(),
      ]);
      let currentWindowId = null;
      try {
        const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
        if (win && win.id !== browser.windows.WINDOW_ID_NONE) currentWindowId = win.id;
      } catch (err) {
        console.warn('[Workspaces] getLastFocused failed:', err.message);
      }
      if (currentWindowId && !map[String(currentWindowId)]) {
        await recoverWindowMapping(currentWindowId, workspaces, map);
      }
      const currentWorkspaceId = currentWindowId ? (map[String(currentWindowId)] || null) : null;
      return {
        workspaces, currentWorkspaceId, currentWindowId,
        windowWorkspaceMap: map,
        colors: WORKSPACE_COLORS,
        lastSyncAt:       localData[STORAGE_KEY_LAST_SYNC] || null,
        liveTabs:         localData[STORAGE_KEY_LIVE_TABS] || {},
        quota,
        secretConfigured: true,
        remoteConnected:  !!(_sseSource && _sseSource.readyState === EventSource.OPEN),
        remotePending:    !!(_sseSource && _sseSource.readyState === EventSource.CONNECTING),
        lastWrittenAt:    { ..._lastWrittenAt },
        lastSyncedAt:     { ..._lastSyncedAt },
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
      for (const [wsId, entry] of Object.entries(live)) {
        if (out[wsId]) {
          const { tabs, tabGroups } = parseLiveEntry(entry);
          out[wsId].tabs      = tabs;
          out[wsId].tabGroups = tabGroups;
        }
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
          id:        ws.id,
          name:      String(ws.name),
          color:     String(ws.color),
          tabs:      Array.isArray(ws.tabs) ? ws.tabs : [],
          tabGroups: (ws.tabGroups && typeof ws.tabGroups === 'object') ? ws.tabGroups : undefined,
          createdAt: ws.createdAt || Date.now(),
          lastUsed:  ws.lastUsed  || Date.now(),
          updatedAt: Date.now(),
        };
        count++;
      }
      await saveWorkspaces(existing);
      for (const [id, ws] of Object.entries(existing)) {
        remoteWrite(id, ws).catch(() => {});
      }
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
  // Flush live tabs from previous crash into sync
  try {
    const [live, workspaces] = await Promise.all([getLiveTabs(), getWorkspaces()]);
    if (Object.keys(live).length) {
      let changed = false;
      for (const [wsId, entry] of Object.entries(live)) {
        if (workspaces[wsId]) {
          const { tabs, tabGroups } = parseLiveEntry(entry);
          workspaces[wsId].tabs      = tabs;
          workspaces[wsId].tabGroups = tabGroups;
          changed = true;
        }
      }
      if (changed) await saveWorkspaces(workspaces);
      await browser.storage.local.set({ [STORAGE_KEY_LIVE_TABS]: {} });
    }
  } catch (err) {
    console.warn('[Workspaces] crash-recovery flush failed:', err.message);
  }

  // Rebuild window→workspace map
  try {
    const [allWins, workspaces, map] = await Promise.all([
      browser.windows.getAll({ windowTypes: ['normal'] }),
      getWorkspaces(),
      getWindowMap(),
    ]);

    const validIds = new Set(allWins.map(w => String(w.id)));
    for (const winIdStr of Object.keys(map)) {
      if (!validIds.has(winIdStr)) delete map[winIdStr];
    }

    const alreadyAssigned = new Set(Object.values(map));
    for (const win of allWins) {
      if (map[String(win.id)]) continue;
      const wsId = await browser.sessions.getWindowValue(win.id, 'workspaceId').catch(() => null);
      if (wsId && workspaces[wsId] && !alreadyAssigned.has(wsId)) {
        map[String(win.id)] = wsId;
        alreadyAssigned.add(wsId);
      }
    }

    // Third pass: tab-overlap heuristic for windows with no session value
    for (const win of allWins) {
      if (map[String(win.id)]) continue;
      const winTabs = await browser.tabs.query({ windowId: win.id });
      const winUrls = new Set(winTabs.map(t => t.url).filter(isRestorableUrl));
      if (winUrls.size < 2) continue;
      let bestWsId = null, bestScore = 0;
      for (const [wsId, ws] of Object.entries(workspaces)) {
        if (alreadyAssigned.has(wsId)) continue;
        const wsUrls = new Set((ws.tabs || []).map(t => t.url).filter(isRestorableUrl));
        if (wsUrls.size < 2) continue;
        const intersection = [...winUrls].filter(u => wsUrls.has(u)).length;
        const jaccard = intersection / (winUrls.size + wsUrls.size - intersection);
        if (jaccard > bestScore && jaccard >= 0.5) { bestScore = jaccard; bestWsId = wsId; }
      }
      if (bestWsId) {
        map[String(win.id)] = bestWsId;
        alreadyAssigned.add(bestWsId);
        await markWindowAsWorkspace(win.id, bestWsId);
        console.log(`[Workspaces] Auto-linked window ${win.id} → "${workspaces[bestWsId].name}" (${Math.round(bestScore * 100)}% tab match)`);
      }
    }

    await saveWindowMap(map);
  } catch (err) {
    console.warn('[Workspaces] startup map rebuild failed:', err.message);
  }

  await refreshAllWindows();

  // Handle workspace-open URLs already loaded at startup
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

  // Online/offline tracking for the offline queue
  self.addEventListener('online', () => {
    _isOnline = true;
    flushOfflineQueue().catch(() => {});
  });
  self.addEventListener('offline', () => { _isOnline = false; });

  // Start Firebase real-time listener (no-op if not signed in)
  await setupRemoteListener();

  // Periodic alarm fallback
  await browser.alarms.create('ws-sync-check', { periodInMinutes: 2 });
}

init().catch(err => console.error('[Workspaces] init error:', err));
