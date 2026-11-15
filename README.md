# Orange Music · 橙子音乐

> **两个客户端，一套 Web UI**：Windows 桌面版（单文件免安装）与 iOS 网页 / PWA 版。
> 无广告、不追踪、不接入任何统计 SDK。仅供个人学习与技术研究使用，请遵守各音乐平台的服务条款与版权规定。

- 项目主页：<https://github.com/Huiiiii0118/OrangeMusic>
- 作者：**12**
- 当前版本：**v1.0.0**（双端统一的首个正式版本）

---

## 一、两个软件分别是什么

### 1. Windows 桌面版 —— `OrangeMusic.exe`

| | 说明 |
|---|---|
| 交付形态 | **一个免安装单文件 exe**（约 117 MB，内置 Chromium 运行时） |
| 安装 | 双击即用，不写注册表、不装服务；删掉文件即卸载 |
| 首次启动 | 解压到 `%LOCALAPPDATA%\OrangeMusic\app-<版本>-<构建号>`（约 20~30 秒，带启动闪屏）；之后启动 1~2 秒 |
| 用户数据 | `%APPDATA%\橙子音乐`（升级 / 换新版本不受影响） |
| 界面 | **QQ 音乐风**：无边框、内容铺满窗口，半透明侧栏 + 系统蓝 `#0a84ff`，桌面播放条，细滚动条 |
| 系统集成 | 托盘常驻、关闭行为可选（询问 / 最小化到托盘 / 直接退出）、开机启动、精简播放器模式、**全局媒体键** |
| 音乐引擎 | **全部在本机运行**：按「歌名 + 歌手」从波点 / 酷我直接取完整音频，另有网易云解灰、酷狗、QQ 多源兜底；不依赖第三方托管服务、无需登录、无需会员 |
| 自动更新 | 启动时静默检查 GitHub Releases → 关于图标右上角**橙色小点** → 更新完成后弹出「本次更新内容」 |

### 2. iOS 版 —— 网页 / PWA

| | 说明 |
|---|---|
| 交付形态 | 部署在 HTTPS 上的网页，用 Safari 打开后「**添加到主屏幕**」即成为类原生应用 |
| 界面 | 大标题、毛玻璃迷你播放器、底部 Tab Bar、全屏歌词页、音量律动 |
| 取链方式 | 由**同源服务端**取链：`/api/search`、`/api/url`、`/api/charts`。服务端以「波点优先 + GD 镜像并行竞速」的方式，按「歌名 + 歌手 + 时长」三重校验出 320k 完整直链 |
| 锁屏 / 控制中心 | 播放卡第一行「歌名 - 歌手」，第二行跟随播放的当前歌词；按键为 **上一首 · 播放/暂停 · 下一首** |
| 离线外壳 | Service Worker 缓存应用外壳，断网 / 服务波动时也能从缓存秒开（音频仍需联网） |

> **注意**：iOS 锁屏卡「点一下打开哪个 App」由系统按 App 身份决定，纯网页应用无法指定，
> 可能跳到别的音乐应用；这是 WebKit 的系统行为，不是本项目的缺陷。

---

## 二、共同能力

- **搜索与曲库**：多平台聚合搜索，按「歌名 + 歌手」精确匹配，严格校验避免同名 / 翻唱串歌。
- **真实榜单**：QQ 音乐、网易云等榜单真实曲目，按板块智能归并。
- **发现 / 推荐**：歌单广场、热门歌手、口味推荐、电台。
- **歌词**：多通道竞速匹配 LRC，全屏同步歌词；iOS 另支持锁屏歌词行。
- **播放体验**：播放队列、播放模式（顺序 / 单曲 / 随机 / 列表循环）、音质偏好、音量律动可视化。
- **账号与同步**：邮箱 / 手机号验证码登录后，**收藏、最近播放、试听列表、播放进度**跨设备同步；
  一端**主动删除**，另一端同步后也会消失（删除墓碑机制）。未登录 / 匿名会话时数据只写本机。
- **隐私优先**：不上报行为数据，没有广告、没有统计 SDK、没有第三方 iframe。
- **自动更新**：设置 / 关于页可手动检查，也可在启动时静默检查。
- **更新内容查看**：一键查看最近 3 个版本的更新说明。

---

## 三、快速开始

### Windows

