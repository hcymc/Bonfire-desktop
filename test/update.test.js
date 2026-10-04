import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, validateRelease, updateDecision } from '../src/main/update.js';

const SHA = 'a'.repeat(64);

test('versions: prerelease sorts below the release and rc numbers compare', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('versions: unparsable input never claims an update', () => {
  assert.equal(compareVersions('garbage', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '../../x'), 0);
});

test('manifest: only a well-formed release survives validation', () => {
  const good = { version: '1.0.0', file: 'GopanDesktop-1.0.0-setup.exe', size: 1234, sha256: SHA, notes: 'x', date: '2026-10-04' };
  assert.deepEqual(validateRelease(good), good);
  assert.equal(validateRelease({ ...good, file: '../windows/system32/x.exe' }), null);
  assert.equal(validateRelease({ ...good, file: 'sub/dir/x.exe' }), null);
  assert.equal(validateRelease({ ...good, file: 'payload.bat' }), null);
  assert.equal(validateRelease({ ...good, sha256: 'deadbeef' }), null);
  assert.equal(validateRelease({ ...good, size: -1 }), null);
  assert.equal(validateRelease({ ...good, size: 1.5 }), null);
  assert.equal(validateRelease({ ...good, version: '1; rm -rf' }), null);
  assert.equal(validateRelease(null), null);
  assert.equal(validateRelease('nope'), null);
  // an uppercase digest is still the same digest
  assert.equal(validateRelease({ ...good, sha256: SHA.toUpperCase() }).sha256, SHA);
});

test('decision: an update is offered only for a genuinely newer, valid release', () => {
  const rel = { version: '1.0.0', file: 'a.exe', size: 10, sha256: SHA };
  assert.equal(updateDecision('1.0.0-rc.1', rel).hasUpdate, true);
  assert.equal(updateDecision('1.0.0', rel).hasUpdate, false);
  assert.equal(updateDecision('1.0.1', rel).hasUpdate, false);
  const bad = updateDecision('1.0.0', { version: '1.0.1', file: 'a.bat', size: 10, sha256: SHA });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不可信/);
});
