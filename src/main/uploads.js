const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
};

export function mimeFor(name) {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 ? MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream' : 'application/octet-stream';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UploadManager {
  constructor(opts) {
    this.client = opts.client;
    this.fs = opts.fs;
    this.store = opts.store;
    this.onEvent = opts.onEvent || (() => {});
    this.active = new Map(); // jobId -> controller
    this.concurrency = 2;
  }

  #key({ localPath, size, mtimeMs }) {
    return `${localPath}|${size}|${Math.round(mtimeMs)}`;
  }

  resumes(localPath, size, mtimeMs) {
    const doc = this.store?.load() || {};
    return doc[this.#key({ localPath, size, mtimeMs })] || null;
  }

  #remember(key, uploadId) {
    if (!this.store) return;
    const doc = this.store.load() || {};
    doc[key] = uploadId;
    this.store.save(doc);
  }

  #forget(key) {
    if (!this.store) return;
    const doc = this.store.load() || {};
    delete doc[key];
    this.store.save(doc);
  }

  async upload({ localPath, name, folderId = null, jobId = localPath, signal }) {
    const st = this.fs.statSync(localPath);
    if (!st.isFile()) throw new Error('只能上传普通文件');
    const key = this.#key({ localPath, size: st.size, mtimeMs: st.mtimeMs });
    const displayName = name || baseName(localPath);

    const controller = { jobId, cancelled: false, sent: 0, total: st.size, name: displayName };
    this.active.set(jobId, controller);
    // An already-aborted controller never fires 'abort', so check it directly.
    if (signal?.aborted) controller.cancelled = true;
    signal?.addEventListener('abort', () => {
      controller.cancelled = true;
    });

    try {
      let uploadId = this.resumes(localPath, st.size, st.mtimeMs);
      let done = new Set();
      if (uploadId) {
        try {
          const status = await this.client.uploadStatus(uploadId);
          if (status.status !== 'open') {
            uploadId = null; // completed or abandoned server-side: start clean
          } else {
            done = new Set(status.receivedChunks || []);
            controller.chunkSize = status.chunkSize;
            controller.sent = Number(status.received) || 0;
            this.#emit(controller, 'resuming');
          }
        } catch {
          uploadId = null;
        }
      }
      if (!uploadId) {
        const init = await this.client.uploadInit(displayName, st.size, folderId);
        uploadId = init.uploadId;
        this.#remember(key, uploadId);
        controller.chunkSize = init.chunkSize;
        this.#emit(controller, 'started');
      }

      const chunkSize = controller.chunkSize || 16 * 1024 * 1024;
      const totalChunks = Math.ceil(st.size / chunkSize);
      const pending = [];
      for (let i = 0; i < totalChunks; i++) if (!done.has(i)) pending.push(i);

      const fh = await this.fs.promises.open(localPath, 'r');
      try {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
          while (cursor < pending.length) {
            if (controller.cancelled) return;
            const index = pending[cursor++];
            const size = Math.min(chunkSize, st.size - index * chunkSize);
            const buf = Buffer.allocUnsafe(size);
            const { bytesRead } = await fh.read(buf, 0, size, index * chunkSize);
            if (bytesRead !== size) throw new Error('读取文件失败');
            await this.#putChunk(uploadId, index, buf, controller);
            controller.sent += size;
            this.#emit(controller, 'progress');
          }
        });
        await Promise.all(workers);
      } finally {
        await fh.close();
      }

      if (controller.cancelled) {
        await this.client.uploadAbandon(uploadId).catch(() => {});
        this.#forget(key);
        this.#emit(controller, 'cancelled');
        throw new Error('已取消上传');
      }

      const res = await this.client.uploadComplete(uploadId, mimeFor(displayName));
      this.#forget(key);
      controller.sent = controller.total;
      this.#emit(controller, 'done');
      return { ok: true, file: res.file, deduped: !!res.deduped };
    } catch (err) {
      this.#emit(controller, 'error', { message: err.message });
      throw err;
    } finally {
      this.active.delete(jobId);
    }
  }

  async #putChunk(uploadId, index, buf, controller) {
    let delay = 400;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (controller.cancelled) return;
      try {
        await this.client.uploadChunk(uploadId, index, buf);
        return;
      } catch (err) {
        // A closed session or a declared-size mismatch will never succeed on retry.
        if (err.status === 401 || err.code === 'oversize' || err.code === 'closed') throw err;
        if (attempt === 4) throw err;
        this.#emit(controller, 'retry', { index, attempt });
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  cancel(jobId) {
    const c = this.active.get(jobId);
    if (c) c.cancelled = true;
  }

  #emit(controller, phase, extra) {
    this.onEvent({
      kind: 'upload',
      jobId: controller.jobId,
      name: controller.name,
      phase,
      sent: controller.sent,
      total: controller.total,
      ...extra,
    });
  }
}

export function baseName(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
