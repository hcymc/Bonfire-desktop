import {
  $, $$, human, fmtDate, extOf, iconClass, previewKind, toast, status, emptyNode, skeletonList, paintAvatar, ask, confirmAsk, setupIcons, applyAppearance,
} from './ui.js';
import { setupTransfer } from './transfer.js';
import { setupPreview, openPreview, previewable } from './preview.js';
import { setupSettings, hydrate } from './settings.js';
import { setupEmailVerify } from './email-verify.js';

const state = {
  boot: null,
  profile: null,
  settings: null,
  server: null,
  authed: false,
  view: 'files',
  folderId: null,
  breadcrumb: [],
  folders: [],
  files: [],
  sel: new Set(),
  anchor: -1,
  sort: { key: 'name', desc: false },
  query: '',
  downloadDir: '',
};

setupIcons();

// ---------- boot ----------
async function boot() {
  const b = await window.bonfire.boot();
  Object.assign(state, {
    boot: b,
    settings: b.settings,
    server: b.server,
    authed: b.authed,
    profile: b.profile,
    email: b.email ?? null,
    downloadDir: b.downloadDir,
  });
  applyAppearance(b.settings);
  renderIdentity(b.profile);
  renderQuota();
  setupPreview();
  setupTransfer({ initial: b.transfers, downloadDir: b.downloadDir });
  setupSettings({ state, refreshIdentity: renderIdentity, onServerChanged: () => location.reload() });
  wireChrome();
  const emailVerify = setupEmailVerify(state, {
    onLoggedIn: async (user) => {
      renderIdentity(user);
      await loadFiles();
      emailVerify?.syncEmail(state.email);
      maybeEmailNudge();
    },
    refreshSettings: () => { if (state.view === 'settings') hydrate(); },
  });
  wireList();
  wireDrag();
  wireEmailNudge();
  maybeEmailNudge();
  window.bonfire.onWindowState(({ maximized }) => document.body.classList.toggle('maximized', !!maximized));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(state.settings));
  window.bonfire.onFilesChanged(async () => {
    if (state.view === 'files') await loadFiles(true);
    try {
      renderIdentity(await window.bonfire.getProfile());
    } catch {
      /* the next action surfaces it */
    }
  });
  window.bonfire.onTrayAction((m) => {
    if (m?.action === 'pick-upload') uploadClicked();
  });

  if (!b.server.ok) return openLogin('服务器地址无效，请先设置。');
  if (b.authed) {
    try {
      const r = await window.bonfire.checkSession();
      if (r.authed) {
        renderIdentity(r.profile);
        return loadFiles();
      }
    } catch (err) {
      return openLogin(err.message);
    }
  }
  openLogin();
}

function renderIdentity(profile) {
  state.profile = profile;
  paintAvatar($('#meAvatar'), profile);
  $('#who').textContent = profile ? profile.display_name || profile.username : '未登录';
  $('#quotaHost').textContent = profile ? `@${profile.username}` : '未连接';
  renderQuota();
  if (state.view === 'settings') hydrate();
}

// 未绑邮箱提醒：登录后显示，关闭后本机不再提示
function maybeEmailNudge() {
  const box = $('#emailNudge');
  if (!box) return;
  const need = state.authed && state.email == null && localStorage.getItem('emailNudgeHide') !== '1';
  box.classList.toggle('hidden', !need);
}

function wireEmailNudge() {
  $('#emailNudgeGo')?.addEventListener('click', () => {
    $('#emailNudge').classList.add('hidden');
    showView('settings');
    setTimeout(() => $('#pfEmail')?.focus(), 120);
  });
  $('#emailNudgeClose')?.addEventListener('click', () => {
    $('#emailNudge').classList.add('hidden');
    localStorage.setItem('emailNudgeHide', '1');
  });
}

