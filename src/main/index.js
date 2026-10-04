import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, protocol, safeStorage, session, shell } from 'electron';
import { DriveClient } from './client.js';
import { createJsonStore } from './store.js';
import { createVault } from './vault.js';
import { normalizeSettings, parseServerUrl } from './config.js';
import { UploadManager } from './uploads.js';
import { DownloadManager } from './downloads.js';
import { installMediaProtocol } from './proxy.js';
import { registerIpc } from './ipc.js';
import { createTray } from './tray.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '../renderer');
const APP_ID = 'com.bonfire.desktop';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bonfire',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
app.setName('Bonfire');

// BONFIRE_PROFILE lets an automated check run in a throwaway profile.
if (!app.isPackaged) {
  const profile = process.env.BONFIRE_PROFILE;
  app.setName(profile ? `bonfire-desktop-${profile}` : 'bonfire-desktop-dev');
  app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
}

let win = null;
let tray = null;
let quitting = false;
const transfers = []; // ring buffer of recent events, so a late-loading renderer still sees progress

const settingsStore = createJsonStore({ fs, file: path.join(app.getPath('userData'), 'settings.json'), fallback: null });
const resumeStore = createJsonStore({ fs, file: path.join(app.getPath('userData'), 'uploads.json'), fallback: {} });
const vault = createVault({ safeStorage, filePath: path.join(app.getPath('userData'), 'secrets.bin'), fs });

let settings = normalizeSettings(settingsStore.load());
const client = new DriveClient({ getBaseUrl: () => settings.serverUrl });

const emit = (evt) => {
  transfers.push(evt);
  if (transfers.length > 200) transfers.shift();
  if (win && !win.isDestroyed()) win.webContents.send('transfer', evt);
  if (evt.phase === 'done' && evt.kind === 'upload') sendToRenderer('files-changed', { name: evt.name });
  if (evt.phase === 'progress') taskbarProgress(activeFraction());
  else if (evt.phase === 'done' || evt.phase === 'error' || evt.phase === 'cancelled') taskbarProgress(0);
  tray?.refresh();
  if (evt.phase === 'done' && settings.notifyOnFinish) notify(evt);
};

// Taskbar progress reflects the whole queue, not the last event.
function activeFraction() {
  let sent = 0;
  let total = 0;
  for (const t of transfers.slice(-40)) {
    if (t.phase === 'progress' || t.phase === 'started' || t.phase === 'resuming') {
      sent += Number(t.sent) || 0;
      total += Number(t.total) || 0;
    }
  }
  return total > 0 ? sent / total : 0;
}

const uploads = new UploadManager({
  client,
  fs,
  store: resumeStore,
  onEvent: emit,
});
const downloads = new DownloadManager({
  client,
  fs,
  path,
  getDir: () => downloadDir(),
  onEvent: emit,
});

function downloadDir() {
  return settings.downloadDir || app.getPath('downloads') || os.homedir();
}

function notify(evt) {
  try {
    new Notification({
      title: evt.kind === 'upload' ? '上传完成' : '下载完成',
      body: evt.name || '',
    }).show();
  } catch {
    /* notifications are a nicety, never a failure */
  }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function saveSettings(patch) {
  const next = normalizeSettings({ ...settings, ...patch });
  const changedOrigin = next.serverUrl !== settings.serverUrl;
  settings = next;
  settingsStore.save(settings);
  if (changedOrigin) {
    client.resetSession();
    vault.unset('cookieJar');
  }
  return settings;
}

let cachedProfile = null;

const state = {
  get settings() {
    return settings;
  },
  get serverKind() {
    const p = parseServerUrl(settings.serverUrl);
    return p.ok ? p : { ok: false, reason: '地址无效' };
  },
  get authed() {
    return client.authed;
  },
  get profile() {
    return cachedProfile;
  },
  vault,
  vaultCanPersist: () => vault.canPersist(),
  downloadDir,
  client,
  uploads,
  downloads,
  transferLog: () => transfers.slice(-60),
  saveSettings,
  setProfile: (p) => {
    cachedProfile = p;
    tray?.refresh();
  },
  quit: () => {
    quitting = true;
    app.quit();
  },
  showWindow,
  taskbarProgress,
};

function createWindow() {
  const isMac = process.platform === 'darwin';
  const startDark = settings.theme !== 'light';
  const chrome = startDark ? '#232323' : '#ededed';
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: chrome,
    // an Electron window stop looking like a browser tab.
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? undefined : { color: chrome, symbolColor: startDark ? '#eaeaea' : '#1a1a1a', height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.GOPAN_DEVTOOLS === '1',
    },
  });

  win.once('ready-to-show', () => {
    if (!settings.startHidden) win.show();
  });

  const pushState = () => sendToRenderer('window-state', { maximized: win.isMaximized(), focused: win.isFocused() });
  win.on('maximize', pushState);
  win.on('unmaximize', pushState);
  win.on('focus', pushState);
  win.on('blur', pushState);

  // Closing the window hides it; the tray (or Ctrl+Q) is the real exit.
  win.on('close', (e) => {
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
  if (!app.isPackaged && process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function taskbarProgress(percent) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setProgressBar(Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0);
  } catch {
    /* the window may be mid-teardown */
  }
}

// ---- hard boundaries for the one webContents we own ----
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(pathToFileURL(RENDERER).toString())) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    installMediaProtocol({ protocol, client, isAuthed: () => client.authed });

    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);

    // not on a login form the user has already completed.
    const jar = vault.get('cookieJar');
    if (jar) {
      try {
        client.restoreJar(JSON.parse(jar));
      } catch {
        vault.unset('cookieJar');
      }
    }

    registerIpc({ ipcMain, state, deps: { app, dialog, shell, BrowserWindow, Menu, path, fs, getWindow: () => win } });
    createWindow();
    if (settings.minimizeToTray) tray = createTray({ state, paths: { HERE }, onAction: (a) => handleTrayAction(a) });

    app.on('activate', () => showWindow());
  });
}

function handleTrayAction(action) {
  if (action === 'quit') {
    quitting = true;
    app.quit();
    return;
  }
  if (action === 'show') showWindow();
  if (action === 'upload') sendToRenderer('tray-action', { action: 'pick-upload' });
  if (action === 'downloads') shell.openPath(downloadDir());
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '上传文件…', accelerator: 'CmdOrCtrl+U', click: () => sendToRenderer('tray-action', { action: 'pick-upload' }) },
        { label: '打开下载文件夹', click: () => shell.openPath(downloadDir()) },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit', label: isMac ? '关闭窗口' : '退出' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'hide' }] },
  ]);
}

app.on('before-quit', () => {
  quitting = true;
  tray?.destroy?.();
});

app.on('window-all-closed', () => {
  // Without a tray (Linux minimal setups) the app must still be able to exit.
  if (!settings.minimizeToTray || !tray) app.quit();
});
