/* 橙子音乐 PWA：网络优先 + 离线兜底。
   只缓存同源静态资源；云 SDK、授权音源、封面与用户自配置端点一律直连，不缓存、不改写。 */
const CACHE = 'orangemusic-v42'
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg', './release-notes.json',
  './logo.png', './icon-180.png', './icon-192.png', './icon-512.png',
  './ui/tokens.css', './ui/app.css', './ui/app.js', './ui/safe-area.js',
  './ui/theme-ios.css', './ui/theme-macos.css',
  './config/publicConfig.js', './config/sourceKeys.js',
  './protocol/model.js', './protocol/bridge.js',
  './core/cloud.js', './core/auth.js', './core/repo.js', './core/quality.js',
  './core/sources.js', './core/playlist-import.js', './core/recommend.js',
  './core/charts.js', './core/covers.js', './core/chart-tracks.js', './core/discover.js',
  './core/genre-pool.js', './core/official.js', './core/identity.js',
  './core/cover-clean.js', './core/lyrics.js', './core/stream-cache.js', './core/updater.js',
  './core/engine/client.js', './core/engine/index.js', './core/engine/OrangeKugou.js',
  './core/engine/OrangeMusicApi.js', './core/engine/OrangeBodian.js',
]

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE)
    await Promise.all(ASSETS.map((u) => c.add(u).catch(() => {})))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // /api/* 返回的是带签名的临时直链，缓存后网络一抖动就会命中过期地址（403 → 没声音）。
  // 健康检查同理。这两类请求必须直通网络，SW 完全不插手。
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return
  e.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const isNav = req.mode === 'navigate'
    // 导航请求给网络 3 秒：超时就先用缓存把界面拉起来，避免「点了图标/锁屏卡一直白屏」。
    const net = fetch(req).catch(() => null)
    try {
      const res = isNav
        ? await Promise.race([net, new Promise((r) => setTimeout(() => r(null), 3000))])
        : await net
      if (res && res.ok) {
        // 206 Partial Content 不能进 Cache API，put 会 reject；不接住会变成未处理的 Promise 异常。
        cache.put(req, res.clone()).catch(() => {})
        return res
      }
      // ★ 分享码过期 / 服务重启 / 网关报错时，服务端会回 403、502 这类页面。
      //   直接把它当应用返回，PWA 冷启动就会停在错误页（从锁屏、控制中心点回本应用时尤其明显）。
      //   这里一律回退到缓存里的应用外壳，保证「点一下就回到播放器」。
      const hit = await cache.match(req)
      if (hit) return hit
      if (isNav) {
        const shell = await cache.match('./index.html')
        if (shell) return shell
      }
      if (res) return res
      return Response.error()
    } catch {
      const hit = await cache.match(req)
      if (hit) return hit
      if (isNav) return (await cache.match('./index.html')) || Response.error()
      return Response.error()
    }
  })())
})
