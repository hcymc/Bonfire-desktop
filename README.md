# Bonfire Desktop

篝火云盘（gopan）的桌面客户端。Electron + 原生 ES 模块，**没有任何运行时依赖**。

> An Electron desktop client for a gopan-compatible drive. All HTTP lives in the main process, credentials never leave the OS keystore, and the renderer is a sandboxed document with `connect-src 'none'`.

## 特性

- 无边框窗口 + 系统原生标题栏按钮（Windows 11 Fluent 观感，浅色/深色/跟随系统）
- 左侧栏导航、可排序可搜索的列表、详情窗格、键盘操作、**真系统右键菜单**
- 分片上传（16 MiB/片，断点续传，重启后从缺失分片继续）
- Range 续传下载、`.part` 断点保留、实时速度与托盘进度
- 预览：图片 / 视频 / 音频 / PDF / 文本，走服务端已校验的预览通道
- 分享、回收站、账号设置（昵称 / 简介 / 头像 / 改密码）
- 外观个性化：主题、5 种强调色、列表密度、动效开关
- 检查更新与安装程序下载（下载后校验 sha256）
- 多平台产物：Windows x64 / ARM64（便携版 + 安装包）、Linux AppImage / deb、macOS dmg

## 架构

```
renderer (sandboxed, CSP locked)
   │  contextBridge → window.bonfire.<named methods>
main process
   ├─ client.js     the only HTTP client: cookie jar + CSRF double-submit
   ├─ proxy.js      bonfire:// scheme, streams media through with the session attached
   ├─ uploads.js    chunked resumable upload
   ├─ downloads.js  Range resume + sha256 verification
   ├─ vault.js      OS keystore (DPAPI / Keychain / libsecret) for session + optional password
   ├─ config.js     server URL validation
   └─ ipc.js        named channels, native context menu, window controls
```

渲染层不发任何请求：`connect-src 'none'`。数据要么走具名 IPC，要么走 `bonfire://` 代理（只允许三种 URL 形状）。这样做的两个结果：会话 cookie 是 `HttpOnly` 也照样能用（不依赖浏览器 SameSite 规则），以及桌面端永远不会向不属于它的页面注入脚本。

## 安全模型

| 项目 | 做法 |
| --- | --- |
| 凭据落盘 | `safeStorage` 加密（Windows DPAPI / macOS 钥匙串 / libsecret）；系统加密不可用时**只存内存，绝不写明文** |
| 切换服务器 | 立即丢弃旧会话与 cookie |
| 地址校验 | 只接受 http/https 根地址；拒绝内嵌账号密码、带路径；公网明文 http 需要显式确认 |
| 媒体代理 | 剥掉 `Set-Cookie` 与 `X-Frame-Options`，仅重写 `frame-ancestors`；只放行清单式 URL 形状 |
| 下载文件名 | 服务端文件名按不可信数据处理：控制字符、路径分隔符、Windows 保留名、重名序号；读写都限制在下载目录内 |
| 外链 | 只允许打开当前云盘同源的地址 |
| 窗口 | `contextIsolation` + `sandbox` + `nodeIntegration:false` + `webviewTag:false`；权限请求一律拒绝 |
| 更新包 | 清单字段严格校验，下载后比对 sha256，不匹配即删除 |

预览仍然由服务端裁决（扩展名白名单 → 危险扩展 403 → 体积上限 → 魔术字节必须与扩展名一致 → 每响应独立 CSP）。客户端只负责把 415 显示成一张错误卡片加重试。

## 快速开始

```bash
npm install
npm start          # 需要本地或远程有一个 gopan 服务端
npm test           # 单元测试（纯逻辑，不需要 Electron）
```

网络受限的环境可把 `.npmrc.example` 复制成 `.npmrc` 换镜像；请不要为此改全局 npm 配置。

## 打包

```bash
npm run dist            # Windows x64 + ARM64：NSIS 安装包 + 免安装 zip
npm run dist:win:x64    # 只出 x64
npm run dist:win:arm64  # 只出 ARM64
npm run portable        # 只对 dist/ 里已有的解包目录重新压 zip
npm run dist:linux      # AppImage + deb（需在 Linux 上构建）
npm run dist:mac        # dmg（需在 macOS 上构建）
```

产物在 `dist/`：

- `Bonfire-1.0.0-rc.1-x64-setup.exe` / `-arm64-setup.exe` — NSIS 安装版
- `Bonfire-1.0.0-rc.1-win-x64-portable.zip` — 免安装版，解压出来是一个 `Bonfire/` 文件夹，双击 `Bonfire.exe` 直接跑，不写注册表、不需要管理员权限

预编译好的产物在 [Releases](https://github.com/hcymc/Bonfire-desktop/releases)：打 tag 后由 CI 出六个平台/架构组合，附带 `SHA256SUMS.txt`。

`scripts/pack-portable.mjs` 只打包"当前这个平台"的解包目录，因为跨平台留下的目录没法在这里验证；CI 用 `--all`，每个 runner 压自己那份。Linux 与 macOS 目标无法在 Windows 上交叉构建，仓库自带 `.github/workflows/release.yml` 用矩阵一次出齐六个组合，并在打 tag 时创建 Release + 生成 `SHA256SUMS.txt`。

免安装版的配置与会话仍然写在系统用户目录（Windows 是 `%APPDATA%\Bonfire`），因为凭据要靠系统级加密（DPAPI / 钥匙串 / libsecret），跟着 exe 走到 U 盘上就失去意义了。要换机器搬数据，请重新登录。

未配置代码签名：macOS 需要自行 `notarize`，Windows 首次运行会有 SmartScreen 提示。

## 更新通道

服务端提供两个公开只读接口：

- `GET /api/releases/latest` → `{version, file, size, sha256, notes, date}`，没有发布时 404 `no_release`
- `GET /releases/<file>` → 只允许下载清单点名的文件，`attachment` + `application/octet-stream` + `nosniff`，支持 Range

发布新版本：

```bash
npm run dist
node scripts/publish-release.mjs dist/Bonfire-1.0.0-x64-setup.exe --out <服务端 data/releases 目录>
```

客户端在 **设置 → 关于与更新** 检查并下载；下载完成会比对 sha256，不匹配就删除文件并报错。删除服务端的 `data/releases/` 即关闭通道。

## 开发辅助

- `scripts/dev/cdp.mjs` — 通过 DevTools 协议驱动渲染层做断言（`--file`、`--metrics 900x600`、`--console 5`）
- `scripts/dev/win-capture.ps1` — 用 `PrintWindow` 抓窗口像素，被遮挡也能抓
- `BONFIRE_PROFILE=ci npm start` — 用独立的 userData 目录跑实例，不污染已安装版本的设置，也不与它抢单实例锁
- `npm run icons` — 图标由 `scripts/make-icons.mjs` 代码绘制，无二进制素材

## 已知限制

- 管理面板（用户、审计、危险文件）留在网页端，桌面端只做"用盘"
- 拖拽上传依赖 `webUtils.getPathForFile`：从资源管理器拖入有效，无本地路径的项目会被跳过并提示
- 传输队列不做持久化，重启后已完成的历史不保留（进行中的分片可续传）
- macOS / Linux 仅有构建配置与 CI，未在真机验证

## License

MIT © hcy_neo — 详见 [LICENSE](LICENSE)。
