'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  workspaces: {},
  colors: [],
  currentWorkspaceId: null,
  currentWindowId: null,
  windowWorkspaceMap: {}
};

// Current form mode: 'create' | 'edit'
let formMode = 'create';
let formFromCurrent = false;
let formWorkspaceId = null;
let formOriginalColor = null;
let formColor = null;
let deleteWorkspaceId = null;
let activeDrop = null;

// ── Messaging ──────────────────────────────────────────────────────────────
const send = msg => browser.runtime.sendMessage(msg);

// ── Views ──────────────────────────────────────────────────────────────────
const V = {
  main: document.getElementById('vMain'),
  form: document.getElementById('vForm'),
  del:  document.getElementById('vDel'),
};

function show(name) {
  for (const [k, el] of Object.entries(V)) el.classList.toggle('on', k === name);
}

// ── Initials ───────────────────────────────────────────────────────────────
function initials(name) {
  const w = name.trim().split(/\s+/);
  return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

// ── Workspace list ─────────────────────────────────────────────────────────
function renderList() {
  const list    = document.getElementById('wsList');
  const entries = Object.values(state.workspaces).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

  if (!entries.length) {
    list.innerHTML = '<div class="empty">No workspaces yet.<br>Create one below.</div>';
    return;
  }

  list.innerHTML = '';
  for (const ws of entries) {
    const active   = ws.id === state.currentWorkspaceId;
    const openInWins = Object.values(state.windowWorkspaceMap).filter(id => id === ws.id).length;

    const row = document.createElement('div');
    row.className = 'ws-row' + (active ? ' active' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    // Used by CSS ::before to draw the left colour bar on active rows
    row.style.setProperty('--dot', ws.color);

    // Dot
    const dot = document.createElement('div');
    dot.className = 'ws-dot';
    dot.style.background = ws.color;
    dot.textContent = initials(ws.name);

    // Name
    const name = document.createElement('span');
    name.className = 'ws-name';
    name.textContent = ws.name;

    // "Current" pill — only visible on active row
    const pill = document.createElement('span');
    pill.className = 'ws-pill' + (active ? '' : ' hidden');
    pill.textContent = 'current';

    // Menu button
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'ws-menu';
    menuBtn.setAttribute('aria-label', 'Options');
    menuBtn.appendChild(mkSvg('0 0 10 10', 'currentColor',
      `<circle cx="1.5" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="8.5" cy="5" r="1"/>`));

    row.append(dot, name, pill, menuBtn);
    list.appendChild(row);

    async function doOpen() {
      try {
        await send({ type: 'OPEN_WORKSPACE', workspaceId: ws.id });
        window.close();
      } catch (err) {
        console.error('[Workspaces] open failed:', err);
      }
    }

    row.addEventListener('click', e => {
      if (e.target.closest('.ws-menu')) return;
      closeDrop();
      doOpen();
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doOpen(); }
    });
    menuBtn.addEventListener('click', e => { e.stopPropagation(); showDrop(menuBtn, ws); });
  }
}

function mkSvg(viewBox, fill, inner) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', fill);
  svg.innerHTML = inner;
  return svg;
}

// ── Dropdown ───────────────────────────────────────────────────────────────
function closeDrop() {
  if (activeDrop) { activeDrop.remove(); activeDrop = null; }
}

