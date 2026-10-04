import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Publishes a build into a server's release channel:
//   node scripts/publish-release.mjs [installer] --out <server data/releases dir> [--version x] [--notes text]
// The server serves latest.json verbatim, so the digest written here is what the client
// checks after downloading.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const positionals = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const version = flag('version') || pkg.version;
const notes = flag('notes') || '';
const out = flag('out') || process.env.RELEASES_DIR;
const abs = path.resolve(root, positionals[0] || path.join('dist', `Bonfire-${pkg.version}-setup.exe`));

if (!out) {
  console.error('用法: node scripts/publish-release.mjs [安装包] --out <服务端 data/releases 目录>');
  process.exit(1);
}
if (!fs.existsSync(abs)) {
  console.error(`找不到安装包: ${abs}`);
  process.exit(1);
}
if (!/\.(exe|msi|dmg|zip|deb|AppImage)$/i.test(path.basename(abs))) {
  console.error('只发布安装包类文件');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const bytes = fs.readFileSync(abs);
const target = path.join(out, path.basename(abs));
fs.writeFileSync(`${target}.tmp`, bytes);
if (fs.existsSync(target)) fs.rmSync(target);
fs.renameSync(`${target}.tmp`, target);

const manifest = {
  version,
  file: path.basename(abs),
  size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  notes,
  date: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));

console.log(`published ${manifest.version}`);
console.log(`  file     ${target} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  sha256   ${manifest.sha256}`);
console.log(`  manifest ${path.join(out, 'latest.json')}`);
