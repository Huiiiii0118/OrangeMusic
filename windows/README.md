# 橙子音乐 · Windows 端（Electron · 独立项目）

本目录自成一体：`shared/`（源码）、`tools/`（构建脚本）、`electron/`（Electron 宿主）、`dist/`（产物）
全部在 `windows/` 内，与 `../ios/` **完全独立**——互不引用、互不影响，可以单独拷贝走。

## 构建

```bash
cd windows
node tools/build_web.js --out electron/www --platform windows   # 组装站点
node tools/build_exe.mjs                                        # 打包单文件 exe
```

前置条件：`electron/node_modules` 已安装（electron + electron-builder），且系统有 makensis（脚本会从
electron-builder 缓存里自动找）。

## 目录

| 路径 | 作用 |
|---|---|
| `shared/ui/` | 界面源码（index.html / app.js / app.css / tokens.css / theme-macos.css） |
| `shared/core/` `shared/protocol/` `shared/config/` | 业务逻辑、桥接、配置 |
| `electron/` | 主进程 `main.cjs`、`preload.cjs`、打包配置 `portable.nsi`、站点产物 `electron/www/` |
| `tools/build_web.js` | 从 `shared/` 组装静态站点到 `electron/www/` |
| `tools/build_exe.mjs` | electron-builder + makensis 封装单文件 |
| `dist/` | 产物（`OrangeMusic.exe`） |

> 注意：`windows/` 的界面改动**不会**影响 iOS 端，反之亦然。需要两端同步的逻辑，请分别修改。


主交付（就一个文件）：

| 产物 | 说明 |
|---|---|
| `windows/dist/OrangeMusic.exe` | **免安装单文件**。双击即用，放 U 盘 / 任意目录都行，删掉文件即卸载 |
| `windows/dist/使用说明.txt` | 给使用者的简短说明 |

**内置 Chromium + Node + 全部网页资源**，目标机器不需要 Edge / Chrome / Node / .NET / Python，也不用安装。
单文件版每次启动会把运行时自解压到 `%TEMP%\OrangeMusic`：首次约 20~30 秒，之后更快；构建产物里的
`win-unpacked` 等中间目录由构建脚本自动清掉，不再保留安装包。

## 与旧版（Node SEA + Edge --app）的区别

旧方案是「后台起一个本地 HTTP 服务，再借系统 Edge 以 `--app=` 打开网页」，依赖系统浏览器、留一个黑控制台窗口。
现在换成 Electron 正式桌面应用：

- 页面经自定义协议 **`app://orangemusic/index.html`** 读取 `app.asar` 内资源，**不起任何 HTTP 服务、不占端口**；
- 窗口无边框、**没有外壳**：内容从顶到底铺满整个窗口，不再模拟「浮在壁纸上的圆角卡片」；
  关闭 / 最小化 / 最大化收成右上角三个淡色小按钮（只在 Electron 里出现，网页版看不到），顶栏可拖动、双击最大化；
- 需要绕 CORS 的请求仍走 `app://orangemusic/api/net`，由主进程用核心 `http/https` 代发；
- 站外链接交给系统默认浏览器，应用内不做导航；单实例锁，重复打开只聚焦已有窗口。

## 使用

把 `OrangeMusic.exe` 放到任意位置，双击即可（无需安装、无需管理员权限）。首次启动会：
1. 自动在 GitHub 搜 `lx-music-source`，装配 ≥5 源聚合音源组；
2. 拉 QQ / 网易云榜单曲目，首页每条榜单显示自己的封面轮播；
3. 聚合 QQ 歌单广场 + 网易云推荐歌单、网易云歌手列表 + 榜单歌手，做智能排序。

未登录为「离线试用 · 仅本机」，数据写 localStorage；登录后跨端同步。

## 自检

```bash
# 开发态（快，直接用未打包的运行目录）
windows/electron/node_modules/electron/dist/electron.exe windows/electron --self-test --shot

# 成品（会先自解压一次，稍慢）
windows/dist/OrangeMusic.exe --self-test        # 打印一行 JSON 体检结果
windows/dist/OrangeMusic.exe --self-test --shot # 另存首页截图到 windows/electron/
```

自检覆盖：`app://` 资源加载、`/api/net` 代发（GitHub / GD 封面）、6 条榜单轮播、推荐歌单 / 热门歌手卡片、
乐馆→歌手页、以及点击榜单封面后的真实取链播放（`#previewAudio` 的 `paused` / `currentTime`）。

> 注意：本机 shell 若设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node 运行（报 `protocol` undefined）。
> 命令行调试时用 `env -u ELECTRON_RUN_AS_NODE ...`；双击 exe 不受影响。

## 视觉（macOS 风格）

内容铺满窗口、无交通灯与圆角外框、细滚动条、
半透明侧栏（音乐馆 / 我的音乐 / 自建歌单）、系统蓝 `#0a84ff` 强调、
蓝紫渐变 Banner、Finder 式分区导航、贴底半透明播放条；自动跟随系统深色模式。

板块与 iOS 网页版完全一致（QQ 音乐结构），只是主题 CSS 换成 `theme-macos.css`。

## 构建

```bash
npm run build:exe
# 等价于：
#   node tools/build_web.js --out windows/electron/www --platform windows
#   node tools/build_exe.mjs
```

`tools/build_exe.mjs` 流程：

1. 从 `shared/` 组装 38 个文件到 `windows/electron/www/`（注入 `theme-macos.css`、蓝色主题色）；
2. 确认 Electron 运行时（缺失时按 `ELECTRON_MIRROR` 下载，默认 npmmirror）；
3. `electron-builder` 打 `app.asar`，产出 portable **单文件 exe**；
4. 清掉 `win-unpacked` / blockmap / builder-debug.yml 等中间产物，`windows/dist/` 只留 `OrangeMusic.exe` 与说明。

依赖：Node ≥ 20、`windows/electron` 下已 `npm install`（electron + electron-builder，约 300 个包）。
运行产物不需要任何依赖。

## 工作原理

- `windows/electron/main.cjs`：注册 `app://` 特权协议（standard/secure/supportFetchAPI/corsEnabled）、
  路由 `/api/net`、创建无边框窗口、接管交通灯 IPC、单实例锁、外链外跳。
- `windows/electron/net.cjs`：`/api/net` 实现。核心 `http/https` 代发，支持 `http_proxy` / `https_proxy`
  CONNECT 隧道、5 次重定向、8MB 上限、超时；默认拦截内网目标（`OM_ALLOW_PRIVATE=1` 放开）。
- `windows/electron/preload.cjs`：只暴露 `orangeWindow.close/minimize/toggleMax`，上下文隔离，
  `nodeIntegration:false` + `sandbox:true`。

### 网络中转 `app://orangemusic/api/net`

LX 音源脚本与榜单 / 歌单接口常需自定义 header 且不带 CORS 头，页面直连会被拦。
请求体与出参沿用旧版：`{url, options, timeout}` → `{statusCode, headers, bodyRaw}`。
同局域网调试时，`app://` 不可被外部访问；如需给 iOS 网页版当中转，把 `net.cjs` 的代理实现挂到自建 HTTPS 域名即可。
