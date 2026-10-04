import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseServerUrl, normalizeSettings, DEFAULTS } from '../src/main/config.js';
import { sanitizeName, uniqueLocalName } from '../src/main/filenames.js';
import { CookieJar } from '../src/main/cookies.js';
import { DriveClient, ApiError } from '../src/main/client.js';
import { mimeFor } from '../src/main/uploads.js';

const DIR = path.join('X:', 'bonfire-fixture');
const SEP = path.sep;

test('server urls: loopback and lan http are accepted, scheme-less gets http', () => {
  const lb = parseServerUrl('127.0.0.1:8787');
  assert.equal(lb.ok, true);
  assert.equal(lb.url, 'http://127.0.0.1:8787');
  assert.equal(lb.scope, 'loopback');
  assert.equal(lb.needsAck, false);

  const lan = parseServerUrl('http://192.168.1.7:8787/');
  assert.equal(lan.ok, true);
  assert.equal(lan.scope, 'private');

  const https = parseServerUrl('https://drive.example.com');
  assert.equal(https.ok, true);
  assert.equal(https.secure, true);
});

test('server urls: plaintext to a public host needs an explicit acknowledgement', () => {
  const r = parseServerUrl('http://drive.example.com');
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'public');
  assert.equal(r.needsAck, true);
});

test('server urls: junk and credential-smuggling are refused', () => {
  for (const bad of ['', '   ', 'file:///C:/Windows', 'javascript:alert(1)', 'http://a:b@evil.com', 'http://evil.com/api/files']) {
    assert.equal(parseServerUrl(bad).ok, false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(parseServerUrl('http://u:p@evil.com').reason, '地址里不能带账号密码');
});

test('settings: unknown keys dropped, numbers clamped, bad url reset', () => {
  const s = normalizeSettings({
    serverUrl: 'http://127.0.0.1:9999',
    uploadConcurrency: 99,
    downloadConcurrency: -5,
    theme: 'neon',
    minimizeToTray: 'yes',
    evil: { a: 1 },
  });
  assert.equal(s.uploadConcurrency, 4);
  assert.equal(s.downloadConcurrency, 1);
  assert.equal(s.theme, 'auto');
  assert.equal(s.minimizeToTray, DEFAULTS.minimizeToTray);
  assert.ok(!('evil' in s));
  assert.equal(normalizeSettings({ serverUrl: 'not a url' }).serverUrl, DEFAULTS.serverUrl);
});

test('local names: traversal, separators, reserved devices and length', () => {
  assert.equal(sanitizeName('../../windows/system32/x'), 'windows system32 x');
  assert.equal(sanitizeName('a\\b/c'), 'a b c');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('nul'), '_nul');
  assert.equal(sanitizeName('   '), 'file');
  assert.equal(sanitizeName('.'), 'file');
  assert.ok(sanitizeName('x'.repeat(400)).length <= 130);
  assert.ok(!/[<>:"|?*]/.test(sanitizeName('a<b>c:d|e?f*g"')));
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f]/.test(sanitizeName('be\x00llo')));
});

test('local names: existing targets get a counter instead of being overwritten', () => {
  const join = (...p) => p.join(SEP);
  const taken = new Set([join(DIR, 'a.png'), join(DIR, 'a (2).png')]);
  assert.equal(uniqueLocalName(DIR, 'a.png', (p) => taken.has(p)), 'a (3).png');
  assert.equal(uniqueLocalName(DIR, 'new.png', () => false), 'new.png');
});

test('cookie jar: parses attributes, honours max-age deletion, keeps the csrf value', () => {
  const jar = new CookieJar();
  jar.addSetCookies([
    'gopan_sess=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800',
    'gopan_csrf=tok%20en; Path=/; SameSite=Lax; Max-Age=604800',
  ]);
  assert.equal(jar.get('gopan_sess'), 'abc123');
  assert.equal(jar.get('gopan_csrf'), 'tok%20en');
  assert.match(jar.header(), /gopan_sess=abc123/);

  jar.addSetCookies(['gopan_sess=; Path=/; Max-Age=0']);
  assert.equal(jar.get('gopan_sess'), null);
  assert.ok(!jar.header().includes('gopan_sess'));

  const round = CookieJar.fromJSON(jar.toJSON());
  assert.equal(round.get('gopan_csrf'), 'tok%20en');
});

test('cookie jar: a cookie already past its max-age never enters the jar', () => {
  const now = Date.now();
  const jar = new CookieJar();
  jar.addSetCookies(['gopan_sess=fresh; Path=/; Max-Age=100'], now);
  assert.equal(jar.get('gopan_sess'), 'fresh');

  jar.addSetCookies(['stale=old; Path=/; Max-Age=-5'], now);
  assert.equal(jar.get('stale'), null);

  // Restoring a jar written before expiry must also refuse to send it.
  const revived = CookieJar.fromJSON([{ name: 'gopan_sess', value: 'x', expiresAt: now - 1000 }]);
  assert.equal(revived.get('gopan_sess'), null);
});

/** fetch stub: records requests, replays queued responses. */
function stubFetch(queue) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error('stub queue empty');
    if (next instanceof Error) throw next;
    const headers = new Headers(next.headers || {});
    for (const c of next.setCookie || []) headers.append('set-cookie', c);
    return new Response(next.body ?? '', { status: next.status || 200, headers });
  };
  return { impl, calls };
}