function renderQuota() {
  const p = state.profile;
  if (!p) {
    $('#quotaText').textContent = '—';
    $('#quotaTotal').textContent = '';
    $('#quotaFill').style.width = '0%';
    return;
  }
  const pct = p.quota_bytes > 0 ? Math.min(100, (p.used_bytes / p.quota_bytes) * 100) : 0;
  $('#quotaFill').style.width = `${pct.toFixed(1)}%`;
  $('#quotaText').textContent = human(p.used_bytes);
  $('#quotaTotal').textContent = `${human(p.quota_bytes)} · ${pct.toFixed(0)}%`;
}

// ---------- login ----------
function openLogin(message) {
  const dlg = $('#loginDialog');
  $('#lgUrl').value = state.server?.ok ? state.server.url : 'http://127.0.0.1:8787';
  $('#lgErr').classList.add('hidden');
  $('#lgAck').checked = !!state.settings?.allowInsecureRemote;
  probeLoginUrl();
  if (message) loginError(message);
  window.bonfire.savedCredential().then((c) => {
    if (!c) return;
    $('#lgUser').value = c.username;
    $('#lgRemember').checked = true;
  }).catch(() => {});
  dlg.showModal();
  ($('#lgUser').value ? $('#lgPass') : $('#lgUser')).focus();
}

function loginError(message) {
  const el = $('#lgErr');
  el.textContent = message;
  el.classList.remove('hidden');
}

async function probeLoginUrl() {
  const r = await window.bonfire.checkServer($('#lgUrl').value).catch(() => null);
  if (!r) return;
  $('#lgAckRow').classList.toggle('hidden', !(r.ok && r.needsAck));
}

// ---------- chrome ----------
function wireChrome() {
  $('#accountBtn').addEventListener('click', () => showView('settings'));
  // 登录/注册由 email-verify.js 统一接管（含邮箱验证码与忘记密码）
  $('#lgUrl').addEventListener('input', probeLoginUrl);
  $('#lgSkip').addEventListener('click', () => {
    $('#loginDialog').close();
    status('未登录：在设置里填好地址后点「重新登录」');
  });
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    $('#searchClear').classList.toggle('hidden', !state.query);
    renderList();
  });
  $('#searchClear').addEventListener('click', () => {
    $('#search').value = '';
    state.query = '';
    $('#searchClear').classList.add('hidden');
    renderList();
    $('#fileList').focus();
  });
  $('#detailsClose').addEventListener('click', () => toggleDetails(false));
  $$('.rail .nav').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));
  $$('.cmd[data-cmd]').forEach((b) => b.addEventListener('click', () => runCommand(b.dataset.cmd)));
  $('#shareRefresh').addEventListener('click', loadShares);
  $('#recycleRefresh').addEventListener('click', loadRecycle);
  $$('#listHead [data-sort]').forEach((h) => h.addEventListener('click', () => sortBy(h.dataset.sort)));
}

function showView(name) {
  state.view = name;
  $$('.rail .nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('main .view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  $('.cmdbar').classList.toggle('hidden', name !== 'files');
  $('#search').parentElement.classList.toggle('hidden', name !== 'files');
  $('#details').classList.add('hidden');
  if (name === 'files') loadFiles();
  if (name === 'shares') loadShares();
  if (name === 'recycle') loadRecycle();
  if (name === 'settings') hydrate();
}

// ---------- files ----------
async function loadFiles(quiet = false) {
  if (!state.authed) return;
  const host = $('#fileList');
  if (!quiet) skeletonList(host, 6);
  let data;
  try {
    data = await window.bonfire.listFiles(state.folderId);
  } catch (err) {
    host.textContent = '';
    host.appendChild(emptyNode(err.message, 'i-warn'));
    if (err.status === 401) {
      state.authed = false;
      openLogin('登录已过期，请重新登录。');
    }
    return;
  }
  state.folders = data.folders;
  state.files = data.files;
  state.breadcrumb = data.breadcrumb;
  state.sel.clear();
  state.anchor = -1;
  renderCrumbs();
  renderList();
  renderQuota();
  syncCommands();
}

function renderCrumbs() {
  const host = $('#crumbs');
  host.textContent = '';
  const add = (label, id, here = false) => {
    if (host.children.length) {
      const s = document.createElement('span');
      s.className = 'sep i i-chevright';
      host.appendChild(s);
    }
    const b = document.createElement('button');
    b.textContent = label;
    if (here) b.classList.add('here');
    b.addEventListener('click', () => {
      state.folderId = id;
      loadFiles();
    });
    host.appendChild(b);
  };
  add('我的文件', null, !state.breadcrumb.length);
  state.breadcrumb.forEach((f, i) => add(f.name, f.id, i === state.breadcrumb.length - 1));
}

function rows() {
  const q = state.query.toLowerCase();
  const keep = (x) => !q || String(x.name).toLowerCase().includes(q);
  const dir = state.sort.desc ? -1 : 1;
  const cmp = (a, b) => {
    if (state.sort.key === 'size') return ((a.size || 0) - (b.size || 0)) * dir;
    if (state.sort.key === 'date') return (String(a.updated_at || a.created_at) > String(b.updated_at || b.created_at) ? 1 : -1) * dir;
    return String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }) * dir;
  };
  return [
    ...state.folders.filter(keep).sort(cmp).map((f) => ({ ...f, isFolder: true })),
    ...state.files.filter(keep).sort(cmp),
  ];
}

