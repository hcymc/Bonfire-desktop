import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FLAME = [
  '................',
  '........##......',
  '.......###......',
  '.......####.....',
  '......#####.....',
  '......######....',
  '.....#######....',
  '....########....',
  '...##########...',
  '...###########..',
  '..############..',
  '.#############..',
  '.##############.',
  '.##############.',
  '..############..',
  '...##########...',
];

// The hot core: a small flame sitting low inside the big one.
const CORE = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '........#.......',
  '.......##.......',
  '......####......',
  '......#####.....',
  '.....#######....',
  '.....#######....',
  '....########....',
  '....########....',
  '.....######.....',
  '......####......',
  '.......##.......',
];

function maskToFloat(rows, size) {
  const n = rows.length;
  const out = new Float32Array(size * size);
  const at = (y, x) => (rows[y] || '').charAt(x) === '#' ? 1 : 0;
  for (let y = 0; y < size; y++) {
    const fy = ((y + 0.5) / size) * n - 0.5;
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) / size) * n - 0.5;
      const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
      const x1 = Math.max(0, Math.min(n - 1, x0 + 1));
      const y1 = Math.max(0, Math.min(n - 1, y0 + 1));
      const tx = Math.min(1, Math.max(0, fx - x0));
      const ty = Math.min(1, Math.max(0, fy - y0));
      const a = at(y0, x0) * (1 - tx) * (1 - ty) + at(y0, x1) * tx * (1 - ty) + at(y1, x0) * (1 - tx) * ty + at(y1, x1) * tx * ty;
      out[y * size + x] = a;
    }
  }
  return out;
}

function roundedAlpha(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
}

/** @param {{size:number, background:boolean, pad:number}} opts */
function draw({ size, background, pad = 0.12 }) {
  const inner = Math.round(size * (1 - pad * 2));
  const offset = Math.round((size - inner) / 2);
  const flame = maskToFloat(FLAME, inner);
  const core = maskToFloat(CORE, inner);
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let outA = 0;
      let rgb = [0, 0, 0];

      if (background) {
        const ba = roundedAlpha(x + 0.5, y + 0.5, size, r);
        if (ba) {
          const t = y / size;
          rgb = mix([26, 31, 42], [58, 30, 22], t); // night sky into firelit ground
          outA = ba;
        }
      }

      const sx = x - offset;
      const sy = y - offset;
      if (sx >= 0 && sy >= 0 && sx < inner && sy < inner) {
        const a = flame[sy * inner + sx];
        const c = core[sy * inner + sx];
        if (a > 0.02) {
          const col = flameColor(sy / inner, c);
          // Plain source-over: the background may already be opaque, so the flame's own
          // alpha is what matters — multiplying by (1 - outA) would erase it entirely.
          rgb = mix(rgb, col, a);
          outA = Math.min(1, outA + a * (1 - outA));
        }
      }

      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      buf[i + 3] = Math.round(outA * 255);
    }
  }
  return buf;
}

const lerp = (a, b, t) => a + (b - a) * t;
function mix(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}

// Base of the flame burns bright, the tips go deep orange.
const HOT = [232, 74, 18];
const MID = [255, 140, 30];
const TIP = [255, 198, 84];
const CORE_HOT = [255, 226, 150];
const CORE_TIP = [255, 248, 224];

function flameColor(t, coreA) {
  const outer = t < 0.5 ? mix(HOT, MID, t * 2) : mix(MID, TIP, (t - 0.5) * 2);
  if (coreA <= 0.02) return outer;
  const inner = t < 0.5 ? mix(CORE_HOT, CORE_TIP, t * 2) : CORE_TIP;
  return mix(outer, inner, Math.min(1, coreA * 0.85));
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(out, size, opts) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(size, draw({ size, ...opts })));
  console.log(`wrote ${path.relative(root, out)} (${size}x${size})`);
}

const targets = [
  ['build/icon.png', 256, { background: true }],
  ['build/icon-512.png', 512, { background: true }],
  ['build/tray.png', 32, { background: false, pad: 0.06 }],
];
for (const [rel, size, opts] of targets) write(path.join(root, rel), size, opts);
