import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UploadManager } from '../src/main/uploads.js';
import { DownloadManager } from '../src/main/downloads.js';

const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'bonfire-test-'));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows lock */
  }
});

function makeFile(name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

function memStore(initial = {}) {
  const doc = { ...initial };
  return {
    load: () => ({ ...doc }),
    save: (v) => {
      for (const k of Object.keys(doc)) delete doc[k];
      Object.assign(doc, v);
    },
    doc,
  };
}

/** Upload stub that stores what each chunk index received. */
function uploadStub(opts = {}) {
  const s = {
    chunks: new Map(),
    inits: 0,
    completes: 0,
    abandons: 0,
    statuses: 0,
    uploadId: 'u1',
    chunkSize: opts.chunkSize ?? 16,
    failOnce: opts.failOnce ?? null, // chunk index that fails on its first attempt
    async uploadInit(name, size) {
      s.inits++;
      s.name = name;
      s.size = size;
      return { uploadId: s.uploadId, name, size, chunkSize: s.chunkSize };
    },
    async uploadStatus() {
      s.statuses++;
      return {
        uploadId: s.uploadId,
        status: 'open',
        received: opts.resumeReceived ?? 0,
        chunkSize: s.chunkSize,
        receivedChunks: opts.resumeChunks ?? [],
      };
    },
    async uploadChunk(id, index, buf) {
      if (s.failOnce === index) {
        s.failOnce = null;
        const e = new Error('boom');
        e.status = 500;
        throw e;
      }
      s.chunks.set(index, Buffer.from(buf));
      return { ok: true };
    },
    async uploadComplete(id, mime) {
      s.completes++;
      s.mime = mime;
      return { ok: true, file: { id: 7, name: s.name, size: s.size } };
    },
    async uploadAbandon() {
      s.abandons++;
      return { ok: true };
    },
  };
  return s;
}

test('upload: whole file arrives in 16-byte chunks and the resume handle is dropped', async () => {
  const src = makeFile('src.bin', Array.from({ length: 50 }, (_, i) => i % 251));
  const total = fs.statSync(src).size;
  const store = memStore();
  const client = uploadStub();
  const events = [];
  const mgr = new UploadManager({ client, fs, store, onEvent: (e) => events.push(e) });

  const res = await mgr.upload({ localPath: src, name: 'src.bin' });
  assert.equal(res.ok, true);
  assert.equal(res.file.id, 7);
  assert.equal(client.inits, 1);
  assert.equal(client.completes, 1);
  assert.equal([...client.chunks.keys()].sort((a, b) => a - b).join(','), '0,1,2,3');
  const ordered = [...client.chunks.entries()].sort((x, y) => x[0] - y[0]).map((entry) => entry[1]);
  assert.equal(Buffer.concat(ordered).length, total);
  assert.equal(client.mime, 'application/octet-stream');
  assert.deepEqual(store.doc, {}); // forgets the uploadId on success
  assert.deepEqual(events.map((e) => e.phase), ['started', 'progress', 'progress', 'progress', 'progress', 'done']);
});

test('upload: a remembered uploadId skips the chunks the server already has', async () => {
  const src = makeFile('resume.bin', Array.from({ length: 40 }, (_, i) => i));
  const st = fs.statSync(src);
  const key = `${src}|${st.size}|${Math.round(st.mtimeMs)}`;
  const store = memStore({ [key]: 'u-old' });
  const client = uploadStub({ resumeChunks: [0, 1], resumeReceived: 32 });
  const mgr = new UploadManager({ client, fs, store });

  await mgr.upload({ localPath: src });
  assert.equal(client.inits, 0, 'must not re-init a resumable upload');
  assert.equal(client.statuses, 1);
  assert.deepEqual([...client.chunks.keys()].sort(), [2]);
  assert.equal(client.chunks.get(2).length, 8);
  assert.deepEqual(store.doc, {});
});

test('upload: a transient chunk failure is retried, the byte still lands', async () => {
  const src = makeFile('retry.bin', Array.from({ length: 40 }, (_, i) => i));
  const client = uploadStub({ failOnce: 1 });
  const events = [];
  const mgr = new UploadManager({ client, fs, store: memStore(), onEvent: (e) => events.push(e) });
  await mgr.upload({ localPath: src });
  assert.equal(client.chunks.get(1).length, 16);
  assert.ok(events.some((e) => e.phase === 'retry'));
});

test('upload: cancelling abandons the session so reserved quota is released', async () => {
  const src = makeFile('cancel.bin', Array.from({ length: 40 }, (_, i) => i));
  const client = uploadStub();
  const store = memStore();
  const mgr = new UploadManager({ client, fs, store });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => mgr.upload({ localPath: src, signal: ac.signal }), /取消/);
  assert.equal(client.abandons, 1);
  assert.equal(client.completes, 0);
  assert.deepEqual(store.doc, {});
});

