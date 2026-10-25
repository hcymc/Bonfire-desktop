import os from 'node:os';
import { mediaUrlFor, resolveMediaUrl } from './proxy.js';
import { parseServerUrl } from './config.js';
import { updateDecision } from './update.js';
import { sanitizeName } from './filenames.js';

const AVATAR_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const AVATAR_MAX = 2 * 1024 * 1024;

const MENU_LABELS = {
  open: '打开',
  preview: '预览',
  download: '下载',
  'open-location': '打开所在文件夹',
  rename: '重命名',
  move: '移动到…',
  share: '创建分享链接',
  'copy-link': '复制分享链接',
  delete: '移到回收站',
  restore: '还原',
  purge: '彻底删除',
  'new-folder': '新建文件夹',
  upload: '上传文件…',
  refresh: '刷新',
  'select-all': '全选',
  'empty-recycle': '清空回收站',
  properties: '属性',
};

function shapeError(err) {
  return {
    message: String(err?.message || '操作失败'),
    status: Number(err?.status) || 0,
    code: err?.code || null,
  };
}

const intOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1e12) throw new Error('参数无效');
  return n;
};

export function registerIpc({ ipcMain, state, deps }) {
  const { app, dialog, shell, path, fs } = deps;
  const { client, uploads, downloads } = state;

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(...args, event) };
      } catch (err) {
        return { ok: false, error: shapeError(err) };
      }
    });

  const persistSession = () => {
    if (!vaultAvailable()) return;
    vaultSet('cookieJar', JSON.stringify(client.serializeJar()));
  };

  function vaultAvailable() {
    return state.vaultCanPersist();
  }
  const vaultSet = (k, v) => state.vault.set(k, v);

  // ---- boot / session ----
  // 当前账号绑定的邮箱（null=未绑定），随 boot/login/session-check 同步
  let clientEmail = null;

  handle('bonfire:boot', () => ({
    version: app.getVersion(),
    platform: process.platform,
    settings: state.settings,
    server: state.serverKind,
    authed: state.authed,
    profile: state.profile,
    email: clientEmail,
    vaultCanPersist: vaultAvailable(),
    transfers: state.transferLog(),
    downloadDir: state.downloadDir(),
  }));

  handle('bonfire:session:check', async () => {
    if (!state.authed) return { authed: false };
    try {
      const me = await client.me();
      state.setProfile(me.user);
      clientEmail = me.email ?? null;
      persistSession();
      return { authed: true, profile: me.user, email: clientEmail };
    } catch (err) {
      if (err.status === 401) {
        state.vault.unset('cookieJar');
        client.resetSession();
        state.setProfile(null);
      }
      throw err;
    }
  });

  handle('bonfire:login', async ({ username, password, remember, register, email, code }) => {
    const u = String(username || '').trim();
    if (!u || typeof password !== 'string' || !password) throw new Error('请输入用户名和密码');
    const r = register
      ? await client.register(u, password, email ? String(email) : undefined, code ? String(code) : undefined)
      : await client.login(u, password);
    const me = await client.me();
    const user = me.user;
    clientEmail = me.email ?? null;
    state.setProfile(user);
    persistSession();
    if (remember && vaultAvailable()) state.vault.set('credential', JSON.stringify({ username: u, password }));
    else state.vault.unset('credential');
    return { user, csrf: r.csrf, stored: remember && vaultAvailable() };
  });

  handle('bonfire:saved-credential', () => {
    const raw = state.vault.get('credential');
    if (!raw) return null;
    try {
      const c = JSON.parse(raw);
      return typeof c.username === 'string' ? { username: c.username, hasPassword: !!c.password } : null;
    } catch {
      state.vault.unset('credential');
      return null;
    }
  });

  handle('bonfire:forget-credential', () => {
    state.vault.unset('credential');
    return true;
  });

  handle('bonfire:logout', async () => {
    try {
      await client.logout();
    } finally {
      client.resetSession();
      state.vault.unset('cookieJar');
      state.setProfile(null);
    }
    return true;
  });

  // ---- server + settings ----
  // checkbox that is hidden exactly when it is needed.
  handle('bonfire:server:check', (url) => parseServerUrl(String(url ?? '')));

  handle('bonfire:server:set', async ({ url, allowInsecureRemote }) => {
    const parsed = parseServerUrl(url);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.needsAck && !allowInsecureRemote) {
      throw new Error('该地址是公网明文 http，会话会被窃听。请改用 https，或勾选「我知情，仍要连接」。');
    }
    state.saveSettings({ serverUrl: parsed.url, allowInsecureRemote: !!allowInsecureRemote });
    client.resetSession();
    state.vault.unset('cookieJar');
    state.setProfile(null);
    try {
      await client.me();
      return { reachable: true, server: parsed };
    } catch (err) {
      if (err.code === 'network') throw new Error(`连不上：${err.message}`);
      return { reachable: false, server: parsed, note: err.status === 401 ? '地址可用（需要登录）' : err.message };
    }
  });

  handle('bonfire:settings:patch', (patch) => {
    const allowed = {};
    for (const k of ['downloadDir', 'minimizeToTray', 'startHidden', 'notifyOnFinish', 'uploadConcurrency', 'downloadConcurrency', 'theme', 'accent', 'density', 'motion']) {
      if (k in patch) allowed[k] = patch[k];
    }
    if (typeof allowed.downloadDir === 'string' && allowed.downloadDir) {
      allowed.downloadDir = path.resolve(allowed.downloadDir);
      fs.mkdirSync(allowed.downloadDir, { recursive: true });
    }
    return state.saveSettings(allowed);
  });

  handle('bonfire:disk:info', () => {
    const dir = state.downloadDir();
    try {
      const s = fs.statfsSync ? fs.statfsSync(dir) : null;
      if (!s) return { dir };
      return { dir, free: Number(s.bsize) * Number(s.bavail), total: Number(s.bsize) * Number(s.blocks) };
    } catch {
      return { dir };
    }
  });

  // that is not the one already in use, and offer <drive>:\Downloads.
  handle('bonfire:disk:best', () => {
    const cur = state.downloadDir();
    const curRoot = cur ? path.parse(cur).root.replace(/[\\/]+$/, '') : '';
    const roots = process.platform === 'win32'
      ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`)
      : ['/', '/mnt', '/data', '/srv', path.join(os.homedir(), '..')];
    let best = null;
    for (const r of roots) {
      try {
        if (!fs.existsSync(r)) continue;
        if (r.replace(/[\\/]+$/, '') === curRoot) continue;
        const s = fs.statfsSync(r);
        const free = Number(s.bsize) * Number(s.bavail);
        if (!Number.isFinite(free) || free < 20 * 1024 ** 3) continue;
        if (!best || free > best.free) best = { dir: r, free };
      } catch {
        /* unreadable drive */
      }
    }
    if (!best) return null;
    const dir = path.join(best.dir, 'Downloads');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null;
    }
    return { dir, free: best.free };
  });

  // ---- files ----
  handle('bonfire:files:list', (folderId) => client.listFiles(folderId == null ? null : intOfOrZero(folderId)));
  handle('bonfire:files:meta', (id) => client.fileMeta(intOf(id)));
  handle('bonfire:files:text', async (id) => {
    const res = await client.stream(`/api/files/${intOf(id)}/preview`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = `预览失败 (${res.status})`;
      let code = null;
      try {
        const j = JSON.parse(detail);
        message = j.error || message;
        code = j.code || null;
      } catch {
        /* non-json error body */
      }
      const err = new Error(message);
      err.status = res.status;
      err.code = code;
      throw err;
    }
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('文件太大，请下载后用编辑器查看');
    return text;
  });
  handle('bonfire:folder:create', ({ name, parentId }) => client.mkdir(String(name || ''), parentId == null ? null : intOfOrZero(parentId)));
  handle('bonfire:file:rename', ({ id, name }) => client.renameFile(intOf(id), String(name || '')));
  handle('bonfire:folder:rename', ({ id, name }) => client.renameFolder(intOf(id), String(name || '')));
  handle('bonfire:file:move', ({ id, folderId }) => client.moveFile(intOf(id), folderId == null ? null : intOfOrZero(folderId)));
  handle('bonfire:folder:move', ({ id, folderId }) => client.moveFolder(intOf(id), folderId == null ? null : intOfOrZero(folderId)));
  handle('bonfire:file:delete', (id) => client.deleteFile(intOf(id)));
  handle('bonfire:folder:delete', (id) => client.deleteFolder(intOf(id)));

  // ---- recycle ----
  handle('bonfire:recycle:list', () => client.recycleList());
  handle('bonfire:recycle:restore', ({ kind, id }) => (kind === 'folder' ? client.restoreFolder(intOf(id)) : client.restoreFile(intOf(id))));
  handle('bonfire:recycle:purge', ({ kind, id }) => (kind === 'folder' ? client.purgeFolder(intOf(id)) : client.purgeFile(intOf(id))));

  // ---- shares ----
  handle('bonfire:share:create', (input) => {
    const body = { fileId: intOf(input?.fileId) };
    if (input.expiresIn != null && input.expiresIn !== '') body.expiresIn = intOf(input.expiresIn);
    if (input.maxHits != null && input.maxHits !== '') body.maxHits = intOf(input.maxHits);
    if (typeof input.password === 'string' && input.password) body.password = input.password.slice(0, 64);
    return client.createShare(body);
  });
  handle('bonfire:share:list', () => client.listShares());
  handle('bonfire:share:delete', (id) => client.deleteShare(intOf(id)));

  // ---- profile ----
  handle('bonfire:profile:get', async () => {
    const { profile } = await client.profile();
    state.setProfile(profile);
    return profile;
  });
  handle('bonfire:profile:update', async ({ displayName, bio }) => {
    const { profile } = await client.updateProfile(String(displayName ?? ''), String(bio ?? ''));
    state.setProfile(profile);
    return profile;
  });
  handle('bonfire:profile:password', ({ oldPassword, newPassword }) =>
    client.changePassword(String(oldPassword ?? ''), String(newPassword ?? '')));

  // ---- 邮箱验证 ----
  handle('bonfire:verify:register-send', ({ email }) => client.sendRegisterCode(String(email ?? '')));
  handle('bonfire:verify:reset-send', ({ username }) => client.sendResetCode(String(username ?? '')));
  handle('bonfire:verify:reset', ({ username, email, code, newPassword }) =>
    client.resetPassword(String(username ?? ''), String(email ?? ''), String(code ?? ''), String(newPassword ?? '')));
  handle('bonfire:verify:bind-send', ({ email }) => client.sendBindCode(String(email ?? '')));
  handle('bonfire:verify:bind', ({ email, code }) =>
    client.bindEmail(String(email ?? ''), String(code ?? '')));

  handle('bonfire:avatar:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择头像图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const st = fs.statSync(file);
    if (st.size > AVATAR_MAX) throw new Error('头像不能超过 2 MB');
    const type = AVATAR_TYPES.get(mimeFromName(file));
    if (!type) throw new Error('只支持 PNG / JPEG / GIF / WebP');
    const buf = fs.readFileSync(file);
    return { data: new Uint8Array(buf), type, name: path.basename(file) };
  });

  handle('bonfire:avatar:set', async ({ data, type }) => {
    if (!(data instanceof Uint8Array) || !data.length) throw new Error('没有收到图片');
    if (data.length > AVATAR_MAX) throw new Error('头像不能超过 2 MB');
    const mime = [...AVATAR_TYPES.keys()].find((m) => AVATAR_TYPES.get(m) === type);
    if (!mime) throw new Error('头像格式不支持');
    const { profile } = await client.uploadAvatar(Buffer.from(data), mime);
    state.setProfile(profile);
    return profile;
  });

  handle('bonfire:avatar:clear', async () => {
    const { profile } = await client.removeAvatar();
    state.setProfile(profile);
    return profile;
  });

  // ---- transfers ----
  handle('bonfire:upload:pick', async () => {
    const r = await dialog.showOpenDialog({ title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  handle('bonfire:dialog:directory', async () => {
    const r = await dialog.showOpenDialog({ title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });

  handle('bonfire:upload:add', ({ paths, folderId }) => {
    const list = Array.isArray(paths) ? paths : [paths];
    const jobs = [];
    for (const p of list.slice(0, 200)) {
      if (typeof p !== 'string' || !p) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      jobs.push(queueUpload(p, folderId == null ? null : intOfOrZero(folderId)));
    }
    return { queued: jobs.length };
  });

  handle('bonfire:upload:cancel', (jobId) => {
    uploads.cancel(String(jobId));
    return true;
  });

  handle('bonfire:download:start', ({ fileId, name, size }) => {
    const job = String(`dl-${intOf(fileId)}-${Date.now()}`);
    queueDownload({ fileId: intOf(fileId), name: sanitizeName(name), size: Number(size) || 0, jobId: job });
    return { jobId: job };
  });

  handle('bonfire:download:cancel', (jobId) => {
    downloads.cancelAndDiscard(String(jobId));
    return true;
  });

  handle('bonfire:download:reveal', (target) => {
    const p = assertInsideDownloadDir(target);
    shell.showItemInFolder(p);
    return true;
  });

  handle('bonfire:download:open', (target) => {
    const p = assertInsideDownloadDir(target);
    const res = shell.openPath(p);
    if (typeof res === 'string' && res) throw new Error(res);
    return true;
  });

  // ---- window chrome + native context menu ----
  handle('bonfire:window', (action) => {
    const w = deps.getWindow();
    if (!w) return false;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
    else if (action === 'close') w.close();
    else if (action === 'restore') w.show();
    return true;
  });

  handle('bonfire:window:appearance', ({ dark }) => {
    const w = deps.getWindow();
    if (!w) return false;
    const bg = dark ? '#232323' : '#ededed';
    w.setBackgroundColor(bg);
    if (process.platform !== 'darwin') {
      w.setTitleBarOverlay({ color: bg, symbolColor: dark ? '#eaeaea' : '#1a1a1a', height: 40 });
    }
    return true;
  });

  // it wants; ids are checked against a fixed list, and labels come from us.
  handle('bonfire:context-menu', ({ actions, x = 0, y = 0 }) => {
    const w = deps.getWindow();
    if (!w) return null;
    const wanted = Array.isArray(actions) ? actions : [];
    const template = [];
    for (const a of wanted) {
      if (!a || !MENU_LABELS[a.id]) continue;
      if (a.separatorBefore) template.push({ type: 'separator' });
      template.push({
        id: a.id,
        label: MENU_LABELS[a.id],
        enabled: a.disabled !== true,
        click: () => {
          w.__menuChoice = a.id;
        },
      });
    }
    if (!template.length) return null;
    const menu = Menu.buildFromTemplate(template);
    w.__menuChoice = null;
    menu.popup({ window: w, x: Math.round(x), y: Math.round(y) });
    return new Promise((resolve) => {
      const poll = () => {
        if (w.__menuChoice !== null && w.__menuChoice !== undefined) {
          const choice = w.__menuChoice;
          w.__menuChoice = null;
          resolve(choice);
        } else if (menu && !menu.isVisible?.()) {
          // dismissed without picking anything
          resolve(null);
        } else {
          setTimeout(poll, 40);
        }
      };
      setTimeout(() => resolve(null), 30000);
      poll();
    });
  });

  // ---- shell helpers, all validated ----
  handle('bonfire:media:url', ({ kind, id }) => {
    if (kind === 'avatar') {
      const username = String(id);
      const url = mediaUrlFor('avatar', username);
      if (resolveMediaUrl(url).error) throw new Error('用户名无效');
      return url;
    }
    if (kind !== 'preview' && kind !== 'download') throw new Error('不支持的类型');
    return mediaUrlFor(kind, intOf(id));
  });

  handle('bonfire:open:external', (url) => {
    const parsed = parseServerUrl(url);
    // Only links pointing at the drive we are connected to may leave the app.
    if (!parsed.ok || parsed.url !== state.serverKind.url) throw new Error('只允许打开当前云盘的链接');
    shell.openExternal(parsed.url);
    return true;
  });

  // ---- update channel ----
  let lastRelease = null;

  async function fetchLatest() {
    const base = state.settings.serverUrl;
    let res;
    try {
      res = await fetch(`${base}/api/releases/latest`, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new Error(`连不上更新通道（${err?.cause?.code || err?.message || '网络错误'}）`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`检查更新失败 (${res.status})`);
    const body = await res.json().catch(() => null);
    const decision = updateDecision(deps.app.getVersion(), body?.release);
    if (!decision.ok) throw new Error(decision.reason);
    lastRelease = decision.release;
    return decision;
  }

  handle('bonfire:update:check', async () => {
    const current = deps.app.getVersion();
    const decision = await fetchLatest();
    if (!decision) return { ok: true, current, noRelease: true, hasUpdate: false };
    return { ...decision, current, server: state.settings.serverUrl };
  });

  handle('bonfire:update:download', async () => {
    const decision = lastRelease ? { ok: true, release: lastRelease } : await fetchLatest();
    if (!decision?.release) throw new Error('还没有可下载的更新');
    const r = decision.release;
    const jobId = `update-${r.file}`;
    downloads
      .start({ fileId: null, name: r.file, size: r.size, pathname: `/releases/${encodeURIComponent(r.file)}`, sha256: r.sha256, jobId })
      .catch(() => {
        /* the transfer panel already reported it */
      });
    return { queued: true, jobId, file: r.file, version: r.version, sha256: r.sha256.slice(0, 12) };
  });

  // ---- queues ----
  const uploadQueue = [];
  let uploadRunning = false;
  function queueUpload(localPath, folderId) {
    const jobId = localPath;
    uploadQueue.push({ localPath, folderId, jobId });
    drainUploads();
    return jobId;
  }
  async function drainUploads() {
    if (uploadRunning) return;
    uploadRunning = true;
    while (uploadQueue.length) {
      const job = uploadQueue.shift();
      try {
        await uploads.upload({ localPath: job.localPath, folderId: job.folderId, jobId: job.jobId });
      } catch {
        /* the manager already reported the failure */
      }
    }
    uploadRunning = false;
  }

  const downloadQueue = [];
  let downloadRunning = 0;
  function queueDownload(opts) {
    downloadQueue.push(opts);
    drainDownloads();
  }
  function drainDownloads() {
    const limit = Math.max(1, Number(state.settings.downloadConcurrency) || 2);
    while (downloadRunning < limit && downloadQueue.length) {
      const job = downloadQueue.shift();
      downloadRunning++;
      downloads
        .start(job)
        .catch(() => {})
        .finally(() => {
          downloadRunning--;
          drainDownloads();
        });
    }
  }

  function assertInsideDownloadDir(target) {
    const p = path.resolve(String(target || ''));
    const dir = path.resolve(state.downloadDir());
    if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error('只能在下载目录内操作');
    return p;
  }
}

function intOfOrZero(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function mimeFromName(name) {
  const ext = String(name).split('.').pop()?.toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || '';
}
