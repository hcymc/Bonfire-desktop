export function createJsonStore({ fs, file, fallback = null }) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return fallback == null ? null : structuredClone(fallback);
      }
    },
    save(value) {
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        fs.mkdirSync(parentOf(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
        if (fs.existsSync(file)) fs.rmSync(file);
        fs.renameSync(tmp, file);
        return true;
      } catch {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* nothing to clean */
        }
        return false;
      }
    },
  };
}

function parentOf(file) {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : '.';
}