function sortBy(key) {
  if (!key) return;
  if (state.sort.key === key) state.sort.desc = !state.sort.desc;
  else state.sort = { key, desc: false };
  $$('#listHead [data-sort]').forEach((h) => {
    h.classList.toggle('sorted', h.dataset.sort === state.sort.key);
    h.classList.toggle('desc', h.dataset.sort === state.sort.key && state.sort.desc);
  });
  renderList();
}

function renderList() {
  const host = $('#fileList');
  const list = rows();
  host.textContent = '';
  if (!list.length) {
    host.appendChild(emptyNode(state.query ? `没有匹配「${state.query}」的项目` : '把这个文件夹点火星吧，拖文件进来即可上传', 'i-folder'));
    $('#fileList').setAttribute('aria-label', '空文件夹');
    syncStatus();
    return;
  }
  list.forEach((item, i) => host.appendChild(rowEl(item, i)));
  syncStatus();
  renderDetails();
}

function rowEl(item, index) {
  const r = document.createElement('div');
  r.className = 'r';
  r.dataset.id = String(item.id);
  r.dataset.index = String(index);
  r.dataset.kind = item.isFolder ? 'folder' : 'file';
  r.setAttribute('role', 'option');
  r.tabIndex = -1;

  const ic = document.createElement('span');
  ic.className = 'c-ic';
  const thumb = item.isFolder ? null : thumbnailFor(item);
  if (thumb) ic.appendChild(thumb);
  else {
    const i = document.createElement('i');
    i.className = `i ${iconClass(item.name, item.isFolder)}`;
    ic.appendChild(i);
  }

  const name = document.createElement('span');
  name.className = 'c-name';
  name.textContent = item.name;
  name.title = item.name;

  const size = document.createElement('span');
  size.className = 'c-size num';
  size.textContent = item.isFolder ? '' : human(item.size);

  const date = document.createElement('span');
  date.className = 'c-date';
  date.textContent = fmtDate(item.updated_at || item.created_at);

  r.append(ic, name, size, date);
  if (state.sel.has(item.id)) r.classList.add('sel');
  return r;
}

function thumbnailFor(item) {
  if (previewKind(item.name) !== 'image') return null;
  if (Number(item.size) > 8 * 1024 * 1024) return null;
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    const i = document.createElement('i');
    i.className = 'i i-image';
    img.replaceWith(i);
  });
  window.bonfire.mediaUrl({ kind: 'preview', id: item.id }).then((u) => {
    img.src = u;
  }).catch(() => {});
  return img;
}

function currentItem() {
  const list = rows();
  if (state.sel.size === 1) {
    const id = [...state.sel][0];
    return list.find((x) => x.id === id) || null;
  }
  if (state.anchor >= 0 && list[state.anchor]) return list[state.anchor];
  return null;
}

function syncStatus() {
  const list = rows();
  const parts = [`${list.length} 个项目`];
  if (state.sel.size) parts.push(`已选 ${state.sel.size}`);
  if (state.profile) parts.push(`可用 ${human(Math.max(0, state.profile.quota_bytes - state.profile.used_bytes))}`);
  $('#statusText').textContent = parts.join(' · ');
}

