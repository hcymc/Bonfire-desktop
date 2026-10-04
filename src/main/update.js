const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,30})?$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+() -]{0,120}\.(exe|msi|dmg|zip|deb|AppImage)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;

function parts(version) {
  const [main, pre = ''] = String(version).split('-');
  return { nums: main.split('.').map(Number), pre: pre ? pre.split('.') : [] };
}

function compareIdent(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const aNum = String(a) === String(na);
  const bNum = String(b) === String(nb);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1; // numeric identifiers sort before alphanumeric
  if (bNum) return 1;
  return String(a).localeCompare(String(b));
}

/** -1 when a < b, 0 equal, 1 when a > b. Throws on garbage input. */
export function compareVersions(a, b) {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) return 0;
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1; // 1.0.0 > 1.0.0-rc.1
  if (!pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    const d = compareIdent(pa.pre[i], pb.pre[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function validateRelease(input) {
  const r = input && typeof input === 'object' ? input : {};
  const version = String(r.version ?? '');
  const file = String(r.file ?? '');
  const sha256 = String(r.sha256 ?? '').toLowerCase();
  const size = Number(r.size);
  if (!VERSION_RE.test(version)) return null;
  if (!FILE_RE.test(file) || file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  if (!SHA_RE.test(sha256)) return null;
  if (!Number.isInteger(size) || size <= 0 || size > MAX_RELEASE_BYTES) return null;
  return {
    version,
    file,
    sha256,
    size,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 500) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 40) : '',
  };
}

export function updateDecision(currentVersion, release) {
  const valid = validateRelease(release);
  if (!valid) return { ok: false, reason: '服务端返回的发布信息不可信（版本号/文件名/校验和不合法）' };
  if (!VERSION_RE.test(String(currentVersion))) {
    return { ok: true, current: currentVersion, release: valid, hasUpdate: false, unknownCurrent: true };
  }
  return {
    ok: true,
    current: currentVersion,
    release: valid,
    hasUpdate: compareVersions(valid.version, currentVersion) > 0,
  };
}