function downloadStub(full, opts = {}) {
  const s = { requests: [], path: null };
  s.stream = async (pathname, { range } = {}) => {
    s.path = pathname;
    s.requests.push(range || null);
    if (opts.status404) {
      return new Response(JSON.stringify({ error: '文件不存在', code: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    let start = 0;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range || '');
    if (m && !opts.ignoreRange) start = Number(m[1]);
    if (start >= full.length && !opts.ignoreRange) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${full.length}` } });
    }
    const slice = full.slice(opts.truncateTo != null ? Math.min(opts.truncateTo, full.length) : start);
    if (start > 0 && !opts.ignoreRange) {
      return new Response(slice, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${full.length - 1}/${full.length}`, 'content-length': String(slice.length) },
      });
    }
    return new Response(slice, { status: 200, headers: { 'content-length': String(slice.length) } });
  };
  return s;
}

function mkDl(client, getDir) {
  const events = [];
  const mgr = new DownloadManager({ client, fs, path, getDir, onEvent: (e) => events.push(e) });
  return { mgr, events };
}

test('download: streams to disk, then renames .part to the final file', async () => {
  const dl = path.join(dir, 'dl1');
  const full = Buffer.from(Array.from({ length: 100 }, (_, i) => i % 251));
  const client = downloadStub(full);
  const { mgr, events } = mkDl(client, () => dl);
  const r = await mgr.start({ fileId: 42, name: 'data.bin', size: full.length });
  assert.equal(r.ok, true);
  assert.equal(client.path, '/api/files/42/download');
  assert.equal(client.requests[0], null);
  assert.deepEqual(fs.readFileSync(r.path), full);
  assert.equal(fs.existsSync(`${r.path}.part`), false);
  assert.equal(events.at(-1).phase, 'done');
});

test('download: an existing .part resumes with a Range request', async () => {
  const dl = path.join(dir, 'dl2');
  fs.mkdirSync(dl, { recursive: true });
  const full = Buffer.from(Array.from({ length: 100 }, (_, i) => i % 251));
  const finalPath = path.join(dl, 'data.bin');
  fs.writeFileSync(`${finalPath}.part`, full.subarray(0, 30));
  const client = downloadStub(full);
  const { mgr } = mkDl(client, () => dl);
  const r = await mgr.start({ fileId: 42, name: 'data.bin', size: full.length });
  assert.equal(client.requests[0], 'bytes=30-');
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(r.path), full);
  // Collision avoidance renamed the target, so the .part path was a fresh one.
  assert.match(path.basename(r.path), /data(\s\(2\))?\.bin$/);
});

test('download: a server that ignores Range restarts the file instead of appending', async () => {
  const dl = path.join(dir, 'dl3');
  fs.mkdirSync(dl, { recursive: true });
  const full = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const finalPath = path.join(dl, 'alpha.txt');
  fs.writeFileSync(`${finalPath}.part`, 'partial-junk');
  const client = downloadStub(full, { ignoreRange: true });
  const { mgr } = mkDl(client, () => dl);
  const r = await mgr.start({ fileId: 1, name: 'alpha.txt', size: full.length });
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(r.path), full);
});

test('download: a short body is reported as incomplete and kept for retry', async () => {
  const dl = path.join(dir, 'dl4');
  const full = Buffer.from(Array.from({ length: 100 }));
  const client = downloadStub(full, { truncateTo: 40 });
  const { mgr, events } = mkDl(client, () => dl);
  const r = await mgr.start({ fileId: 9, name: 'short.bin', size: full.length });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(fs.existsSync(r.partialPath), true);
  assert.equal(fs.existsSync(r.path), false);
  assert.match(events.at(-1).message, /下载不完整/);
});

test('download: server error text surfaces to the caller', async () => {
  const dl = path.join(dir, 'dl5');
  const client = downloadStub(Buffer.from('x'), { status404: true });
  const { mgr } = mkDl(client, () => dl);
  await assert.rejects(() => mgr.start({ fileId: 3, name: 'gone.bin' }), /文件不存在/);
});

test('download: hostile names never escape the download folder', async () => {
  const dl = path.join(dir, 'dl6');
  const full = Buffer.from('payload');
  const client = downloadStub(full);
  const { mgr } = mkDl(client, () => dl);
  const r = await mgr.start({ fileId: 5, name: '..\\..\\escape.txt', size: full.length });
  assert.equal(path.dirname(r.path), dl);
  assert.match(path.basename(r.path), /escape\.txt$/);
});
