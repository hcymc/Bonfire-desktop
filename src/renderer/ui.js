export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function setupIcons() {
  const has = (family) => {
    try {
      return document.fonts.check(`16px "${family}"`);
    } catch {
      return false;
    }
  };
  if (!has('Segoe Fluent Icons') && !has('Segoe MDL2 Assets')) {
    document.documentElement.dataset.icons = 'fallback';
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function human(bytes) {
  let i = 0;
  let v = Number(bytes) || 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${UNITS[i]}`;
}

export function fmtDate(s) {
  if (!s) return '';
  const iso = String(s).includes('T') ? String(s) : `${String(s).replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(s);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `今天 ${d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function extOf(name) {
  const s = String(name);
  const dot = s.lastIndexOf('.');
  return dot <= 0 ? '' : s.slice(dot + 1).toLowerCase();
}

const KINDS = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', wav: 'audio',
  pdf: 'pdf',
  txt: 'text', md: 'text', log: 'text', csv: 'text', json: 'text', ini: 'text', cfg: 'text',
  conf: 'text', yaml: 'text', yml: 'text', xml: 'text', sql: 'text', css: 'text', ts: 'text',
  py: 'text', java: 'text', c: 'text', h: 'text',
};
export const previewKind = (name) => KINDS[extOf(name)] || null;

const GLYPH = {
  txt: 'doc', md: 'doc', log: 'doc', csv: 'doc', rtf: 'doc',
  json: 'code', ts: 'code', py: 'code', js: 'code', c: 'code', h: 'code', java: 'code', css: 'code', xml: 'code', yml: 'code', yaml: 'code', sql: 'code', ini: 'code', conf: 'code',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', m4v: 'video', avi: 'video',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip',
  exe: 'warn', dll: 'warn', msi: 'warn', bat: 'warn', cmd: 'warn', sh: 'warn', apk: 'warn', jar: 'warn',
};

export function iconClass(name, isFolder) {
  if (isFolder) return 'i-folder';
  return `i-${GLYPH[extOf(name)] || 'doc'}`;
}

export function initialsOf(p) {
  const s = p?.display_name || p?.username || '?';
  return Array.from(String(s))[0].toUpperCase();
}

export function paintAvatar(host, profile, { size = '' } = {}) {
  if (!host) return;
  host.textContent = '';
  host.className = `avatar ${size}`.trim();
  if (!profile) {
    host.textContent = '?';
    return;
  }
  if (!profile.avatar_url) {
    host.textContent = initialsOf(profile);
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.remove();
    host.textContent = initialsOf(profile);
  });
  host.appendChild(img);
  // URL never changes and the new face is invisible behind a cached image.
  const ver = /v=(\d+)/.exec(String(profile.avatar_url || ''))?.[1] || '0';
  window.bonfire
    .mediaUrl({ kind: 'avatar', id: profile.username })
    .then((u) => {
      img.src = `${u}?v=${ver}`;
    })
    .catch(() => {
      img.remove();
      host.textContent = initialsOf(profile);
    });
}

const TOAST_ICON = { ok: 'i-check', err: 'i-warn' };

export function toast(message, kind = '') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  const ico = document.createElement('i');
  ico.className = `i ${TOAST_ICON[kind] || 'i-info'}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.append(ico, text);
  host.appendChild(el);
  const life = kind === 'err' ? 5200 : 2600;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, life);
  while (host.children.length > 4) host.firstElementChild.remove();
}

export function status(text) {
  const el = $('#statusText');
  if (el) el.textContent = text;
}

export function emptyNode(text, icon = 'i-folder') {
  const el = document.createElement('div');
  el.className = 'empty';
  const i = document.createElement('i');
  i.className = `i ${icon}`;
  const s = document.createElement('div');
  s.textContent = text;
  el.append(i, s);
  return el;
}

export function skeletonList(host, rows = 6) {
  host.textContent = '';
  for (let i = 0; i < rows; i++) {
    const sk = document.createElement('div');
    sk.className = 'sk';
    host.appendChild(sk);
  }
}

export function applyAppearance(s = {}) {
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = ['ember', 'amber', 'pine', 'violet', 'steel'].includes(s.accent) ? s.accent : 'ember';
  root.dataset.density = s.density === 'compact' ? 'compact' : 'comfy';
  root.dataset.motion = s.motion === false ? 'off' : 'on';
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = dark ? 'dark' : 'light';
  // The OS-painted parts (window background, caption buttons) need telling too.
  window.bonfire?.setWindowTheme?.(dark).catch(() => {});
}

export function ask(opts) {
  return new Promise((resolve) => {
    const dlg = $('#askDialog');
    const input = $('#askInput');
    const err = $('#askErr');
    $('#askTitle').textContent = opts.title || '';
    const hint = $('#askHint');
    hint.textContent = opts.hint || '';
    hint.classList.toggle('hidden', !opts.hint);
    $('#askOk').textContent = opts.okLabel || '确定';
    $('#askOk').classList.add('primary');
    input.value = opts.value ?? '';
    input.type = opts.password ? 'password' : 'text';
    const textless = opts.value === undefined;
    input.classList.toggle('hidden', textless);
    err.classList.add('hidden');
    $('#askSlot').classList.add('hidden');

    let result = null;
    const ok = $('#askOk');
    const cancel = $('#askCancel');
    const submit = () => {
      const v = input.value.trim();
      const bad = opts.validate ? opts.validate(v) : null;
      if (bad) {
        err.textContent = bad;
        err.classList.remove('hidden');
        return;
      }
      result = v;
      dlg.close();
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && !textless) {
        e.preventDefault();
        submit();
      }
    };
    ok.addEventListener('click', submit, { once: true });
    cancel.addEventListener('click', () => dlg.close(), { once: true });
    input.addEventListener('keydown', onKey);
    dlg.addEventListener('close', () => {
      input.removeEventListener('keydown', onKey);
      ok.classList.remove('primary');
      resolve(result);
    }, { once: true });
    dlg.showModal();
    if (!textless) input.select();
  });
}

export function confirmAsk({ title, hint, okLabel = '确定', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#askDialog');
    const input = $('#askInput');
    const ok = $('#askOk');
    $('#askTitle').textContent = title;
    const hintEl = $('#askHint');
    hintEl.textContent = hint || '';
    hintEl.classList.toggle('hidden', !hint);
    $('#askErr').classList.add('hidden');
    $('#askSlot').classList.add('hidden');
    input.classList.add('hidden');
    ok.textContent = okLabel;
    ok.classList.toggle('primary', !danger);
    ok.classList.toggle('danger', danger);
    let yes = false;
    ok.addEventListener('click', () => {
      yes = true;
      dlg.close();
    }, { once: true });
    $('#askCancel').addEventListener('click', () => dlg.close(), { once: true });
    dlg.addEventListener('close', () => {
      ok.classList.remove('danger');
      ok.classList.add('primary');
      input.classList.remove('hidden');
      resolve(yes);
    }, { once: true });
    dlg.showModal();
  });
}
