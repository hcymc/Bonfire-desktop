export class CookieJar {
  #map = new Map();

  addSetCookies(setCookieHeaders, now = Date.now()) {
    for (const line of setCookieHeaders || []) this.#addOne(String(line), now);
    return this;
  }

  #addOne(header, now) {
    const parts = header.split(';');
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!name) return;

    const attrs = {};
    for (const p of parts.slice(1)) {
      const i = p.indexOf('=');
      const k = (i > 0 ? p.slice(0, i) : p).trim().toLowerCase();
      attrs[k] = i > 0 ? p.slice(i + 1).trim() : '';
    }

    let expiresAt = null;
    if ('max-age' in attrs) {
      const secs = Number(attrs['max-age']);
      if (Number.isFinite(secs)) expiresAt = secs <= 0 ? 0 : now + secs * 1000;
    } else if (attrs.expires) {
      const t = Date.parse(attrs.expires);
      if (!Number.isNaN(t)) expiresAt = t;
    }

    if (expiresAt === 0) this.#map.delete(name);
    else {
      this.#map.set(name, {
        name,
        value,
        expiresAt,
        httpOnly: 'httponly' in attrs,
        sameSite: (attrs.samesite || 'lax').toLowerCase(),
      });
    }
  }

  get(name) {
    const c = this.#map.get(name);
    if (!c) return null;
    if (c.expiresAt != null && c.expiresAt <= Date.now()) {
      this.#map.delete(name);
      return null;
    }
    return c.value;
  }

  header() {
    this.prune();
    return [...this.#map.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clear() {
    this.#map.clear();
  }

  prune() {
    const now = Date.now();
    for (const [k, c] of this.#map) if (c.expiresAt != null && c.expiresAt <= now) this.#map.delete(k);
  }

  toJSON() {
    this.prune();
    return [...this.#map.values()];
  }

  static fromJSON(list) {
    const jar = new CookieJar();
    for (const c of Array.isArray(list) ? list : []) {
      if (c && typeof c.name === 'string' && typeof c.value === 'string') {
        jar.#map.set(c.name, {
          name: c.name,
          value: c.value,
          expiresAt: Number.isFinite(c.expiresAt) ? c.expiresAt : null,
          httpOnly: !!c.httpOnly,
          sameSite: typeof c.sameSite === 'string' ? c.sameSite : 'lax',
        });
      }
    }
    return jar;
  }
}
