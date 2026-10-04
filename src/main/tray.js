import path from 'node:path';
import { Menu, Tray, nativeImage } from 'electron';

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(bytes) || 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function createTray({ state, paths, onAction }) {
  const file = path.join(paths.HERE, '../../build/tray.png');
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  else image = image.resize({ width: 16, height: 16 });

  const tray = new Tray(image);
  tray.setToolTip('篝火云盘');

  const build = () => {
    const p = state.profile;
    const items = [];
    if (p) {
      const pct = p.quota_bytes > 0 ? Math.round((p.used_bytes / p.quota_bytes) * 100) : 0;
      items.push({ label: `${p.display_name || p.username} · 已用 ${human(p.used_bytes)} / ${human(p.quota_bytes)}（${pct}%）`, enabled: false });
      items.push({ type: 'separator' });
    } else {
      items.push({ label: state.authed ? '已连接' : '未登录', enabled: false });
    }
    items.push(
      { label: '显示主窗口', click: () => onAction('show') },
      { label: '上传文件…', click: () => onAction('upload') },
      { label: '打开下载文件夹', click: () => onAction('downloads') },
      { type: 'separator' },
      { label: '退出', click: () => onAction('quit') },
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.setToolTip(p ? `篝火云盘 · ${p.display_name || p.username} · ${human(p.used_bytes)}/${human(p.quota_bytes)}` : '篝火云盘');
  };

  tray.on('click', () => onAction('show'));
  tray.on('double-click', () => onAction('show'));
  build();

  return {
    refresh: build,
    destroy: () => tray.destroy(),
  };
}
