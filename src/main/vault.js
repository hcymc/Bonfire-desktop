const ALGO = 'safe-storage';

export function createVault({ safeStorage, filePath, fs }) {
  let cache = null;
  let loaded = false;

  const available = () => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  function readItems() {
    try {
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!doc || doc.v !== 1 || doc.algo !== ALGO || typeof doc.items !== 'object') return {};
      return doc.items;
    } catch {
      return {};
    }
  }

  function writeItems(items) {
    fs.mkdirSync(dirOf(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, algo: ALGO, items }), { mode: 0o600 });
    try {
      // Windows: rename refuses to replace an existing file.
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
      fs.renameSync(tmp, filePath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing else to clean */
      }
    }
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cache = {};
    if (!available()) return;
    const items = readItems();
    let dropped = false;
    for (const [name, b64] of Object.entries(items)) {
      try {
        cache[name] = safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
      } catch {
        delete items[name]; // encrypted for another user/machine: drop it silently
        dropped = true;
      }
    }
    if (dropped) writeItems(items);
  }

  function persist() {
    if (!available() || !cache) return; // memory-only mode: nothing ever hits the disk
    const items = {};
    for (const [name, text] of Object.entries(cache)) {
      items[name] = safeStorage.encryptString(text).toString('base64');
    }
    writeItems(items);
  }

  return {
    canPersist: available,
    set(name, text) {
      ensureLoaded();
      cache[name] = String(text);
      persist();
    },
    get(name) {
      ensureLoaded();
      return Object.prototype.hasOwnProperty.call(cache, name) ? cache[name] : null;
    },
    unset(name) {
      ensureLoaded();
      delete cache[name];
      persist();
    },
    clear() {
      loaded = true;
      cache = {};
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* nothing on disk */
      }
    },
  };
}

function dirOf(file) {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : '.';
}
