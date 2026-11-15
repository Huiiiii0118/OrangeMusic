# 橙子音乐 · iOS 端（PWA · 独立项目）

本目录自成一体：`shared/`（源码）、`tools/`（构建脚本）、`www/`（产物）全部在 `ios/` 内，
与 `../windows/` **完全独立**——互不引用、互不影响，可以单独拷贝走。

## 构建

```bash
cd ios
node tools/build_web.js --out www --platform ios
```

产物 `ios/www/`（42 个文件）可直接部署；在 Safari 打开后「分享 → 添加到主屏幕」即全屏 PWA。

## 目录

| 路径 | 作用 |
|---|---|
| `shared/ui/` | 界面源码（index.html / app.js / app.css / tokens.css / theme-ios.css） |
| `shared/core/` `shared/protocol/` `shared/config/` | 业务逻辑、桥接、配置 |
| `shared/pwa/` | manifest / service worker / 图标 |
| `tools/build_web.js` | 从 `shared/` 组装静态站点到 `www/` |
| `www/` | 构建产物（可直接部署） |

> 注意：`ios/` 的界面改动**不会**影响 Windows 端，反之亦然。需要两端同步的逻辑，请分别修改。


当前 iOS 主交付是**网页应用**，不再需要 Xcode 或 TestFlight。用 Safari 打开站点即可使用，
「分享 → 添加到主屏幕」后以全屏 standalone 运行，看起来与原生 App 一致。

## 产物

`ios/www/` —— 由 `tools/build_web.js` 从 `shared/` 组装的完整静态站点（31 个文件，含 vendor 种子）：

```
index.html                 根入口（注入 theme-ios.css）
manifest.webmanifest       PWA 清单（standalone / 主题色 #fa243c / 图标）
sw.js                      网络优先 + 离线兜底，只缓存同源静态资源
icon-180/192/512.png       apple-touch-icon 与 PWA 图标（tools/make_icons.py 生成，纯标准库）
ui/  config/  protocol/  core/   与 shared/ 一一对应，业务逻辑完全同源
```

## 视觉（Apple Music 风格）

红色强调 `#fa243c`、粉红渐变 Banner、30px 大标题、6 个圆形快捷入口、
两列大封面卡片、圆角毛玻璃悬浮迷你播放器、底部 4 项 Tab Bar、全屏渐变歌词播放页；
自动跟随系统深色模式，适配刘海 / 状态栏 / Home 指示条安全区。

## 运行

```bash
npm run build:ios                      # 重新生成 ios/www
cd ios/www && python3 -m http.server 8765 --bind 0.0.0.0
```

- 电脑浏览器：`http://127.0.0.1:8765`
- iPhone（同一 WiFi）：`http://<电脑局域网IP>:8765`，Safari 打开后添加到主屏幕
- 公网访问：把 `ios/www/` 部署到任意 HTTPS 静态托管（发布后可直接在 iPhone 上用）

## 测试要点

- 未登录时是「离线试用」：数据只存本机，顶栏会明确标注，不伪造云端身份。
- 「我的 → 本地和下载」可用 Safari 文件选择器选 mp3/flac 直接播放。
- 云登录需要 **HTTPS 发布域名**，云 SDK 会校验 Origin；localhost / 局域网 IP 无法完成 OAuth 回调。
- 「乐馆 → 排行榜」展示 48 个榜单按 7 个 QQ 音乐式板块的智能分组，卡片带置信度与匹配依据。

## LX 音源 · GitHub 自动发现与网络中转（重要）

启动时会在 GitHub 搜 `lx-music-source`，自动挑出最新可用的 5~6 个脚本组成**聚合音源组**并行加载，
同一首歌同时向所有源要链接并按「音质 → 成功率 → HTTPS → 耗时」择优。随包仍带一份
`vendor/xinghai.seed.js` 作兜底，GitHub 不可达时可以立即出声。

Safari 与 exe 的差别在于**能不能自己下载脚本**：

- GitHub 的 `api.github.com`、`codeload`、`raw.githubusercontent.com` 在 Safari 里可能被网络环境重置；
  已内置镜像优先下载（`ghproxy.net` / `gh-proxy.org`）+ Contents API 兜底，多数网络可用。
- 下载失败时自动退回内置预设 + 种子脚本，面板会写明原因，不影响播放。
- 想稳定自动更新：填一个 **HTTPS 中转地址**（自建；`windows/electron/net.cjs` 里的代理实现可以直接
  部署到 HTTPS 域名复用）；或重跑 `node tools/fetch_xinghai.mjs` 刷新内置种子后重新部署。
- HTTP 中转会被 Safari 按混合内容拦截；本机 `http://` 预览时可留空，会尝试同源 `/api/net`。
- **Windows 桌面版不需要任何中转**，已内置同源 `app://orangemusic/api/net`，可完整自动发现与更新。

> 封面：iOS 页面是 `style-src 'self'`，HTML 里的行内 `style` 会被丢弃，占位色相由
> `paintDynamics()` 用 CSSOM 补。封面先走**网易云批量详情**（一次请求 40 首），
> 再按「picId 直换 ‖ iTunes」并行竞速、最后兜网易云/酷我搜歌，结果写 localStorage，二次打开零请求。
> 坏图会被 `bindImageFallback()` 换成确定性渐变占位，不留白框。
>
> 首页结构：每日推荐 Banner + 6 快捷入口 + 实时推荐（两行封面墙）+ 今日榜单（每条榜单一条封面轮播，
> 曲目来自 QQ / 网易云公开榜单）+ 推荐歌单 + 热门歌手（均多平台聚合、智能排序）。
> 榜单 / 歌单 / 歌手接口都不带 CORS 头，Safari 下需要填 HTTPS 中转才能拉到数据，否则只显示占位。

第三方音源版权与合规责任由使用者自行承担，仅供个人学习测试，详见根目录 README。