1. 从 [Releases](https://github.com/Huiiiii0118/OrangeMusic/releases) 下载 `OrangeMusic.exe`。
2. 双击运行（首次会解压 20~30 秒）。
3. 直接搜索或点首页推荐即可播放。

### iOS

1. 用 Safari 打开部署地址，等待应用加载完成。
2. 分享按钮 → **添加到主屏幕**，之后从主屏幕图标启动。
3. 首次播放需要一次点击（iOS 的音频授权策略）。

---

## 四、构建

### iOS 网页 / PWA

```bash
cd ios
npm install
node tools/build_web.js --out www --platform ios   # 组装站点到 ios/www
node server.js                                     # 同源服务：托管 www + /api/*
```

服务端 `/api/*` 提供搜索、取链、榜单；`PORT` 环境变量指定端口，监听 `0.0.0.0`。

### Windows 桌面版

```bash
cd windows
npm install
node tools/build_web.js --out electron/www --platform windows
node tools/build_exe.mjs        # 生成 dist/OrangeMusic.exe
```

> 打包链路：`electron-builder --win --dir` → `makensis` 封装成单文件 exe。
> 若本机 `ELECTRON_RUN_AS_NODE` 等环境变量被占用，构建脚本会先清理再启动 Electron。

---

## 五、版本与发布工作流

1. 改动在两个端分别完成后，由维护者确认无误。
2. 确认后**递增版本号**：`updater.js` 的 `CURRENT_VERSION`、`app.js` 的 `APP_VERSION`、各端 `package.json`。
3. **Windows**：重新打包 `OrangeMusic.exe` → 在 GitHub 发 Release 上传附件。
4. **iOS**：重新构建 `ios/www` → 直接部署到云端。
5. 最新版本软件另存一份到本地 `GitHub/` 目录作为归档（该目录已在 `.gitignore` 中，exe 不进仓库）。

---

## 六、目录结构

```
Orange Music/
├─ ios/              # iOS 网页 / PWA 端
│  ├─ shared/        #   Web UI、核心逻辑、协议桥、Service Worker
│  ├─ server.js      #   同源服务：静态站点 + /api/search｜url｜charts
│  ├─ local-api.cjs  #   可选：本机内置引擎适配（部署版不携带）
│  ├─ tools/         #   build_web.js 等
│  └─ www/           #   构建产物（gitignore）
├─ windows/          # Windows 桌面端
│  ├─ shared/        #   Web UI、核心逻辑、协议桥
│  ├─ electron/      #   主进程、preload、自定义协议、打包脚本与 NSIS 模板
│  ├─ tools/         #   build_web.js、build_exe.mjs
│  └─ dist/          #   OrangeMusic.exe（gitignore）
├─ GitHub/           # Release 归档（gitignore，exe 走 Release 附件）
├─ README.md         # 本文件（中文为主）
└─ README.en.md      # English README
```

---

## 七、界面一览

| 端 | 关键界面 |
|---|---|
| Windows | 首页推荐 / 乐馆 / 榜单 / 搜索 / 我的 / 设置 / 播放页 / 精简播放器 / 常驻播放条 |
| iOS | 首页 / 乐馆 / 搜索 / 我的 / 设置 / 全屏播放页（同步歌词 + 律动）/ 锁屏卡 |

---

## 八、合规与版权

本项目基于以下开源与第三方组件构建，版权与许可归各自所有者所有：

- 运行框架：Electron、Chromium（BSD 等开源许可）；iOS 端运行于系统自带 Safari / WebKit；
- 音乐引擎：`@neteasecloudmusicapienhanced/api`、`@unblockneteasemusic/server` 及各聚合音源网关（波点 / 酷我 / 酷狗 / QQ 等）；
- 公开放权音源：Jamendo、Free Music Archive、Musopen、CC0 作品；
- 封面与元数据来自各音乐平台公开接口。

**本项目不缓存音频、不转码、不存储任何音频内容**，仅提供个人学习用途的技术聚合。
音频内容版权归原作者与发行方所有；第三方平台音源的责任由使用者自行承担。
**请勿用于商业用途或公开传播。**

---

## 九、开源与贡献

本项目**代码开源**，源代码以 **MIT 许可证**发布（许可证正文见仓库根目录的 [LICENSE](LICENSE)）：

- ✅ **可自由使用**：个人、团队、商用场景均可使用；
- ✅ **可自由修改**：Fork 后随意改动、二次开发、改造成自己的播放器；
- ✅ **可再发布**：可以分发修改后的版本，无需公开你的改动；
- ⚠️ **唯一要求**：保留原始版权声明与 MIT 许可声明。

> 注意：MIT 只覆盖**本项目自己的代码**。第三方组件（Electron / Chromium / 各音乐引擎）遵循其各自许可；
> 音频内容版权归原作者与发行方所有，不因代码开源而改变。

**参与改进**：欢迎在 GitHub 提交 [Issue](https://github.com/Huiiiii0118/OrangeMusic/issues) 或 Pull Request。
提交 PR 前建议先开 Issue 说明改动方向，避免重复劳动。

---

**English**: see [README.en.md](README.en.md).
