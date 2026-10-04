import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Turns electron-builder's unpacked directories into "extract and run" portable zips:
//   dist/Bonfire-<version>-win-x64-portable.zip  ->  Bonfire/Bonfire.exe + resources
// Run after `electron-builder --win`, which leaves win-unpacked / win-arm64-unpacked behind.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Everything lives under one top-level entry inside the zip, so extracting is never a
// dump of 70 loose files onto the desktop. On macOS that entry is the .app itself, which
// is what people expect to drag into /Applications.
const TARGETS = [
  { dir: 'win-unpacked', out: `Bonfire-${pkg.version}-win-x64-portable.zip`, platform: 'win32', probe: 'Bonfire.exe', folder: 'Bonfire' },
  { dir: 'win-arm64-unpacked', out: `Bonfire-${pkg.version}-win-arm64-portable.zip`, platform: 'win32', probe: 'Bonfire.exe', folder: 'Bonfire' },
  { dir: 'linux-unpacked', out: `Bonfire-${pkg.version}-linux-x64-portable.zip`, platform: 'linux', probe: 'bonfire-desktop', folder: 'Bonfire' },
  { dir: 'linux-arm64-unpacked', out: `Bonfire-${pkg.version}-linux-arm64-portable.zip`, platform: 'linux', probe: 'bonfire-desktop', folder: 'Bonfire' },
  { dir: 'mac', out: `Bonfire-${pkg.version}-mac-x64-portable.zip`, platform: 'darwin', probe: 'Bonfire.app', folder: 'Bonfire.app' },
  { dir: 'mac-arm64', out: `Bonfire-${pkg.version}-mac-arm64-portable.zip`, platform: 'darwin', probe: 'Bonfire.app', folder: 'Bonfire.app' },
];

// Only package for the platform we are running on: a directory left behind by a failed
// cross build is not a release artifact, and nothing here can verify someone else's binary.
// CI passes --all because each runner builds its own target there.
const all = process.argv.includes('--all');

// Compress-Archive and .NET Framework's ZipFile both store backslash entry names, which
// violates the ZIP spec (unzip warns, macOS Archive Utility flattens the tree). bsdtar,
// ditto and Info-ZIP all emit forward slashes, so the zip helper below is per-platform.
function zipStage(stageDir, zipPath, folder) {
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', stageDir, folder], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'darwin') {
    execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(stageDir, folder), zipPath], { stdio: 'inherit' });
    return;
  }
  execFileSync('zip', ['-r', '-9', '-q', zipPath, folder], { cwd: stageDir, stdio: 'inherit' });
}

function makeZip(contentDir, zipPath, folder) {
  const stage = path.join(dist, '.portable-stage');
  const named = path.join(stage, folder);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(named, { recursive: true });
  fs.cpSync(contentDir, named, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  zipStage(stage, zipPath, folder);
  fs.rmSync(stage, { recursive: true, force: true });
}

let made = 0;
for (const t of TARGETS) {
  if (!all && t.platform !== process.platform) {
    console.log(`skip ${t.dir} (foreign platform; pass --all in CI)`);
    continue;
  }
  const content = path.join(dist, t.dir);
  if (!fs.existsSync(content)) {
    console.log(`skip ${t.dir} (not built)`);
    continue;
  }
  if (!fs.existsSync(path.join(content, t.probe))) {
    console.error(`skip ${t.dir}: 找不到 ${t.probe}，这个解包目录不完整`);
    continue;
  }
  const out = path.join(dist, t.out);
  makeZip(content, out, t.folder);
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`zipped ${t.out} (${mb} MB)`);
  made++;
}
if (!made) {
  console.error('dist 里没有可打包的解包目录，先跑 electron-builder --win');
  process.exit(1);
}