function syncCommands() {
  const one = state.sel.size === 1 ? currentItem() : null;
  const any = state.sel.size > 0;
  const isFolder = !!one?.isFolder;
  const set = (cmd, on) => {
    const b = $(`.cmd[data-cmd="${cmd}"]`);
    if (b) b.disabled = !on;
  };
  set('open', any);
  set('download', any && !isFolder);
  set('rename', !!one);
  set('move', any);
  set('share', !!one && !isFolder);
  set('delete', any);
  $('#cmdDetails').classList.toggle('on', !$('#details').classList.contains('hidden'));
}

function select(id, { additive = false, range = false } = {}) {
  const list = rows();
  const at = list.findIndex((x) => x.id === id);
  if (at === -1) return;
  if (range && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, at), Math.max(state.anchor, at)];
    state.sel = new Set(list.slice(a, b + 1).map((x) => x.id));
  } else if (additive) {
    if (state.sel.has(id)) state.sel.delete(id);
    else state.sel.add(id);
    state.anchor = at;
  } else {
    state.sel = new Set([id]);
    state.anchor = at;
  }
  $$('#fileList .r').forEach((r) => r.classList.toggle('sel', state.sel.has(Number(r.dataset.id)) || state.sel.has(String(r.dataset.id))));
  syncCommands();
  syncStatus();
  renderDetails();
}

