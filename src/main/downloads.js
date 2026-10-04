import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { sanitizeName, uniqueLocalName } from './filenames.js';

export class DownloadManager {
  constructor(opts) {
    this.client = opts.client;
    this.fs = opts.fs;
    this.path = opts.path;
    this.getDir = opts.getDir;
    this.onEvent = opts.onEvent || (() => {});
    this.active = new Map();
  }

  async start({ fileId, name, size = 0, targetDir, pathname, sha256, jobId: givenId }) {
    const dir = targetDir || this.getDir();
    const urlPath = pathname || `/api/files/${fileId}/download`;
    this.fs.mkdirSync(dir, { recursive: true });
    const finalName = uniqueLocalName(dir, sanitizeName(name), (p) => this.fs.existsSync(p));
    const finalPath = this.path.join(dir, finalName);
    const partPath = `${finalPath}.part`;
    const jobId = givenId || `dl-${fileId ?? finalName}-${Date.now()}`;
    // truncated transfer even when the response headers are self-consistent.
    const declared = Number(size) || 0;
    const job = { jobId, fileId, name: finalName, path: finalPath, received: 0, total: declared, cancelled: false };
    this.active.set(jobId, job);

    let existing = 0;
    try {
      existing = this.fs.statSync(partPath).size;
    } catch {
      /* fresh */
    }

    const res = await this.client.stream(urlPath, {
      range: existing > 0 ? `bytes=${existing}-` : undefined,
    });
    if (!res.ok && res.status !== 206) {
      const detail = await res.text().catch(() => '');
      let msg = `下载失败 (${res.status})`;
      try {
        msg = JSON.parse(detail).error || msg;
      } catch {
        /* keep generic */
      }
      this.#emit(job, 'error', { message: msg });
      throw new Error(msg);
    }

    let start = existing;
    if (res.status === 200 && existing > 0) {
      // No range support this time: discard the partial bytes.
      start = 0;
      this.fs.writeFileSync(partPath, Buffer.alloc(0));
    }
    const totalFromHeaders = parseTotal(res.headers.get('content-range'), start, Number(res.headers.get('content-length')) || 0);
    // a ranged slice must not make a 100 MB file look complete after 40 MB.
    if (totalFromHeaders > job.total) job.total = totalFromHeaders;
    job.received = start; // the bytes already in .part count toward the bar
    this.#emit(job, 'progress');

    const ws = this.fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        if (job.cancelled) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!ws.write(buf)) await onceDrain(ws);
        job.received += buf.length;
        this.#emit(job, 'progress');
      }
      ws.end();
      await finished(ws);
    } catch (err) {
      ws.destroy();
      this.#emit(job, 'error', { message: err.message });
      throw err;
    }

    if (job.cancelled) {
      // Keep .part: the next attempt resumes from it. Explicit cancelAll() deletes.
      this.#emit(job, 'paused');
      this.active.delete(jobId);
      return { ok: false, cancelled: true, partialPath: partPath, path: finalPath };
    }

    const written = this.fs.statSync(partPath).size;
    if (job.total > 0 && written !== job.total) {
      this.#emit(job, 'error', { message: `下载不完整：${written}/${job.total} 字节，可重试续传` });
      return { ok: false, incomplete: true, partialPath: partPath, path: finalPath };
    }
    if (this.fs.existsSync(finalPath)) this.fs.rmSync(finalPath, { force: true });
    this.fs.renameSync(partPath, finalPath);

    // An installer is the one download that must not be trusted by name alone.
    if (sha256) {
      const actual = await sha256File(this.fs, finalPath);
      if (actual !== String(sha256).toLowerCase()) {
        this.fs.rmSync(finalPath, { force: true });
        this.active.delete(jobId);
        this.#emit(job, 'error', { message: '校验和不匹配，已删除下载的文件' });
        return { ok: false, checksumMismatch: true, expected: String(sha256).toLowerCase(), actual, path: finalPath };
      }
    }

    this.active.delete(jobId);
    this.#emit(job, 'done');
    return { ok: true, path: finalPath, name: finalName, size: written, verified: !!sha256 };
  }

  cancel(jobId) {
    const job = this.active.get(jobId);
    if (job) job.cancelled = true;
  }

  cancelAndDiscard(jobId) {
    const job = this.active.get(jobId);
    if (!job) return;
    job.cancelled = true;
    try {
      this.fs.rmSync(`${job.path}.part`, { force: true });
    } catch {
      /* already gone */
    }
  }

  #emit(job, phase, extra) {
    this.onEvent({
      kind: 'download',
      jobId: job.jobId,
      fileId: job.fileId,
      name: job.name,
      path: job.path,
      phase,
      sent: job.received,
      total: job.total,
      ...extra,
    });
  }
}

function onceDrain(ws) {
  return new Promise((resolve) => ws.once('drain', resolve));
}

function parseTotal(contentRange, start, contentLength) {
  const m = /\/(\d+)\s*$/.exec(contentRange || '');
  if (m) return Number(m[1]);
  if (contentLength) return start + contentLength;
  return 0;
}

async function sha256File(fs, file) {
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', resolve);
  });
  return h.digest('hex');
}
