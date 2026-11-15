/* 橙子音乐 PWA：网络优先 + 离线兜底。
   只缓存同源静态资源；云 SDK、授权音源、封面与用户自配置端点一律直连，不缓存、不改写。 */
const CACHE = 'orangemusic-v7'
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './logo.png', './icon-180.png', './icon-192.png', './icon-512.png',
  './ui/tokens.css', './ui/app.css', './ui/app.js',
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
  e.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const res = await fetch(req)
      if (res && res.ok) cache.put(req, res.clone())
      return res
    } catch {
      const hit = await cache.match(req)
      if (hit) return hit
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error()
      return Response.error()
    }
  })())
})