function selectIndex(i) {
  const list = rows();
  const at = Math.max(0, Math.min(list.length - 1, i));
  select(list[at].id, { additive: false });
  const el = $(`#fileList .r[data-index="${at}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

// ---------- list interaction ----------
function wireList() {
  const host = $('#fileList');
  host.addEventListener('mousedown', (e) => {
    const r = e.target.closest('.r');
    if (!r) {
      state.sel.clear();
      $$('#fileList .r').forEach((x) => x.classList.remove('sel'));
      syncCommands();
      syncStatus();
      renderDetails();
      return;
    }
    host.focus();
    const id = Number(r.dataset.id);
    select(id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
  });
  host.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.r');
    if (r) openItem(itemFromRow(r));
  });
  host.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const r = e.target.closest('.r');
    const item = r ? itemFromRow(r) : null;
    if (item && !state.sel.has(item.id)) select(item.id);
    const choice = await nativeMenu(menuFor(item), e);
    if (choice) runCommand(choice, item);
  });
  $('#fileList').addEventListener('keydown', onListKeys);
  $('#recycleList')?.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const r = e.target.closest('.r');
    if (!r) return;
    const item = itemFromRow(r);
    const choice = await nativeMenu(item.phase === 'recycle' ? [] : menuForRecycle(item), e);
    if (choice === 'restore') restoreRecycle(item);
    if (choice === 'purge') purgeRecycle(item);
  });
  $('#recycleList')?.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.r');
    if (r) restoreRecycle(itemFromRow(r));
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      showView('files');
      $('#search').focus();
    }
    if (e.key === 'F5') {
      e.preventDefault();
      loadFiles();
    }
  });
}

function itemFromRow(r) {
  const id = Number(r.dataset.id);
  const list = rows();
  return list.find((x) => x.id === id) || null;
}

function onListKeys(e) {
  const list = rows();
  if (!list.length) return;
  const at = state.anchor;
  const map = {
    ArrowDown: () => selectIndex(at + 1),
    ArrowUp: () => selectIndex(at - 1),
    Home: () => selectIndex(0),
    End: () => selectIndex(list.length - 1),
    Enter: () => {
      const it = currentItem();
      if (it) openItem(it);
    },
    F2: () => runCommand('rename'),
    Delete: () => runCommand('delete'),
  };
  if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    state.sel = new Set(list.map((x) => x.id));
    $$('#fileList .r').forEach((r) => r.classList.add('sel'));
    syncCommands();
    syncStatus();
    return;
  }
  if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (state.breadcrumb.length) {
      state.folderId = state.breadcrumb.length > 1 ? state.breadcrumb[state.breadcrumb.length - 2].id : null;
      loadFiles();
    }
    return;
  }
  if (map[e.key]) {
    e.preventDefault();
    if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.id, { range: true });
      return;
    }
    map[e.key]();
  }
}

async function nativeMenu(actions, e) {
  try {
    return await window.bonfire.contextMenu({ actions, x: e.clientX, y: e.clientY });
  } catch {
    return null;
  }
}

function menuFor(item) {
  if (!item) {
    return [{ id: 'upload' }, { id: 'mkdir', separatorBefore: true }, { id: 'refresh', separatorBefore: true }, { id: 'select-all', separatorBefore: true }];
  }
  if (item.isFolder) return [{ id: 'open' }, { id: 'rename' }, { id: 'move' }, { id: 'delete', separatorBefore: true }];
  const out = [];
  if (previewKind(item.name)) out.push({ id: 'preview' });
  out.push({ id: 'download' }, { id: 'rename' }, { id: 'move' }, { id: 'share' }, { id: 'delete', separatorBefore: true }, { id: 'properties', separatorBefore: true });
  return out;
}

function menuForRecycle(item) {
  return [{ id: 'restore' }, { id: 'purge', separatorBefore: true }];
}

function openItem(item) {
  if (!item) return;
  if (item.isFolder) {
    state.folderId = item.id;
    loadFiles();
    return;
  }
  if (previewable(item)) openPreview(item, state.files);
  else runCommand('download', item);
}

// ---------- commands ----------
async function runCommand(cmd, explicit) {
  const item = explicit || currentItem();
  const many = rows().filter((x) => state.sel.has(x.id));
  switch (cmd) {
    case 'upload':
      return uploadClicked();
    case 'mkdir':
      return createFolder();
    case 'refresh':
      return loadFiles();
    case 'select-all': {
      const list = rows();
      state.sel = new Set(list.map((x) => x.id));
      $$('#fileList .r').forEach((r) => r.classList.add('sel'));
      syncCommands();
      syncStatus();
      return;
    }
    case 'open':
      return openItem(item);
    case 'preview':
      if (item && !item.isFolder) openPreview(item, state.files);
      return;
    case 'download':
      return downloadMany(many.length ? many : [item]);
    case 'rename':
      return renameItem(item);
    case 'move':
      return moveMany(many.length ? many : [item]);
    case 'share':
      return shareDialog(item);
    case 'delete':
      return deleteMany(many.length ? many : [item]);
    case 'properties':
      toggleDetails(true);
      return;
    case 'details':
      return toggleDetails($('#details').classList.contains('hidden'));
    default:
      return undefined;
  }
}

function toggleDetails(on) {
  $('#details').classList.toggle('hidden', !on);
  $('#cmdDetails').classList.toggle('on', !!on);
  if (on) renderDetails();
}

function renderDetails() {
  const host = $('#dBody');
  const item = currentItem();
  if (!host) return;
  host.textContent = '';
  if (!item) {
    host.appendChild(emptyNode('选择一个项目查看详情', 'i-info'));
    return;
  }
  const hero = document.createElement('div');
  hero.className = 'd-hero';
  if (previewKind(item.name) === 'image') {
    const img = document.createElement('img');
    img.alt = '';
    window.bonfire.mediaUrl({ kind: 'preview', id: item.id }).then((u) => {
      img.src = u;
    }).catch(() => {});
    hero.appendChild(img);
  } else {
    const i = document.createElement('i');
    i.className = `i ${iconClass(item.name, item.isFolder)}`;
    hero.appendChild(i);
  }
  const name = document.createElement('div');
  name.className = 'd-name';
  name.textContent = item.name;
  const dl = document.createElement('dl');
  dl.className = 'd-rows';
  const path = ['我的文件', ...state.breadcrumb.map((b) => b.name)].join(' / ');
  const add = (k, v) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  };
  add('类型', item.isFolder ? '文件夹' : previewKind(item.name) || extOf(item.name).toUpperCase() || '文件');
  if (!item.isFolder) add('大小', human(item.size));
  add('位置', path);
  add('更新', fmtDate(item.updated_at || item.created_at) || '—');
  if (!item.isFolder) add('ID', `#${item.id}`);
  const acts = document.createElement('div');
  acts.className = 'd-actions';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', fn);
    acts.appendChild(b);
  };
  if (!item.isFolder) mk('下载', 'primary', () => downloadMany([item]));
  else mk('打开', 'primary', () => openItem(item));
  mk('重命名', 'ghost', () => renameItem(item));
  mk('移到回收站', 'danger', () => deleteMany([item]));
  host.append(hero, name, dl, acts);
}