function showDrop(anchor, ws) {
  closeDrop();
  const menu = document.createElement('div');
  menu.className = 'drop';

  const rows = [
    { label: 'Edit',   cls: '',    icon: `<path d="M1 8.5V10h1.5l4.5-4.5-1.5-1.5L1 8.5zM9.2 2.3a.7.7 0 000-1L8.7.8a.7.7 0 00-1 0L7 1.5 8.5 3l.7-.7z" fill="currentColor"/>`, action: () => openForm('edit', ws) },
    { label: 'Delete', cls: 'del', icon: `<path d="M.5 2.5h9M3 2.5V1.5h4v1M1.5 2.5l.7 7h5.6l.7-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`, action: () => openDel(ws) },
  ];

  for (const r of rows) {
    const item = document.createElement('div');
    item.className = 'drop-item' + (r.cls ? ' ' + r.cls : '');
    const svg = mkSvg('0 0 10 10', 'none', r.icon);
    svg.style.cssText = 'width:12px;height:12px;flex-shrink:0';
    item.append(svg, document.createTextNode(r.label));
    item.addEventListener('click', () => { closeDrop(); r.action(); });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  activeDrop = menu;

  const rect = anchor.getBoundingClientRect();
  menu.style.top  = rect.bottom + 2 + 'px';
  menu.style.left = Math.max(2, rect.right - 110) + 'px';
}

document.addEventListener('click', e => { if (activeDrop && !activeDrop.contains(e.target)) closeDrop(); });

// ── Form view (create + edit) ──────────────────────────────────────────────
function buildSwatches(selectedColor) {
  const container = document.getElementById('swatches');
  container.innerHTML = '';
  formColor = selectedColor;

  for (const c of state.colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sw' + (c.value === selectedColor ? ' sel' : '');
    btn.style.background = c.value;
    btn.title = c.name;
    btn.addEventListener('click', () => {
      container.querySelectorAll('.sw').forEach(s => s.classList.remove('sel'));
      btn.classList.add('sel');
      formColor = c.value;
    });
    container.appendChild(btn);
  }
}

function openForm(mode, ws, fromCurrent) {
  formMode = mode;
  formFromCurrent   = !!fromCurrent;
  formWorkspaceId   = ws ? ws.id    : null;
  formOriginalColor = ws ? ws.color : null;

  const isEdit = mode === 'edit';
  document.getElementById('formTitle').textContent =
    isEdit ? 'Edit workspace' : (formFromCurrent ? 'New from current tabs' : 'New blank workspace');
  document.getElementById('btnFormOk').textContent  = isEdit ? 'Save' : 'Create';
  document.getElementById('formErr').textContent    = '';

  const existing = Object.values(state.workspaces).map(w => w.name);
  if (isEdit && ws) {
    document.getElementById('fName').value = ws.name;
    buildSwatches(ws.color);
  } else {
    const names = ['Personal', 'Work', 'Research', 'Shopping', 'Social', 'Projects'];
    document.getElementById('fName').value = names.find(n => !existing.includes(n)) || `Workspace ${existing.length + 1}`;
    const usedColors = new Set(Object.values(state.workspaces).map(w => w.color));
    const def = (state.colors.find(c => !usedColors.has(c.value)) || state.colors[0] || { value: '#8764B8' }).value;
    buildSwatches(def);
  }

  show('form');
  document.getElementById('fName').focus();
}

async function submitForm() {
  const name = document.getElementById('fName').value.trim();
  if (!name) { document.getElementById('formErr').textContent = 'Name is required.'; return; }

  const btn = document.getElementById('btnFormOk');
  btn.disabled = true;

  try {
    if (formMode === 'create') {
      const result = await send({
        type: 'CREATE_WORKSPACE',
        name,
        color: formColor || '#8764B8',
        fromCurrentWindow: formFromCurrent,
        windowId: state.currentWindowId
      });
      // Blank workspace: open it immediately in a new window (Edge behaviour)
      if (!formFromCurrent && result && result.workspace) {
        await send({ type: 'OPEN_WORKSPACE', workspaceId: result.workspace.id });
        window.close();
        return;
      }
    } else {
      await send({ type: 'RENAME_WORKSPACE',  workspaceId: formWorkspaceId, name });
      if (formColor !== formOriginalColor) {
        await send({ type: 'RECOLOR_WORKSPACE', workspaceId: formWorkspaceId, color: formColor });
      }
    }
    await loadState();
    show('main');
    renderList();
  } catch (err) {
    document.getElementById('formErr').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Delete view ────────────────────────────────────────────────────────────
function openDel(ws) {
  deleteWorkspaceId = ws.id;
  document.getElementById('delName').textContent = ws.name;
  show('del');
}

async function submitDel() {
  const btn = document.getElementById('btnDelOk');
  btn.disabled = true;
  try {
    await send({ type: 'DELETE_WORKSPACE', workspaceId: deleteWorkspaceId });
    await loadState();
    show('main');
    renderList();
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ── Load state ─────────────────────────────────────────────────────────────
async function loadState() {
  const r = await send({ type: 'GET_STATE' });
  state.workspaces         = r.workspaces         || {};
  state.currentWorkspaceId = r.currentWorkspaceId || null;
  state.currentWindowId    = r.currentWindowId    || null;
  state.windowWorkspaceMap = r.windowWorkspaceMap  || {};
  state.colors             = r.colors             || [];
}

// ── Event wiring ───────────────────────────────────────────────────────────
document.getElementById('btnFromTabs').onclick = () => openForm('create', null, true);
document.getElementById('btnBlank').onclick    = () => openForm('create', null, false);

document.getElementById('btnBack').onclick       = () => { show('main'); };
document.getElementById('btnFormCancel').onclick = () => { show('main'); };
document.getElementById('btnFormOk').onclick     = submitForm;
document.getElementById('fName').addEventListener('keydown', e => {
  if (e.key === 'Enter')  submitForm();
  if (e.key === 'Escape') show('main');
  document.getElementById('formErr').textContent = '';
});

document.getElementById('btnDelCancel').onclick = () => show('main');
document.getElementById('btnDelOk').onclick     = submitDel;

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await loadState();
    show('main');
    renderList();
  } catch (err) {
    const list = document.getElementById('wsList');
    list.innerHTML = `<div class="empty">Failed to load.<br><small>${err.message}</small></div>`;
    show('main');
  }
  // Reveal the popup only after content is ready — eliminates loading flash
  document.body.style.visibility = 'visible';
})();
