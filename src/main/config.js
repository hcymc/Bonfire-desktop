export const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8787',
  allowInsecureRemote: false,
  downloadDir: '',
  minimizeToTray: true,
  startHidden: false,
  notifyOnFinish: true,
  rememberPassword: false,
  uploadConcurrency: 2,
  downloadConcurrency: 2,
  theme: 'auto',
  accent: 'ember',
  density: 'comfy',
  motion: true,
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const THEMES = ['auto', 'light', 'dark'];
const ACCENTS = ['ember', 'amber', 'pine', 'violet', 'steel'];
const DENSITIES = ['comfy', 'compact'];
const INT_RANGE = { uploadConcurrency: [1, 4], downloadConcurrency: [1, 4] };

function isPrivateV4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function parseServerUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: '地址不能为空' };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: '地址无法解析' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: '只支持 http 或 https' };
  if (url.username || url.password) return { ok: false, reason: '地址里不能带账号密码' };
  if (!url.hostname) return { ok: false, reason: '缺少主机名' };
  if (url.hostname === '.onion') return { ok: false, reason: '不支持 .onion 地址' };
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/') return { ok: false, reason: '只能填站点根地址，不要带路径' };

  const host = url.hostname.toLowerCase();
  const scope = LOOPBACK.has(host) ? 'loopback' : isPrivateV4(host) ? 'private' : 'public';
  const secure = url.protocol === 'https:';
  return {
    ok: true,
    url: `${url.protocol}//${url.host}`,
    host,
    secure,
    scope,
    needsAck: !secure && scope === 'public',
  };
}

export function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src)) continue;
    const want = typeof DEFAULTS[key];
    if (want === 'boolean' && typeof src[key] === 'boolean') out[key] = src[key];
    else if (want === 'string' && typeof src[key] === 'string') out[key] = src[key].slice(0, 500);
    else if (want === 'number' && Number.isFinite(Number(src[key]))) {
      const [min, max] = INT_RANGE[key] ?? [0, Number.MAX_SAFE_INTEGER];
      out[key] = Math.min(max, Math.max(min, Math.round(Number(src[key]))));
    }
  }
  if (!THEMES.includes(out.theme)) out.theme = DEFAULTS.theme;
  if (!ACCENTS.includes(out.accent)) out.accent = DEFAULTS.accent;
  if (!DENSITIES.includes(out.density)) out.density = DEFAULTS.density;
  const parsed = parseServerUrl(out.serverUrl);
  out.serverUrl = parsed.ok ? parsed.url : DEFAULTS.serverUrl;
  if (out.serverUrl.startsWith('https:')) out.allowInsecureRemote = false;
  return out;
}