async function uploadClicked() {
  try {
    const paths = await window.bonfire.pickUploadPaths();
    if (!paths?.length) return;
    await window.bonfire.addUploads({ paths, folderId: state.folderId });
    showView('transfer');
    toast(`已加入队列 ${paths.length} 个文件`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function createFolder() {
  const name = await ask({ title: '新建文件夹', value: '', okLabel: '创建', validate: (v) => (v ? null : '请输入名称') });
  if (!name) return;
  try {
    await window.bonfire.createFolder({ name, parentId: state.folderId });
    toast('已创建', 'ok');
    loadFiles(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renameItem(item) {
  if (!item) return;
  const name = await ask({ title: '重命名', value: item.name, okLabel: '保存' });
  if (!name || name === item.name) return;
  try {
    const r = item.isFolder ? await window.bonfire.renameFolder({ id: item.id, name }) : await window.bonfire.renameFile({ id: item.id, name });
    toast(`已重命名为 ${r.name}`, 'ok');
    loadFiles(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function moveMany(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  const options = await collectFolders();
  const target = await askSelect({ title: `移动 ${list.length} 个项目到`, options: [{ id: null, name: '我的文件' }, ...options] });
  if (target === undefined) return;
  let moved = 0;
  const errors = [];
  for (const it of list) {
    if (it.isFolder && it.id === target) continue;
    try {
      if (it.isFolder) await window.bonfire.moveFolder({ id: it.id, folderId: target });
      else await window.bonfire.moveFile({ id: it.id, folderId: target });
      moved++;
    } catch (err) {
      errors.push(`${it.name}：${err.message}`);
    }
  }
  if (moved) toast(`已移动 ${moved} 个项目`, 'ok');
  if (errors.length) toast(errors[0], 'err');
  loadFiles(true);
}

async function deleteMany(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  const label = list.length === 1 ? `「${list[0].name}」` : `这 ${list.length} 个项目`;
  const yes = await confirmAsk({ title: `把${label}移到回收站？`, hint: '之后可以从回收站还原。', okLabel: '移到回收站', danger: true });
  if (!yes) return;
  let n = 0;
  for (const it of list) {
    try {
      if (it.isFolder) await window.bonfire.deleteFolder(it.id);
      else await window.bonfire.deleteFile(it.id);
      n++;
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  if (n) toast(`已移到回收站 ${n} 项`, 'ok');
  state.sel.clear();
  loadFiles(true);
}

async function downloadMany(items) {
  const list = (items || []).filter((x) => x && !x.isFolder);
  if (!list.length) return;
  try {
    for (const it of list) await window.bonfire.startDownload({ fileId: it.id, name: it.name, size: it.size });
    showView('transfer');
    status(`下载 ${list.length} 个项目 → ${state.downloadDir}`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function collectFolders() {
  const out = [];
  const queue = [{ id: null, depth: 0 }];
  while (queue.length && out.length < 300) {
    const { id, depth } = queue.shift();
    if (depth > 5) continue;
    try {
      const data = await window.bonfire.listFiles(id);
      for (const f of data.folders) {
        out.push({ id: f.id, name: `${' '.repeat(depth * 2)}${f.name}` });
        queue.push({ id: f.id, depth: depth + 1 });
      }
    } catch {
      break;
    }
  }
  return out;
}

function askSelect({ title, options }) {
  return new Promise((resolve) => {
    const dlg = $('#askDialog');
    const slot = $('#askSlot');
    $('#askTitle').textContent = title;
    $('#askHint').textContent = '';
    $('#askErr').classList.add('hidden');
    $('#askInput').classList.add('hidden');
    $('#askOk').classList.add('hidden');
    slot.textContent = '';
    slot.classList.remove('hidden');
    let picked;
    for (const o of options) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = o.name;
      b.addEventListener('click', () => {
        picked = o.id;
        dlg.close();
      });
      slot.appendChild(b);
    }
    if (!options.length) slot.appendChild(emptyNode('还没有文件夹', 'i-newfolder'));
    const cancel = () => dlg.close();
    $('#askCancel').addEventListener('click', cancel, { once: true });
    dlg.addEventListener('close', () => {
      slot.classList.add('hidden');
      $('#askInput').classList.remove('hidden');
      $('#askOk').classList.remove('hidden');
      resolve(picked);
    }, { once: true });
    dlg.showModal();
  });
}

// ---------- drag ----------
let dragDepth = 0;
function wireDrag() {
  const veil = $('#dropVeil');
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    veil.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const r = e.target.closest?.('.r[data-kind="folder"]');
    $$('#fileList .drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (r) r.classList.add('drop-target');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) veil.classList.add('hidden');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e) || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    veil.classList.add('hidden');
    $$('#fileList .drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (!state.authed) return toast('请先登录', 'err');
    const targetFolder = e.target.closest?.('.r[data-kind="folder"]');
    const paths = [];
    let skipped = 0;
    for (const f of e.dataTransfer.files) {
      const p = window.bonfire.pathForFile(f);
      if (p) paths.push(p);
      else skipped++;
    }
    if (!paths.length) return toast('这些项目没有本地路径，请从资源管理器拖入', 'err');
    if (targetFolder) {
      const item = itemFromRow(targetFolder);
      const local = rows().filter((x) => state.sel.has(x.id));
      if (local.length) {
        await moveMany(local.map((x) => ({ ...x })));
        return;
      }
      void item;
    }
    await window.bonfire.addUploads({ paths, folderId: state.folderId });
    showView('transfer');
    toast(`已加入队列 ${paths.length} 个文件${skipped ? `，跳过 ${skipped} 个` : ''}`, 'ok');
  });
}

// ---------- shares ----------
async function loadShares() {
  const host = $('#shareList');
  skeletonList(host, 3);
  let data;
  try {
    data = await window.bonfire.listShares();
  } catch (err) {
    host.textContent = '';
    host.appendChild(emptyNode(err.message, 'i-warn'));
    return;
  }
  host.textContent = '';
  if (!data.shares.length) {
    host.appendChild(emptyNode('还没有分享，在文件上按右键创建一条', 'i-link'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'grid';
  table.appendChild(head(['文件', '链接', '访问', '过期', '密码', '']));
  const tbody = document.createElement('tbody');
  for (const s of data.shares) {
    const tr = document.createElement('tr');
    tr.append(td(s.file_name), td(`${state.server.url}/s/${s.token.slice(0, 10)}…`), td(`${s.hits}${s.max_hits ? `/${s.max_hits}` : ''}`), td(s.expires_at ? fmtDate(s.expires_at) : '永久'), td(s.needs_password ? '有' : '无'));
    const act = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'btn sm ghost danger';
    b.textContent = '撤销';
    b.addEventListener('click', async () => {
      const yes = await confirmAsk({ title: '撤销这条分享？', hint: '任何人拿到链接都将无法访问。', okLabel: '撤销', danger: true });
      if (!yes) return;
      try {
        await window.bonfire.deleteShare(s.id);
        toast('已撤销', 'ok');
        loadShares();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    act.appendChild(b);
    tr.appendChild(act);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function head(labels) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const l of labels) {
    const th = document.createElement('th');
    th.textContent = l;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

function td(text) {
  const t = document.createElement('td');
  t.textContent = text;
  return t;
}

async function shareDialog(file) {
  if (!file || file.isFolder) return toast('文件夹不能分享', 'err');
  const value = await askShare(file);
  if (!value) return;
  try {
    const r = await window.bonfire.createShare({ fileId: file.id, ...value });
    const url = `${state.server.url}${r.url}`;
    const again = await ask({ title: '分享链接已生成', value: url, okLabel: '复制' });
    if (again) await navigator.clipboard.writeText(again).catch(() => {});
    toast('分享已创建', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function askShare(file) {
  return new Promise((resolve) => {
    const dlg = $('#shareDialog');
    $('#shName').textContent = file.name;
    $('#shExpire').value = '0';
    $('#shHits').value = '';
    $('#shPass').value = '';
    $('#shErr').classList.add('hidden');
    let result;
    $('#shOk').onclick = () => {
      const body = {};
      const secs = Number($('#shExpire').value) || 0;
      const hits = Number($('#shHits').value);
      if (secs) body.expiresIn = secs;
      if (hits) body.maxHits = hits;
      if ($('#shPass').value) body.password = $('#shPass').value;
      result = body;
      dlg.close();
    };
    $('#shCancel').onclick = () => dlg.close();
    dlg.addEventListener('close', () => resolve(result || null), { once: true });
    dlg.showModal();
  });
}

// ---------- recycle ----------
async function loadRecycle() {
  const host = $('#recycleList');
  skeletonList(host, 3);
  let data;
  try {
    data = await window.bonfire.recycleList();
  } catch (err) {
    host.textContent = '';
    host.appendChild(emptyNode(err.message, 'i-warn'));
    return;
  }
  host.textContent = '';
  const items = [
    ...data.folders.map((f) => ({ ...f, isFolder: true, phase: 'recycle' })),
    ...data.files.map((f) => ({ ...f, phase: 'recycle' })),
  ];
  if (!items.length) {
    host.appendChild(emptyNode('回收站是空的', 'i-trash'));
    $('#statusText').textContent = '回收站 · 0 个项目';
    return;
  }
  items.forEach((it, i) => host.appendChild(recycleRow(it, i)));
  $('#statusText').textContent = `回收站 · ${items.length} 个项目`;
}

function recycleRow(item, index) {
  const r = document.createElement('div');
  r.className = 'r';
  r.dataset.id = String(item.id);
  r.dataset.index = String(index);
  r.dataset.kind = item.isFolder ? 'folder' : 'file';
  const ic = document.createElement('span');
  ic.className = 'c-ic';
  const i = document.createElement('i');
  i.className = `i ${iconClass(item.name, item.isFolder)}`;
  ic.appendChild(i);
  const name = document.createElement('span');
  name.className = 'c-name';
  name.textContent = item.name;
  name.title = `删除于 ${fmtDate(item.deleted_at)}`;
  const size = document.createElement('span');
  size.className = 'c-size num';
  size.textContent = item.isFolder ? '' : human(item.size);
  const acts = document.createElement('span');
  acts.className = 'c-acts';
  for (const [label, glyph, fn] of [
    ['还原', 'i-undo', () => restoreRecycle(item)],
    ['彻底删除', 'i-trash', () => purgeRecycle(item)],
  ]) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    const g = document.createElement('i');
    g.className = `i ${glyph}`;
    b.appendChild(g);
    b.addEventListener('click', fn);
    acts.appendChild(b);
  }
  r.append(ic, name, size, acts);
  return r;
}

async function restoreRecycle(item) {
  try {
    await window.bonfire.recycleRestore({ kind: item.isFolder ? 'folder' : 'file', id: item.id });
    toast('已还原', 'ok');
    loadRecycle();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function purgeRecycle(item) {
  const yes = await confirmAsk({ title: `彻底删除「${item.name}」？`, hint: '不可恢复，空间会立即释放。', okLabel: '彻底删除', danger: true });
  if (!yes) return;
  try {
    await window.bonfire.recyclePurge({ kind: item.isFolder ? 'folder' : 'file', id: item.id });
    toast('已彻底删除', 'ok');
    loadRecycle();
    renderQuota();
  } catch (err) {
    toast(err.message, 'err');
  }
}

boot().catch((err) => {
  status(`启动失败：${err.message}`);
  toast(err.message, 'err');
});
