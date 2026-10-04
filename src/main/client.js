import { CookieJar } from './cookies.js';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
  }
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class DriveClient {
  /** @param {{getBaseUrl: () => string, fetchImpl?: typeof fetch}} opts */
  constructor(opts) {
    this.getBaseUrl = opts.getBaseUrl;
    this.fetch = opts.fetchImpl || ((...a) => fetch(...a));
    this.jar = new CookieJar();
    this.csrf = null;
  }

  get authed() {
    return !!this.jar.get('gopan_sess');
  }

  resetSession() {
    this.jar.clear();
    this.csrf = null;
  }

  #abs(pathname) {
    const base = this.getBaseUrl();
    if (!base) throw new ApiError('还没有配置服务器地址', 0, 'no_server');
    return new URL(pathname, base).toString();
  }

  #captureCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/);
    this.jar.addSetCookies(list);
    const csrf = this.jar.get('gopan_csrf');
    if (csrf) this.csrf = csrf;
  }

  async #send(method, pathname, { body, headers, rawBody } = {}) {
    const h = { ...(headers || {}) };
    const cookie = this.jar.header();
    if (cookie) h.cookie = cookie;
    if (MUTATIONS.has(method) && this.csrf) h['x-csrf-token'] = this.csrf;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      h['content-type'] = h['content-type'] || 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetch(this.#abs(pathname), { method, headers: h, body: payload });
    } catch (err) {
      // undici wraps ECONNREFUSED etc. — the user needs "连不上" not a stack string.
      throw new ApiError(`无法连接服务器（${err?.cause?.code || err?.message || '网络错误'}）`, 0, 'network');
    }
    this.#captureCookies(res);
    return res;
  }

  async #json(method, pathname, opts) {
    const res = await this.#send(method, pathname, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(`服务器返回了非 JSON 响应 (${res.status})`, res.status, 'bad_json');
      }
    }
    if (!res.ok) {
      throw new ApiError(data?.error || `请求失败 (${res.status})`, res.status, data?.code);
    }
    return data;
  }

  // ---- auth ----
  login(username, password) {
    return this.#json('POST', '/api/auth/login', { body: { username, password } });
  }
  register(username, password) {
    return this.#json('POST', '/api/auth/register', { body: { username, password } });
  }
  logout() {
    return this.#json('POST', '/api/auth/logout', { body: {} });
  }
  me() {
    return this.#json('GET', '/api/auth/me');
  }

  // ---- files ----
  listFiles(folderId = null) {
    const q = folderId == null ? '' : `?folderId=${encodeURIComponent(folderId)}`;
    return this.#json('GET', `/api/files${q}`);
  }
  fileMeta(id) {
    return this.#json('GET', `/api/files/meta/${id}`);
  }
  mkdir(name, parentId = null) {
    return this.#json('POST', '/api/files/folder', { body: { name, parentId } });
  }
  renameFile(id, name) {
    return this.#json('PATCH', `/api/files/${id}`, { body: { name } });
  }
  renameFolder(id, name) {
    return this.#json('PATCH', `/api/files/folder/${id}`, { body: { name } });
  }
  moveFile(id, folderId) {
    return this.#json('POST', `/api/files/${id}/move`, { body: { folderId } });
  }
  moveFolder(id, folderId) {
    return this.#json('POST', `/api/files/folder/${id}/move`, { body: { folderId } });
  }
  deleteFile(id) {
    return this.#json('DELETE', `/api/files/${id}`);
  }
  deleteFolder(id) {
    return this.#json('DELETE', `/api/files/folder/${id}`);
  }

  // ---- recycle ----
  recycleList() {
    return this.#json('GET', '/api/files/recycle/list');
  }
  restoreFile(id) {
    return this.#json('POST', `/api/files/recycle/${id}/restore`, { body: {} });
  }
  purgeFile(id) {
    return this.#json('DELETE', `/api/files/recycle/${id}`);
  }
  restoreFolder(id) {
    return this.#json('POST', `/api/files/recycle/folder/${id}/restore`, { body: {} });
  }
  purgeFolder(id) {
    return this.#json('DELETE', `/api/files/recycle/folder/${id}`);
  }

  // ---- shares ----
  createShare(input) {
    return this.#json('POST', '/api/shares', { body: input });
  }
  listShares() {
    return this.#json('GET', '/api/shares');
  }
  deleteShare(id) {
    return this.#json('DELETE', `/api/shares/${id}`);
  }

  // ---- profile ----
  profile() {
    return this.#json('GET', '/api/me');
  }
  updateProfile(displayName, bio) {
    return this.#json('PATCH', '/api/me', { body: { displayName, bio } });
  }
  uploadAvatar(buffer, contentType) {
    return this.#json('POST', '/api/me/avatar', {
      rawBody: buffer,
      headers: { 'content-type': contentType },
    });
  }
  removeAvatar() {
    return this.#json('DELETE', '/api/me/avatar');
  }
  changePassword(oldPassword, newPassword) {
    return this.#json('POST', '/api/me/password', { body: { oldPassword, newPassword } });
  }

  // ---- resumable upload (mounted at /api/uploads) ----
  uploadInit(name, size, folderId) {
    return this.#json('POST', '/api/uploads/init', { body: { name, size, folderId } });
  }
  uploadStatus(uploadId) {
    return this.#json('GET', `/api/uploads/${encodeURIComponent(uploadId)}`);
  }
  uploadChunk(uploadId, index, buffer) {
    return this.#json('PUT', `/api/uploads/${encodeURIComponent(uploadId)}/chunk/${index}`, {
      rawBody: buffer,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  uploadComplete(uploadId, mime) {
    return this.#json('POST', `/api/uploads/${encodeURIComponent(uploadId)}/complete`, { body: { mime } });
  }
  uploadAbandon(uploadId) {
    return this.#json('DELETE', `/api/uploads/${encodeURIComponent(uploadId)}`);
  }

  // ---- streaming for the bonfire:// proxy and the download manager ----
  // through, which is what makes video seeking and resumed downloads work.
  async stream(pathname, { range } = {}) {
    const h = {};
    const cookie = this.jar.header();
    if (cookie) h.cookie = cookie;
    if (range) h.range = range;
    let res;
    try {
      res = await this.fetch(this.#abs(pathname), { method: 'GET', headers: h });
    } catch (err) {
      throw new ApiError(`无法连接服务器（${err?.cause?.code || err?.message || '网络错误'}）`, 0, 'network');
    }
    this.#captureCookies(res);
    return res;
  }

  serializeJar() {
    return this.jar.toJSON();
  }
  restoreJar(list) {
    this.jar = CookieJar.fromJSON(list);
    const csrf = this.jar.get('gopan_csrf');
    if (csrf) this.csrf = csrf;
    return this.authed;
  }
}