test('client: login captures the session and csrf token, mutations echo the token', async () => {
  const { impl, calls } = stubFetch([
    { status: 200, body: JSON.stringify({ ok: true, user: { username: 'tester' }, csrf: 'tok' }), setCookie: ['gopan_sess=S; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800', 'gopan_csrf=tok; Path=/; SameSite=Lax; Max-Age=604800'] },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const client = new DriveClient({ getBaseUrl: () => 'http://127.0.0.1:8787', fetchImpl: impl });
  const r = await client.login('tester', 'pw');
  assert.equal(r.user.username, 'tester');
  assert.equal(client.authed, true);
  assert.equal(client.csrf, 'tok');

  await client.mkdir('a', null);
  const post = calls[1];
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['x-csrf-token'], 'tok');
  assert.equal(post.init.headers.cookie, 'gopan_sess=S; gopan_csrf=tok');
  assert.equal(post.url, 'http://127.0.0.1:8787/api/files/folder');
  // A GET must not carry the csrf header.
  assert.ok(!('x-csrf-token' in calls[0].init.headers));
});

test('client: server errors keep status and code, non-json is refused, network is friendly', async () => {
  const { impl } = stubFetch([
    { status: 415, body: JSON.stringify({ error: '该文件不支持预览', code: 'preview_unsupported' }) },
    { status: 200, body: '<html>login</html>' },
    null,
  ]);
  const client = new DriveClient({ getBaseUrl: () => 'http://127.0.0.1:8787', fetchImpl: impl });
  await assert.rejects(client.fileMeta(1), (e) => e instanceof ApiError && e.status === 415 && e.code === 'preview_unsupported');
  await assert.rejects(client.fileMeta(2), (e) => e.code === 'bad_json');

  const boom = new TypeError('fetch failed');
  boom.cause = { code: 'ECONNREFUSED' };
  const broken = new DriveClient({ getBaseUrl: () => 'http://127.0.0.1:1', fetchImpl: async () => { throw boom; } });
  await assert.rejects(broken.me(), (e) => e.code === 'network' && /ECONNREFUSED/.test(e.message));
});

test('client: switching servers drops the old session, restore/resume works', async () => {
  const { impl } = stubFetch([{ status: 200, body: '{}', setCookie: ['gopan_sess=S; Path=/; Max-Age=604800'] }]);
  const client = new DriveClient({ getBaseUrl: () => 'http://127.0.0.1:8787', fetchImpl: impl });
  await client.me();
  assert.equal(client.authed, true);
  const jar = client.serializeJar();
  client.resetSession();
  assert.equal(client.authed, false);
  assert.equal(client.restoreJar(jar), true);
  assert.equal(client.csrf, null); // no csrf cookie in this fixture
});

test('mime map: only what we understand, octet-stream otherwise', () => {
  assert.equal(mimeFor('a.PNG'), 'image/png');
  assert.equal(mimeFor('noext'), 'application/octet-stream');
  assert.equal(mimeFor('a.exe'), 'application/octet-stream');
});
