import { $, $$, human, toast, paintAvatar, applyAppearance } from './ui.js';

const NAME_MAX = 24;
const BIO_MAX = 200;
let S = null; // the app state object, handed over by setupSettings

export function setupSettings(ctx) {
  S = ctx.state;
  refresh = ctx.refreshIdentity || (() => {});
  onServerChanged = ctx.onServerChanged;

  $('#pfSave').addEventListener('click', saveProfile);
  $('#pfPassBtn').addEventListener('click', changePassword);
  $('#pfAvatarBtn').addEventListener('click', pickAvatar);
  $('#pfAvatarClear').addEventListener('click', clearAvatar);
  $('#pfName').addEventListener('input', updateCounts);
  $('#pfBio').addEventListener('input', updateCounts);

  $('#setUrlSave').addEventListener('click', saveUrl);
  $('#setUrl').addEventListener('input', () => describeUrl());
  $('#updCheck').addEventListener('click', checkUpdate);
  $('#updDownload').addEventListener('click', downloadUpdate);
  $('#setDirPick').addEventListener('click', pickDir);
  $('#setDirBest').addEventListener('click', moveToBestDrive);

  for (const [id, key] of [['setTray', 'minimizeToTray'], ['setNotify', 'notifyOnFinish'], ['setHidden', 'startHidden']]) {
    $(`#${id}`).addEventListener('change', async (e) => {
      try {
        S.settings = await window.bonfire.patchSettings({ [key]: e.target.checked });
        toast('设置已保存', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  // 外观: theme / accent / density / motion apply instantly, then persist.
  for (const [id, key] of [['segTheme', 'theme'], ['segAccent', 'accent'], ['segDensity', 'density']]) {
    $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => setAppearance(key, b.dataset.v)));
  }
  $('#setMotion').addEventListener('change', (e) => setAppearance('motion', e.target.checked));

  $('#reloginBtn').addEventListener('click', () => {
    $('#lgErr').classList.add('hidden');
    $('#loginDialog').showModal();
  });
  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await window.bonfire.logout();
      S.authed = false;
      refresh(null);
      toast('已退出登录', 'ok');
      setTimeout(() => location.reload(), 350);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  syncAppearance();
}

let refresh = () => {};
let onServerChanged = null;

async function setAppearance(key, value) {
  try {
    S.settings = await window.bonfire.patchSettings({ [key]: value });
    applyAppearance(S.settings);
    syncAppearance();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function syncAppearance() {
  const s = S?.settings || {};
  for (const [id, key] of [['segTheme', 'theme'], ['segAccent', 'accent'], ['segDensity', 'density']]) {
    $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === s[key]));
  }
  const motion = $('#setMotion');
  if (motion) motion.checked = s.motion !== false;
}

export async function hydrate() {
  if (!S?.settings) return;
  const s = S.settings;
  $('#setUrl').value = s.serverUrl;
  $('#setAck').checked = !!s.allowInsecureRemote;
  $('#setTray').checked = !!s.minimizeToTray;
  $('#setNotify').checked = !!s.notifyOnFinish;
  $('#setHidden').checked = !!s.startHidden;
  $('#verNow').textContent = S.boot?.version || '未知';
  $('#verServer').textContent = S.server?.ok ? new URL(S.server.url).host : '';
  syncAppearance();

  await describeUrl();

  try {
    const d = await window.bonfire.diskInfo();
    S.downloadDir = d.dir;
    $('#setDir').value = d.dir;
    $('#diskInfo').textContent = d.free ? `该盘剩余 ${human(d.free)}` : '';
  } catch {
    /* disk stats are advisory */
  }

  const p = S.profile;
  if (p) {
    $('#pfName').value = p.display_name || '';
    $('#pfBio').value = p.bio || '';
    $('#pfWho').textContent = p.display_name || p.username;
    $('#pfHandle').textContent = `@${p.username} · ${p.super_admin ? '最高管理员' : p.role === 'admin' ? '管理员' : '普通用户'}`;
    paintAvatar($('#pfAvatar'), p, { size: 'lg' });
    $('#pfAvatarClear').classList.toggle('hidden', !p.avatar_url);
    updateCounts();
  }
  $('#vaultNote').textContent = S.boot?.vaultCanPersist
    ? '会话与记住的密码都用系统级加密（Windows DPAPI）保存，换一台电脑就解不开。'
    : '本机系统加密不可用：会话只留在内存里，重启应用需要重新登录（绝不写明文到磁盘）。';
}

async function describeUrl() {
  const kind = $('#connKind');
  const row = $('#setAckRow');
  if (!kind || !row) return null;
  let r;
  try {
    r = await window.bonfire.checkServer($('#setUrl').value);
  } catch {
    return null;
  }
  if (!r.ok) {
    kind.textContent = r.reason;
    row.classList.add('hidden');
    return r;
  }
  kind.textContent = r.secure ? 'https 加密' : r.scope === 'loopback' ? '本机 http' : r.scope === 'private' ? '局域网 http' : '公网 http';
  row.classList.toggle('hidden', !r.needsAck);
  return r;
}

function updateCounts() {
  $('#pfNameCount').textContent = `${Array.from($('#pfName').value).length}/${NAME_MAX}`;
  $('#pfBioCount').textContent = `${Array.from($('#pfBio').value).length}/${BIO_MAX}`;
}

function showErr(message) {
  const el = $('#pfErr');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function saveProfile() {
  showErr('');
  const btn = $('#pfSave');
  btn.disabled = true;
  try {
    const profile = await window.bonfire.updateProfile({ displayName: $('#pfName').value, bio: $('#pfBio').value });
    S.profile = profile;
    refresh(profile);
    toast('昵称与简介已保存', 'ok');
  } catch (err) {
    showErr(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function pickAvatar() {
  showErr('');
  const btn = $('#pfAvatarBtn');
  btn.disabled = true;
  btn.textContent = '选择图片…';
  try {
    const picked = await window.bonfire.pickAvatar();
    if (!picked) return;
    btn.textContent = '上传中…';
    const profile = await window.bonfire.setAvatar({ data: picked.data, type: picked.type });
    S.profile = profile;
    refresh(profile);
    paintAvatar($('#pfAvatar'), profile, { size: 'lg' });
    $('#pfAvatarClear').classList.remove('hidden');
    toast(`头像已更新：${picked.name}`, 'ok');
  } catch (err) {
    showErr(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '更换头像';
  }
}

async function clearAvatar() {
  showErr('');
  try {
    const profile = await window.bonfire.clearAvatar();
    S.profile = profile;
    refresh(profile);
    paintAvatar($('#pfAvatar'), profile, { size: 'lg' });
    $('#pfAvatarClear').classList.add('hidden');
    toast('已移除头像', 'ok');
  } catch (err) {
    showErr(err.message);
  }
}

async function changePassword() {
  showErr('');
  const oldPassword = $('#pfOld').value;
  const newPassword = $('#pfNew').value;
  if (!oldPassword || !newPassword) return showErr('请填写原密码和新密码。');
  if (newPassword !== $('#pfNew2').value) return showErr('两次输入的新密码不一致。');
  try {
    await window.bonfire.changePassword({ oldPassword, newPassword });
    $('#pfOld').value = '';
    $('#pfNew').value = '';
    $('#pfNew2').value = '';
    await window.bonfire.forgetCredential().catch(() => {});
    toast('密码已修改，其它设备需要重新登录（本窗口保持登录）', 'ok');
  } catch (err) {
    showErr(err.message);
  }
}

async function saveUrl() {
  const btn = $('#setUrlSave');
  btn.disabled = true;
  try {
    const r = await window.bonfire.setServer({ url: $('#setUrl').value, allowInsecureRemote: $('#setAck').checked });
    S.server = r.server;
    S.authed = false;
    toast(r.reachable ? '地址可用' : `已保存：${r.note || ''}`, 'ok');
    hydrate();
    onServerChanged?.();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

let pendingRelease = null;

async function checkUpdate() {
  const btn = $('#updCheck');
  const note = $('#updNote');
  btn.disabled = true;
  note.textContent = '检查中…';
  $('#updDownload').classList.add('hidden');
  $('#updDetail').classList.add('hidden');
  try {
    const r = await window.bonfire.checkUpdate();
    $('#verNow').textContent = r.current;
    if (r.noRelease) {
      note.textContent = '这个服务端还没有发布客户端版本';
      return;
    }
    const rel = r.release;
    pendingRelease = rel;
    $('#updDetail').classList.remove('hidden');
    $('#updSize').textContent = human(rel.size);
    $('#updNotes').textContent = rel.notes || '';
    $('#updHash').textContent = `sha256 ${rel.sha256.slice(0, 12)}… · ${rel.date}`;
    if (r.hasUpdate) {
      note.textContent = `发现新版本 ${rel.version}`;
      $('#updDownload').classList.remove('hidden');
    } else {
      note.textContent = `已是最新版本（服务端 ${rel.version}）`;
    }
  } catch (err) {
    note.textContent = '';
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function downloadUpdate() {
  if (!pendingRelease) return;
  try {
    const r = await window.bonfire.downloadUpdate();
    toast(`开始下载 ${r.file}，完成后会校验 sha256`, 'ok');
    $('.rail .nav[data-view="transfer"]').click();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function pickDir() {
  try {
    const chosen = await window.bonfire.pickDirectory();
    if (!chosen) return;
    await applyDir(chosen);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function moveToBestDrive() {
  try {
    const best = await window.bonfire.bestDownloadDir();
    if (!best?.dir) return toast('没有找到更合适的磁盘', 'err');
    await applyDir(best.dir);
    toast(`下载目录已改到 ${best.dir}（剩余 ${human(best.free)}）`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function applyDir(dir) {
  S.settings = await window.bonfire.patchSettings({ downloadDir: dir });
  const d = await window.bonfire.diskInfo();
  S.downloadDir = d.dir;
  $('#setDir').value = d.dir;
  $('#diskInfo').textContent = d.free ? `该盘剩余 ${human(d.free)}` : '';
}
