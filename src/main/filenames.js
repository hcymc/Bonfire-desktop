import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const MAX_BASE = 120;

export function sanitizeName(raw) {
  const parts = String(raw ?? '')
    .replace(CONTROL, '')
    .split(/[\\/]/)
    .map((seg) =>
      seg
        .replace(/[<>:"|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, ''),
    )
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  let name = parts.join(' ');
  if (!name) name = 'file';
  if (RESERVED.test(name)) name = `_${name}`;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  if (base.length > MAX_BASE) name = `${base.slice(0, MAX_BASE)}${ext}`;
  return name;
}

/** `a.png`, `a (2).png`, ... — never overwrites an existing file. */
export function uniqueLocalName(dir, name, existsSync) {
  const clean = sanitizeName(name);
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);
  for (let i = 1; i <= 999; i++) {
    const candidate = i === 1 ? clean : `${base} (${i})${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}
