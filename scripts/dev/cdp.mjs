import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const PORT = process.env.GOPAN_CDP_PORT || '9222';

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error(`no renderer page on :${PORT} — start with --remote-debugging-port=${PORT}`);
  return page;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true });
  });
  return {
    ws,
    ready: open,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    on(fn) {
      listeners.push(fn);
    },
    close: () => ws.close(),
  };
}

const page = await targets();
const cdp = connect(page.webSocketDebuggerUrl);
await cdp.ready;

if (args[0] === '--console') {
  const secs = Number(args[1] || 5);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const parts = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type);
      console.log(`[console.${msg.params.type}]`, ...parts);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('[exception]', msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') console.log(`[log.${e.level}]`, e.text, e.url || '');
    }
  });
  console.log(`listening ${secs}s on ${page.url}`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  cdp.close();
  process.exit(0);
}

if (args[0] === '--metrics') {
  // (Browser.setWindowBounds is ignored while the window is maximized).
  const [w, h] = args[1].split('x').map(Number);
  if (!w || !h) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    console.log('metrics cleared');
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    console.log(`metrics ${w}x${h}`);
  }
  cdp.close();
  process.exit(0);
}

if (args[0] === '--resize') {
  const [w, h] = args[1].split('x').map(Number);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h, windowState: 'normal' } });
  console.log(`resized to ${w}x${h}`);
  cdp.close();
  process.exit(0);
}

if (args[0] === '--eval' || args[0] === '--file') {
  const expression =
    args[0] === '--file'
      ? await readFile(args[1], 'utf8') // CJK paths survive only through a real UTF-8 file
      : args.slice(1).join(' ');
  await cdp.send('Runtime.enable');
  const metrics = process.env.GOPAN_METRICS;
  if (metrics) {
    const [mw, mh] = metrics.split('x').map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: mw, height: mh, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
  }
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (metrics) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  if (r.exceptionDetails) {
    console.error('EVAL ERROR:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    process.exit(1);
  }
  console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
  cdp.close();
  process.exit(0);
}

console.log('usage: cdp.mjs --eval <js> | --file <script.js> | --console <seconds>');
cdp.close();
process.exit(2);
