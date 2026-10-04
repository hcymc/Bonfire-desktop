const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, arg) {
  const res = await ipcRenderer.invoke(channel, arg);
  if (res && res.ok === false) {
    const err = new Error(res.error && res.error.message ? res.error.message : '操作失败');
    err.status = (res.error && res.error.status) || 0;
    err.code = (res.error && res.error.code) || null;
    throw err;
  }
  return res ? res.data : undefined;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bonfire', {
  boot: () => call('bonfire:boot'),
  checkSession: () => call('bonfire:session:check'),
  login: (input) => call('bonfire:login', input),
  logout: () => call('bonfire:logout'),
  savedCredential: () => call('bonfire:saved-credential'),
  forgetCredential: () => call('bonfire:forget-credential'),

  setServer: (input) => call('bonfire:server:set', input),
  checkServer: (url) => call('bonfire:server:check', url),
  patchSettings: (patch) => call('bonfire:settings:patch', patch),
  diskInfo: () => call('bonfire:disk:info'),
  bestDownloadDir: () => call('bonfire:disk:best'),
  checkUpdate: () => call('bonfire:update:check'),
  downloadUpdate: () => call('bonfire:update:download'),

  listFiles: (folderId) => call('bonfire:files:list', folderId),
  fileMeta: (id) => call('bonfire:files:meta', id),
  fileText: (id) => call('bonfire:files:text', id),
  createFolder: (input) => call('bonfire:folder:create', input),
  renameFile: (input) => call('bonfire:file:rename', input),
  renameFolder: (input) => call('bonfire:folder:rename', input),
  moveFile: (input) => call('bonfire:file:move', input),
  moveFolder: (input) => call('bonfire:folder:move', input),
  deleteFile: (id) => call('bonfire:file:delete', id),
  deleteFolder: (id) => call('bonfire:folder:delete', id),

  recycleList: () => call('bonfire:recycle:list'),
  recycleRestore: (input) => call('bonfire:recycle:restore', input),
  recyclePurge: (input) => call('bonfire:recycle:purge', input),

  createShare: (input) => call('bonfire:share:create', input),
  listShares: () => call('bonfire:share:list'),
  deleteShare: (id) => call('bonfire:share:delete', id),

  getProfile: () => call('bonfire:profile:get'),
  updateProfile: (input) => call('bonfire:profile:update', input),
  changePassword: (input) => call('bonfire:profile:password', input),
  pickAvatar: () => call('bonfire:avatar:pick'),
  setAvatar: (input) => call('bonfire:avatar:set', input),
  clearAvatar: () => call('bonfire:avatar:clear'),

  pickUploadPaths: () => call('bonfire:upload:pick'),
  pickDirectory: () => call('bonfire:dialog:directory'),
  addUploads: (input) => call('bonfire:upload:add', input),
  cancelUpload: (jobId) => call('bonfire:upload:cancel', jobId),
  startDownload: (input) => call('bonfire:download:start', input),
  cancelDownload: (jobId) => call('bonfire:download:cancel', jobId),
  revealDownload: (p) => call('bonfire:download:reveal', p),
  openDownload: (p) => call('bonfire:download:open', p),

  mediaUrl: (input) => call('bonfire:media:url', input),
  openExternal: (url) => call('bonfire:open:external', url),
  windowControl: (action) => call('bonfire:window', action),
  setWindowTheme: (dark) => call('bonfire:window:appearance', { dark: !!dark }),
  contextMenu: (input) => call('bonfire:context-menu', input),
  // path to stream from disk, and this is the only sanctioned way to get it.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  onTransfer: (cb) => on('transfer', cb),
  onFilesChanged: (cb) => on('files-changed', cb),
  onTrayAction: (cb) => on('tray-action', cb),
  onWindowState: (cb) => on('window-state', cb),
});
