// 品牌更名兼容必须在最前面执行：其它 core 模块在顶层就会读 localStorage。
import '../core/brand-migrate.js'

// 原生桥唯一协议。iOS(WKWebView) 与 Windows(WebView2) 实现同一组 method；
// 浏览器 / PWA / exe(Edge --app) 没有原生宿主时，自动回落到纯 Web 实现。
// 因此 shared/ 里的业务逻辑不需要区分平台。新增 method 必须双端同时实现。
const pending = new Map()
let seq = 0
const listeners = new Map()

const host = () =>
  window.webkit?.messageHandlers?.orangeMusic ??   // iOS
  window.chrome?.webview ??                       // Windows
  null

export const isNativeHost = () => !!host()

// 网络中转：浏览器受 CORS 限制时，优先用用户配置的 relay，其次用同源 /api/net（Windows exe 内置）。
// iOS 网页版若部署在 HTTPS 上，relay 必须也是 HTTPS（混合内容会被浏览器拦截）。
let netRelay = ''
try { netRelay = localStorage.getItem('orangemusic:relay') || '' } catch { /* 隐私模式 */ }
export const setNetRelay = (u) => {
  netRelay = String(u || '').trim()
  try { localStorage.setItem('orangemusic:relay', netRelay) } catch { /* noop */ }
}
export const getNetRelay = () => netRelay

// 官方 CDN 直连：这些域名不会提供 VIP 试听片段（试听片段只来自第三方中转），
// 因此经它们的链接即便时长被浏览器误读，也不可能是「试听片段」，放行以免误杀拉低播放率。
const TRUSTED_CDN = /(^|\.)(music\.126\.net|music\.163\.com|qqmusic\.qq\.com|stream\.qqmusic\.qq\.com|kuwo\.cn|kugou\.com|migu\.cn|music\.migu\.cn)$/i
const isTrustedCdn = (u) => { try { return TRUSTED_CDN.test(new URL(String(u)).hostname) } catch { return false } }

function withTimeout(ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, done: () => clearTimeout(t) }
}

// 音频直链解析：各平台的「取链接口」大多返回一个 302 跳 http CDN 的地址，
// 而应用页面是 secure 上下文（app:// 声明了 secure），http 重定向会被当混合内容拦掉，
// 表现就是「取链成功但放不出声」。这里跟随 302 拿到 CDN 真实地址并换成 https。
// Electron 走主进程内置 /api/net（无 CORS、能读 Location），网页版退回 fetch 自己跟随。
const resolveCache = new Map()
export async function resolveStreamUrl(url, timeout = 8000) {
  const src = String(url || '')
  if (!/^https?:\/\//i.test(src)) return { url: src, ok: false }
  const cached = resolveCache.get(src)
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached
  let out = { url: src.replace(/^http:/i, 'https:'), ok: null }
  const eps = []
  if (getNetRelay()) eps.push(getNetRelay())
  try { eps.push(new URL('/api/net', location.href).href) } catch { /* noop */ }
  for (const ep of eps) {
    const { signal, done } = withTimeout(timeout + 1500)
    try {
      const r = await fetch(ep, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: src, resolve: true, timeout }), signal,
      })
      if (!r.ok) continue
      const j = await r.json()
      if (j && j.url) { out = { url: j.url, ok: j.ok !== false, statusCode: j.statusCode || 0, type: j.type || '' }; break }
    } catch { /* 换下一个中转 */ }
    finally { done() }
  }
  if (out.ok === null) {
    // 网页版：直接 fetch 跟随（CDN 带 CORS 头时可用），读 response.url
    const { signal, done } = withTimeout(timeout)
    try {
      const r = await fetch(src, { method: 'GET', headers: { Range: 'bytes=0-1' }, signal, redirect: 'follow' })
      const final = String(r.url || src).replace(/^http:/i, 'https:')
      out = { url: final, ok: r.ok, statusCode: r.status, type: r.headers.get('content-type') || '' }
    } catch { /* 保留原地址：CDN 有时不允许预检，但 audio 标签仍能播 */ }
    finally { done() }
  }
  out.at = Date.now()
  resolveCache.set(src, out)
  if (resolveCache.size > 400) resolveCache.delete(resolveCache.keys().next().value)
  return out
}

function buildInit(options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const headers = { ...(options.headers || {}) }
  let body
  if (options.body != null) {
    if (typeof options.body === 'string') body = options.body
    else {
      body = JSON.stringify(options.body)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    }
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body }
}

async function readResp(r) {
  const buf = await r.arrayBuffer()
  const headers = {}
  r.headers.forEach((v, k) => { headers[k] = v })
  return { statusCode: r.status, headers, bodyRaw: new TextDecoder('utf-8').decode(buf) }
}

async function directRequest(url, init, ms) {
  const { signal, done } = withTimeout(ms)
  try { return await readResp(await fetch(url, { ...init, signal })) } finally { done() }
}

async function relayRequest(url, options, ms) {
  const eps = []
  if (getNetRelay()) eps.push(getNetRelay())
  try { eps.push(new URL('/api/net', location.href).href) } catch { /* noop */ }
  const errors = []
  for (const ep of eps) {
    const { signal, done } = withTimeout(ms)
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options, timeout: ms }), signal })
      if (!r.ok) { errors.push(`${ep} → ${r.status}`); continue }
      const j = await r.json()
      if (j && typeof j.statusCode === 'number') return { statusCode: j.statusCode, headers: j.headers || {}, bodyRaw: j.bodyRaw || '' }
      errors.push(`${ep} → 响应格式不符`)
    } catch (e) { errors.push(`${ep} → ${e.message}`) }
    finally { done() }
  }
  throw new Error(`网络中转不可用（${errors.join(' | ')}）。iOS 网页版请在「音源与音质」填写 HTTPS 中转地址`)
}

// 最后兜底：部分站点（例如音源脚本的静态 .js）只返回内容、不返回 CORS 头，
// 纯浏览器读取会被拦。仅在「直连失败 + 无可用中转 + GET」时走公共只读代理；
// 只暴露公开脚本地址，不携带任何用户数据。可在设置里填自己的中转地址绕过。
const PUBLIC_RAW_PROXIES = [
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
]

// 多个公共代理并行竞速，共享一个时间预算：任一条先返回即用，避免串行重试把启动拖到几十秒。
async function publicProxyRequest(url, ms) {
  const { signal, done } = withTimeout(Math.min(ms, 9000))
  const attempts = PUBLIC_RAW_PROXIES.map(async (build) => {
    const ep = build(url)
    const r = await fetch(ep, { signal })
    if (!r.ok) throw new Error(`${new URL(ep).host} HTTP ${r.status}`)
    const bodyRaw = await r.text()
    if (!bodyRaw) throw new Error(`${new URL(ep).host} 空响应`)
    return { statusCode: 200, headers: {}, bodyRaw }
  })
  try { return await Promise.any(attempts) }
  catch (e) { throw new Error(e?.errors?.[0]?.message || '公共代理均不可用') }
  finally { done() }
}

async function doRequest(url, options = {}) {
  const ms = Number(options.timeout) > 0 ? Number(options.timeout) : 12000
  // 内置音乐引擎（Windows exe 专属）：localapi:// 是伪 scheme，交给主进程 /api/net 拦截后
  // 直接调用内嵌的 api-enhanced 函数（零端口、零部署）。必须由宿主中转，不能直连。
  // 兼容 localapi:/xxx、localapi:///xxx 等所有斜杠形态（musicapi 拼接时可能被剥斜杠）。
  if (/^localapi:/i.test(String(url || ''))) {
    if (typeof location === 'undefined') throw new Error('内置引擎需要宿主环境')
    return relayRequest(url, { ...options, timeout: ms }, ms)
  }
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('仅支持 http/https 协议')
  const init = buildInit(options)
  // 页面跑在 app:// / file:// 时（Windows exe、原生壳），Origin 不是 http(s)，
  // 对没有 CORS 头的接口直连必然被拦。先走中转可以省掉一次注定失败的请求，
  // 榜单补齐、歌单聚合这类批量请求能少一半往返。中转不可用时再退回直连。
  const nonHttpOrigin = typeof location !== 'undefined' && !/^https?:$/.test(location.protocol)
  let relayErr = null
  if (nonHttpOrigin && !options.noRelay) {
    try { return await relayRequest(url, { ...options, timeout: ms }, ms) }
    catch (e) { relayErr = e }
  }
  let directResp = null, directErr = null
  try { directResp = await directRequest(url, init, Math.min(ms, 7000)) }
  catch (e) { directErr = e }
  if (directResp && directResp.statusCode < 400) return directResp
  if (!nonHttpOrigin) {
    try { return await relayRequest(url, { ...options, timeout: ms }, ms) }
    catch (e) { relayErr = e }
  }
  if (directResp) return directResp
  // noPublicProxy：纯浏览器的页面级请求（如插件索引页）没必要走公共代理，直接让调用方换方案。
  if (init.method === 'GET' && !host() && !options.noPublicProxy) {
    try { return await publicProxyRequest(url, ms) }
    catch (e2) { throw new Error(`${directErr?.message || '直连失败'}；${relayErr?.message || '中转失败'}；公共代理：${e2.message}`) }
  }
  throw new Error(`${directErr?.message || '直连失败'}；${relayErr?.message || '中转失败'}`)
}

export function call(method, params = {}, timeoutMs = 15000) {
  const target = host()
  if (!target) {
    const h = webHandlers[method]
    if (!h) return Promise.reject(new Error(`浏览器模式不支持 ${method}`))
    // 同步调用 handler：iOS Safari 的 <input type=file> 与 audio.play() 必须在用户手势栈内触发。
    try { return Promise.resolve(h(params)) } catch (e) { return Promise.reject(e) }
  }
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    target.postMessage(JSON.stringify({ id, method, params }))
  })
}

// 原生侧回传：OrangeMusicBridge.resolve(id, result, error)
window.OrangeMusicBridge = {
  resolve(id, result, error) {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer); pending.delete(id)
    error ? p.reject(new Error(error)) : p.resolve(result)
  },
  emit(event, payload) {
    (listeners.get(event) || []).forEach((fn) => fn(payload))
  },
}

const emit = (event, payload) => window.OrangeMusicBridge.emit(event, payload)

export const on = (event, fn) => {
  if (!listeners.has(event)) listeners.set(event, [])
  listeners.get(event).push(fn)
  return () => listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn))
}

// ---- 纯 Web 回退：浏览器 / PWA / exe 与原生壳行为对齐 ----
let audioBound = false
let queue = []
let audioPrepared = false
// 锁屏 / 控制中心歌词：只替换 MediaMetadata 的 album 字段，标题/歌手/封面保持不变。
// 锁屏 / 控制中心接管开关（默认开）。
// iOS 上「点锁屏卡会跳去别的应用」是系统按 App 身份决定打开目标，网页改不了；
// 关掉接管后系统不再为我们建 Now Playing 卡片，也就不会再乱跳（代价是锁屏没有控制键）。
const MS_KEY = 'orangemusic:mediaSession'
let mediaSessionOn = true
try { mediaSessionOn = localStorage.getItem(MS_KEY) !== '0' } catch { /* 隐私模式 */ }
const msOn = () => mediaSessionOn
let npBase = null        // 最近一次设置的基础元数据 { title, artist, album, artwork }
let npLyricShown = ''    // 当前已写入锁屏的歌词文本（含专辑原值），避免重复 set 造成闪烁
const audioEl = () => {
  let a = document.getElementById('previewAudio')
  if (!a) {
    a = document.createElement('audio')
    a.id = 'previewAudio'
    a.preload = 'auto'
    document.body.appendChild(a)
  }
  // 页面里本来就写着 <audio id="previewAudio">，上面「新建时补属性」的分支永远不会执行，
  // 于是 playsinline / preload=auto 一直没生效。这里对已存在的元素也强制补一次。
  if (!audioPrepared) {
    audioPrepared = true
    try {
      // iOS Safari：不写 playsinline 会被强制切到全屏原生播放器，甚至直接拒绝 play()。
      a.setAttribute('playsinline', '')
      a.setAttribute('webkit-playsinline', '')
      a.playsInline = true
      a.preload = 'auto'
      // 不要设 crossOrigin：部分 CDN 未给全量 CORS 头，设了反而会拒绝加载。
    } catch { /* ignore */ }
  }
  return a
}

// ── iOS Safari 音频解锁 ──────────────────────────────────────────────
// 现象：点歌 → 异步取链 2~4 秒 → 才调 audio.play()。iOS Safari 要求 play() 在
// 用户手势的同步栈内发起，异步取链早已让手势失效，于是 NotAllowedError。
// 解法：第一次真实触摸/点击时，同步地对同一个 <audio> 播一段极短的静音 WAV，
// 把媒体元素解锁，之后的异步 play() 才会被允许。
//
// ★ 2026-11-15 必现根因：CSP 的 media-src 是 'self' blob: file: https: http:，
//   **没有 data:**。旧版解锁用 data:audio/wav → 必被 CSP 拒绝 → 元素进 error；
//   player.play 又执行 removeAttribute('src') + a.load() 清掉用户激活 →
//   异步 play() 被 Safari 拒。表现正是「封面/歌词都正常，就是没声音」。
//   改成 blob: 同源 URL：CSP 原生放行、零网络请求、不受 Service Worker 影响。
// 解锁是否真正「开始出声」的就绪 Promise：只有当静音源真正触发 playing 事件，
// iOS 才会把这个 <audio> 标记为「已播放」并放开后续异步 play()；只发起 play()
// 但还没出声就被换源打断，等于没解锁 —— 这正是「首次点歌不响、切下一首再回来才响」的根因。
let silentReady = null
let silentUrl = ''
function silentAudioUrl() {
  if (silentUrl) return silentUrl
  const n = 800, rate = 8000, bytes = new Uint8Array(44 + n * 2)
  const v = new DataView(bytes.buffer)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, n * 2, true)
  // 采样数据全为 0，播出来本身就是静音；必须用 muted=false 才解锁「非静音播放」。
  try { silentUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })) }
  catch { silentUrl = '' }
  return silentUrl
}

// 播放链路诊断：设置页「音频诊断」直接读它，真机上一眼定位是授权 / 静音 / CDN / 解码哪一层。
const audioDiag = { unlock: 'never', lastSrc: '', lastError: '', lastAt: 0, mediaErrors: [] }
let audioUnlocked = false
function unlockAudio() {
  // 已就绪（静音已真正出声）→ 直接返回就绪 Promise，让上层 await 立即放行。
  if (audioUnlocked && silentReady) return silentReady || Promise.resolve(true)
  const a = audioEl()
  const silent = silentAudioUrl()
  if (!silent) { audioDiag.unlock = 'blob-unsupported'; return Promise.resolve(false) }
  const cur = a.getAttribute('src') || ''
  // 元素上已经挂着真实音频 → 必然已被用户激活过，直接置位。
  // 绝不能把 src 换成静音源，否则会打断当前曲目 / 误触发 error 重取链。
  if (cur && cur !== silent && !a.error) {
    audioUnlocked = true; audioDiag.unlock = 'already-active'
    if (!silentReady) silentReady = Promise.resolve(true)
    return silentReady
  }
  try {
    a.muted = false
    if (cur !== silent) a.src = silent
    const p = a.play()
    // 关键：建一个「静音真正开始播放」的就绪 Promise。上层 playTrack 会 await 它，
    // 确保 iOS 把元素标记为先播放过、才允许几秒后取链完成的真实 play()。
    if (!silentReady) {
      silentReady = new Promise((resolve) => {
        let done = false
        const fin = (v) => { if (done) return; done = true; a.removeEventListener('playing', onPlay); clearTimeout(tm) }
        const onPlay = () => { audioUnlocked = true; audioDiag.unlock = 'ok'; fin(true) }
        a.addEventListener('playing', onPlay, { once: true })
        // 兜底：1.2s 还没出声就判一次。若元素无 error 且已就绪/未暂停，视为解锁成功；
        // 否则本次解锁作废，等待下次用户手势再来（避免「第一次解锁失败就永久失效」）。
        const tm = setTimeout(() => {
          if (!a.error && (!a.paused || a.readyState >= 3)) {
            audioUnlocked = true; if (!audioDiag.unlock.startsWith('ok')) audioDiag.unlock = 'ok-timeout'
            fin(true)
          } else { audioDiag.unlock = 'pending-timeout'; silentReady = null; fin(false) }
        }, 1200)
      })
    }
    const ok = () => { audioUnlocked = true; audioDiag.unlock = 'ok' }
    const no = (err) => {
      // 换真链会中断这次静音播放（AbortError）：这属于「已被真实播放接管」，
      // 也算解锁成功，否则下次触摸又会重设 src 把正在播的歌掐掉。
      if (/AbortError|new load request|interrupted/i.test(String(err?.message || err))) {
        audioUnlocked = true; audioDiag.unlock = 'ok-superseded'
      } else { audioDiag.unlock = 'fail: ' + String(err?.message || err); silentReady = null }
    }
    // 失败不置位 → 下一次手势会再试，避免「第一次解锁失败就永久失效」
    if (p && typeof p.then === 'function') p.then(ok, no)
    else setTimeout(ok, 60)
    return silentReady
  } catch (e) { audioDiag.unlock = 'throw: ' + String(e?.message || e); return Promise.resolve(false) }
}
if (typeof document !== 'undefined') {
  const arm = () => {
    // touchstart 比 touchend 更早、更贴近手势起点；pointerdown 兜桌面 / 新版 Safari。
    document.addEventListener('touchstart', unlockAudio, { capture: true, passive: true })
    document.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true })
    document.addEventListener('click', unlockAudio, { capture: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm, { once: true })
  else arm()
}

// 手势失效后的「点一下就续播」：NotAllowedError 不等于死链。
// 下一次任意触摸时同步 a.play()（这次一定在手势栈内），成功即恢复播放，
// 不用重新点歌、不用等 9 秒超时、也不会被误判成死链自动跳下一首。
function armResumeOnNextTap(a) {
  if (typeof document === 'undefined' || armResumeOnNextTap.armed) return
  armResumeOnNextTap.armed = true
  let timer = 0
  const cleanup = () => {
    document.removeEventListener('touchstart', tap, true)
    document.removeEventListener('click', tap, true)
    armResumeOnNextTap.armed = false
    clearTimeout(timer)
  }
  const tap = () => {
    cleanup()
    if (!a.getAttribute('src')) return
    // 告诉播放键：这一帧是「续播」，别再 toggle 成暂停把刚起来的声音掐掉
    try { window.__omJustResumed = Date.now() } catch { /* ignore */ }
    try { const p = a.play(); if (p && p.catch) p.catch(() => {}) } catch { /* ignore */ }
  }
  document.addEventListener('touchstart', tap, { capture: true, passive: true })
  document.addEventListener('click', tap, { capture: true })
  timer = setTimeout(cleanup, 20000)
}

function bindAudio() {
  if (audioBound) return
  audioBound = true
  const a = audioEl()
  // 用 addEventListener，避免覆盖 app.js 的 ontimeupdate 赋值。
  a.addEventListener('timeupdate', () => emit('player.position', { positionMs: a.currentTime * 1000, durationMs: (a.duration || 0) * 1000 }))
  a.addEventListener('ended', () => emit('player.ended'))
  a.addEventListener('error', () => {
    audioDiag.mediaErrors.push({
      at: Date.now(), code: a.error?.code ?? null, msg: a.error?.message || '',
      src: String(a.currentSrc || a.src || '').slice(0, 180),
    })
    if (audioDiag.mediaErrors.length > 8) audioDiag.mediaErrors.shift()
  })
  // iOS 锁屏 / 切后台会把 <audio> 置回 paused，记录最后一次状态便于自检核对。
  a.addEventListener('pause', () => { audioDiag.lastPauseAt = Date.now() })
  a.addEventListener('playing', () => { audioDiag.lastPlayingAt = Date.now() })
  if ('mediaSession' in navigator) {
    const set = (handler, event) => { try { navigator.mediaSession.setActionHandler(handler, () => emit(event)) } catch { /* 平台不支持该 action */ } }
    set('play', 'media.play'); set('pause', 'media.pause')
    set('previoustrack', 'media.prev'); set('nexttrack', 'media.next')
    // 系统的定位 / 快进快退直接作用在 <audio> 上：以前 seekto 只 emit 了个没人监听的事件，
    // 等于空实现；卡片功能不完整的播放器在 iOS 上更容易被系统当成「别的应用」接管。
    const seekTo = (sec) => {
      const a = audioEl()
      if (!a || !isFinite(a.duration) || a.duration <= 0) return
      try { a.currentTime = Math.max(0, Math.min(a.duration, sec)) } catch { /* 元数据未就绪 */ }
    }
    try { navigator.mediaSession.setActionHandler('seekto', (d) => { if (d && typeof d.seekTime === 'number') seekTo(d.seekTime) }) } catch { /* ignore */ }
    // ★ 不要注册 seekbackward / seekforward：iOS 一旦看到这两个 action，
    //   锁屏 / 控制中心就会把「上一首 / 下一首」换成「快退 15 秒 / 快进 15 秒」。
    //   用户要的是「上一首 · 播放/暂停 · 下一首」这组三键，所以只保留 previoustrack / nexttrack。
    //   （进度条拖动仍可用，那由 seekto 提供。）
    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        try { audioEl().pause() } catch { /* ignore */ }
        navigator.mediaSession.playbackState = 'paused'   // 用 paused 保留会话归属，'none' 会把锁屏卡让给别的应用
        emit('media.pause')
      })
    } catch { /* 不支持 */ }
  }
}

// 从锁屏 / 控制中心回到前台时，把媒体会话重新挂上：
// iOS 在长时间后台后偶尔会丢掉「这个会话属于哪个 Web App」的关联，
// 表现就是「卡片还在、点回去没反应」。重新 set 一次 metadata + playbackState 能把它接回来。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    // 关掉「锁屏接管」时：切到后台就暂停。只要后台还有音频在响，iOS 就一定会建
    // Now Playing 卡片，而卡片的「点开谁」由系统按 App 身份决定（网页改不了，
    // 用户实测会跳到别的音乐 App）。干脆不让后台播放，系统就没有可接管的会话。
    if (!msOn()) {
      const a = audioEl()
      if (document.visibilityState === 'hidden') {
        if (a && !a.paused) { window.__omResumeOnVisible = true; try { a.pause() } catch { /* ignore */ } }
      } else if (window.__omResumeOnVisible) {
        window.__omResumeOnVisible = false
        if (a && a.paused) { try { a.play().catch(() => {}) } catch { /* ignore */ } }
      }
      return
    }
    if (document.visibilityState !== 'visible') return
    if (!('mediaSession' in navigator) || !npBase) return
    try {
      const a = audioEl()
      navigator.mediaSession.metadata = new MediaMetadata({
        title: npBase.title, artist: npBase.artist, album: npLyricShown || npBase.album || '',
        artwork: npBase.artwork || [],
      })
      navigator.mediaSession.playbackState = a && !a.paused && !a.ended ? 'playing' : 'paused'
    } catch { /* 平台无 MediaMetadata */ }
  })
}

function parseFileName(name) {
  const base = name.replace(/\.[^.]+$/, '')
  const parts = base.split(/\s+[-–—]\s+/)
  return parts.length > 1
    ? { title: parts.slice(1).join(' - '), artist: parts[0] }
    : { title: base, artist: '本地音频' }
}

let localFiles = []
function pickAudioFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true; input.accept = 'audio/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const done = (files) => {
      if (settled) return
      settled = true; input.remove(); resolve(files)
    }
    input.onchange = () => {
      const picked = [...(input.files || [])].map((f) => {
        const meta = parseFileName(f.name)
        const lossless = /\.(flac|wav|aiff|alac|ape)$/i.test(f.name)
        return { ...meta, album: '', path: URL.createObjectURL(f), lossless, name: f.name, size: f.size }
      })
      localFiles = [...picked, ...localFiles]
      done(localFiles)
    }
    // iOS Safari 在取消时只触发 oncancel；桌面浏览器用 focus 兜底。
    input.oncancel = () => done(localFiles)
    input.addEventListener('change', () => { if (!input.files?.length) done(localFiles) })
    input.click()
    setTimeout(() => done(localFiles), 120000) // 无手势/未选择时避免悬挂
  })
}

const isSecurePage = () => {
  try { return !!(window.isSecureContext || location.protocol === 'https:') } catch { return false }
}

// 等音频真正开始播放：'playing' 事件才算成功；'error' 立即判失败。
function waitStarting(a, ms = 7000) {
  return new Promise((resolve, reject) => {
    let done = false
    const cleanup = () => {
      clearTimeout(timer)
      a.removeEventListener('playing', onOk)
      a.removeEventListener('error', onErr)
    }
    const onOk = () => { if (done) return; done = true; cleanup(); resolve() }
    const onErr = () => {
      if (done) return
      done = true; cleanup()
      reject(new Error('链接不可用（' + (a.error?.code ?? '?') + '）'))
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true; cleanup()
      reject(new Error('加载超时（链接失效或网络太慢）'))
    }, ms)
    a.addEventListener('playing', onOk, { once: true })
    a.addEventListener('error', onErr, { once: true })
    // 已经缓冲好、正在播的情况下补一次判断
    if (!a.paused && a.readyState >= 3) onOk()
  })
}

// 等「真的开始出声」：true=成功；false=超时（可再给一次机会）。
// 授权类错误（NotAllowedError）与媒体 error 必须立刻上抛，不能被当成「慢」继续等。
async function playUntilPlaying(a, startedPromise, ms) {
  const started = startedPromise || (() => {
    try { return a.play() } catch (e) { return Promise.reject(e) }
  })()
  try {
    await Promise.race([
      Promise.all([started, waitStarting(a, ms)]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('__timeout__')), ms + 3500)),
    ])
    return true
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (/NotAllowed|授权|user gesture|interact/i.test(msg)) throw e
    if (a.error) throw new Error(`链接不可用（${a.error.code}）`)
    return false
  }
}

const webHandlers = {
  // 浏览器模式（iOS PWA）没有原生宿主，平台 HTTP 请求统一走同源 /api/proxy：
  // 由服务端带正确的 Referer 取回，绕开 CORS 与防盗链；返回结构与 net.request 对齐。
  'net.request': async ({ url, options = {} } = {}) => {
    // 内置引擎（core/engine/*）用 localapi:// 伪协议发请求。
    // Windows 由 Electron 主进程拦截；网页端改由同源 /api/local 承接，
    // 服务端跑同一份 local-api.cjs（api-enhanced + 波点/酷我），行为一致。
    if (/^localapi:/i.test(String(url))) {
      // 用字符串截取而不是正则：避免转义问题，也兼容 localapi:/x、localapi:///x 各种写法
      let raw = String(url).slice('localapi:'.length)
      while (raw.startsWith('/')) raw = raw.slice(1)
      const sub = raw ? '/' + raw : '/'
      const r = await fetch('/api/local' + sub, {
        signal: AbortSignal.timeout(Number(options?.timeout) || 20000),
      })
      const j = await r.json().catch(() => null)
      const bodyRaw = String((j && j.bodyRaw) || '')
      return {
        status: (j && j.statusCode) || 200, statusCode: (j && j.statusCode) || 200, ok: true,
        bodyRaw, bodyText: bodyRaw, headers: (j && j.headers) || {},
      }
    }
    const q = new URLSearchParams({ url })
    const ref = options?.headers?.Referer || options?.headers?.referer
    if (ref) q.set('referer', ref)
    const r = await fetch(`/api/proxy?${q.toString()}`, {
      signal: AbortSignal.timeout(Number(options?.timeout) || 15000),
    })
    const bodyRaw = await r.text()
    const headers = { 'content-type': r.headers.get('content-type') || '' }
    // 引擎（core/engine/*）读的是 statusCode / bodyText，这里必须同时给出，
    // 否则解出来的都是 undefined → 引擎判定「不可用」，整条多源链路形同关闭。
    return { status: r.status, statusCode: r.status, ok: r.ok, bodyRaw, bodyText: bodyRaw, headers }
  },
  'player.play': async ({ track, positionMs = 0 } = {}) => {
    bindAudio()
    const a = audioEl()
    let url = track?.playUrl || track?.streams?.[0]?.url
    if (!url) throw new Error('该曲目没有可播放的授权直链')
    // 应用页面是 secure 上下文（app:// 注册为 secure），http 媒体会被当混合内容拦掉，
    // 这里统一把 http 直链升级成 https（各家 CDN 都支持）。
    if (isSecurePage() && /^http:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:')
    audioDiag.lastSrc = url
    audioDiag.lastAt = Date.now()
    audioDiag.lastError = ''
    // iOS 的 <audio>.volume 是只读的（由物理音量键控制），真正能掐掉声音的是 muted。
    // 真机诊断截图确认：muted=true / volume=1 正是「有信息、有歌词、没声音」的直接原因。
    // 用户主动点歌即代表要出声 —— 无条件解除静音，并清掉主动静音标记。
    if (a.muted) a.muted = false
    try { window.__omUserMuted = false } catch { /* ignore */ }
    if (a.getAttribute('src') !== url) {
      // ★ 绝不能 removeAttribute('src') + a.load()：那会重置媒体元素并清掉 iOS 的
      //   用户激活，异步换源后 play() 必被 NotAllowedError 拒绝（旧版「有信息没声音」的根因）。
      //   直接改 src 即可，浏览器会自动重新选源，同时清掉旧的 error 状态。
      try { a.pause() } catch { /* ignore */ }
      a.src = url
      // 续播：必须等元数据就绪再设 currentTime。
      // 以前设完 src 立刻写 currentTime，此时 readyState=0，赋值会被直接忽略（抛错被吞掉），
      // 于是「上次听到 2:30，重新打开点播放」总是从头开始。
      if (positionMs > 0) {
        await Promise.race([
          new Promise((r) => a.addEventListener('loadedmetadata', r, { once: true })),
          new Promise((r) => setTimeout(r, 2500)),
        ])
        try { a.currentTime = positionMs / 1000 } catch { /* 元数据还没到：放弃精确定位 */ }
      }
    } else if (positionMs > 0) {
      try { a.currentTime = positionMs / 1000 } catch { /* ignore */ }
    }
    // 死链 / 慢 CDN 会让 play() 一直悬着 → 上层 await 卡住，看着就像软件假死。
    // 给单条链路 9 秒上限，超时就当这条不可用，交给音质降级链换下一条。
    let started
    try { started = a.play() } catch (e) { started = Promise.reject(e) }
    // iOS：手势过期导致的 NotAllowedError 不等于死链，原样再试一次；
    // 仍失败就交给上层停在当前曲并提示「再点一次播放」，绝不自动跳下一首。
    started = started.catch((err) => {
      audioDiag.lastError = String(err?.message || err)
      if (!/NotAllowed|user gesture|interact/i.test(String(err?.message || err))) throw err
      // 手势过期：立刻把「下一次点击」注册成一次同步续播，用户点一下就出声。
      armResumeOnNextTap(a)
      return a.play().catch((e2) => {
        armResumeOnNextTap(a)
        throw new Error('iOS 播放授权：需要再点一次播放键 (' + String(e2?.message || '') + ')')
      })
    })
    started.catch(() => { /* 由下面的 race 统一处理 */ })
    // 无损文件大、首包来得慢，但 3 秒还不响应基本就是链接有问题；
    // 其它档位给 4.5 秒。分档可以让「无损取到了但放不出来」的歌少等 1.5 秒。
    // 慢网 / CDN 首包慢时 4.5s 会误判为死链（用户听到的就是「点了没声音」）。
    // 放宽到 8s：真死链由 error 事件立即判死，不会被拖慢。
    const waitMs = 8000
    // 超时 ≠ 死链：波点 / 酷我这批 CDN 首包经常要 8~15 秒。
    // 以前一到点就 pause + 抛「暂时无法播放」，用户再点一次（数据已缓冲）立刻就能播 ——
    // 这就是「首次点击说无法播放、二次点击又可以」的直接原因。现在没触发 error 就再给一次机会。
    const firstOk = await playUntilPlaying(a, started, waitMs)
    if (!firstOk) {
      const secondOk = a.error ? false : await playUntilPlaying(a, null, 4500)
      if (!secondOk) {
        try { a.pause() } catch { /* ignore */ }
        try { a.dataset.omKey = '' } catch { /* ignore */ }
        audioDiag.lastError = a.error ? `媒体错误 ${a.error.code}` : '加载超时'
        throw new Error(a.error ? `链接不可用（${a.error.code}）` : '加载超时（链接失效或网络太慢）')
      }
    }
    // ── 正式版最后一道闸：用音频「实际时长」反查串歌 / 试听片段 ──────────
    // 上游元数据可以标错歌名（点「玻璃糖」播成别人的同名翻唱），也可以把
    // 30 秒 VIP 试听当成完整曲目，但 CDN 上文件的真实时长骗不了人。
    // 元数据没有时长时只拦明显的片段；流式地址 duration=Infinity 时跳过校验。
    const realMs = Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0
    const wantMs = Number(track?.durationMs) || 0
    // 只拦「<60s 且原曲应是长曲」的试听片段 —— 这个判据精准、零误杀。
    // 不再用「元数据时长 vs 实际时长差 >45%」判串歌：不同平台 / 不同录音版本的时长
    // 本就可能差很多（实测把《骑士精神》《海盗》等正常原版误杀）。串歌防护已由上游
    // 三层权威校验覆盖：officialVerdict 版本标记 + lookupIdentity 官方详情反查 +
    // sameTrack 歌名歌手核对 + 缓存 ID 指纹，都比「时长近似」可靠。
    // 仅对「非官方 CDN 的第三方中转」拦截试听片段：官方 CDN 不会给试听片段，
    // 误杀会直接拉低播放成功率；第三方中转才常塞 30~45s 试听，该拦。
    if (realMs > 0 && realMs < 60000 && (!wantMs || wantMs > 120000) && !isTrustedCdn(url)) {
      try { a.pause() } catch { /* ignore */ }
      throw new Error('只有试听片段，不是完整版')
    }
    // 最后一道确认：等到了 playing，但元素其实又被暂停（宿主并发点播常见），
    // 这种情况不能报成功，否则就是「显示在播、实际没声音」。
    if (a.paused || a.ended) throw new Error('浏览器拒绝播放：元素未进入播放状态')
    // 记下「这条音频属于哪首歌」：切歌期间上层据此判断元素里是不是上一首的残响，
    // 从而立刻压住旧音频、并让进度条按 0 显示（修「封面是新歌、声音还是上一首」）。
    try { a.dataset.omKey = String(track?.key || '') } catch { /* ignore */ }
    if (msOn() && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    return { ok: true, durationMs: realMs }
  },
  'player.pause': () => {
    audioEl().pause()
    if (msOn() && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    return { ok: true }
  },
  'player.seek': ({ positionMs = 0 } = {}) => {
    const a = audioEl()
    try { a.currentTime = positionMs / 1000 } catch { /* noop */ }
    return { ok: true }
  },
  'player.setQueue': ({ tracks = [] } = {}) => { queue = tracks; return { ok: true, size: queue.length } },
  'media.setMetadata': async ({ track } = {}) => {
    if (!('mediaSession' in navigator) || !track) return { ok: false }
    const remote = track.cover ? String(track.cover).replace(/^http:\/\//i, 'https://') : ''
    let src = remote
    let type = 'image/jpeg'
    // Electron：封面跨域取不到，交给主进程取回原始字节并转成 512×512 JPEG 的 dataURL。
    // 以前主进程返回 file:// 路径给 artwork —— Windows SMTC 会直接丢掉 file: 资源，
    // 于是「歌名/歌手有、封面一直空白」。Chromium 只接受 data: / blob: / https:。
    if (src && window.orangeWindow?.host === 'electron') {
      try {
        const r = await window.orangeWindow.smtcArt(src)
        if (r && r.ok && r.dataUrl) { src = r.dataUrl; type = r.type || 'image/jpeg' }
      } catch { /* 取图失败退回远程 https 地址 */ }
    }
    // 多档 sizes：Chromium 的 MediaImageManager 按目标尺寸挑图，只给一档偶尔会被判不符而丢弃。
    const artwork = src
      ? [96, 256, 512].map((n) => ({ src, sizes: `${n}x${n}`, type }))
      : []
    // 用户要求：锁屏 / 控制中心第一行显示「歌名 - 歌手」，第二行（原歌手那一行）显示当前歌词。
    // 所以 title 合并成「歌名 - 歌手」，artist 先留空，由 setNowPlayingLyric 实时填当前歌词行。
    const songTitle = String(track.title || '橙子音乐').trim()
    const artistName = String(track.artist || '').trim()
    const line1 = artistName ? `${songTitle} - ${artistName}` : songTitle
    try {
      // 关掉「锁屏接管」时不写 metadata：系统就不会为我们建 Now Playing 卡片，
      // 也就不会出现「点卡片跳去别的应用」。
      if (msOn() && 'mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: line1, artist: '', album: track.album || '', artwork,
        })
      }
    } catch { /* 部分浏览器无 MediaMetadata */ }
    npBase = { title: line1, artistName, album: track.album || '', artwork }
    npLyricShown = ''
    return { ok: true, hasArt: !!src }
  },
  'net.fetch': async ({ url } = {}) => {
    if (!url) throw new Error('缺少 URL')
    const r = await doRequest(url, { method: 'GET' })
    if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
    return r.bodyRaw
  },
  // 通用 HTTP（LX 音源 / 榜单端点）：直连优先，CORS 失败自动中转，返回 {statusCode, headers, bodyRaw}
  'net.request': ({ url, options = {} } = {}) => doRequest(url, options),
  'fs.pickAudio': () => pickAudioFiles(),
  'fs.readTrack': ({ path } = {}) => ({ path }),
  'device.id': () => {
    const ua = navigator.userAgent
    const platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios-web'
      : /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1 ? 'ipad-web'
      : 'windows-web'
    return platform
  },
}

// 统一方法清单（双端必须一一实现）
export const native = {
  // 纯本地同步调用（绝不走 postMessage）：必须在用户手势的同步栈内激活 <audio>。
  // 返回「静音真正开始播放」的就绪 Promise，让 playTrack 在取链前 await 它，
  // 确保 iOS 把元素标记为已播放、放行随后几秒才完成的真实异步 play()。
  unlockAudio: () => { try { return unlockAudio() } catch { return Promise.resolve(false) } },
  // 锁屏 / 控制中心歌词：把「当前歌词行」写进 Media Session 的 album 字段。
  // iOS 会在歌手下方显示这一行；过长时由系统自行截断 / 滚动。仅在文本变化时重设，避免闪烁。
  // 传空字符串则还原为歌曲自身专辑名。
  setNowPlayingLyric: (text) => {
    try {
      if (!msOn() || !('mediaSession' in navigator) || !npBase) return
      // 第二行（artist 位）显示当前歌词；第一行已是「歌名 - 歌手」，不再变。
      const lyric = String(text || '').trim()
      if (lyric === npLyricShown) return
      npLyricShown = lyric
      navigator.mediaSession.metadata = new MediaMetadata({
        title: npBase.title, artist: lyric, album: npBase.album || '', artwork: npBase.artwork || [],
      })
    } catch { /* 平台无 MediaMetadata */ }
  },
  // 锁屏 / 控制中心接管开关：关掉后不再向系统注册 Now Playing 卡片
  // （iOS 的「点卡片打开谁」由系统按 App 身份决定，网页改不了，只能选择不接管）。
  setMediaSession: (on) => {
    mediaSessionOn = !!on
    try { localStorage.setItem(MS_KEY, mediaSessionOn ? '1' : '0') } catch { /* 隐私模式 */ }
    try {
      if (!('mediaSession' in navigator)) return Promise.resolve({ ok: false, on: mediaSessionOn })
      if (!mediaSessionOn) {
        // 主动交还：清掉 metadata 让系统不用再显示我们的卡片
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
      } else if (npBase) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: npBase.title, artist: npLyricShown || '', album: npBase.album || '', artwork: npBase.artwork || [],
        })
        const a = audioEl()
        navigator.mediaSession.playbackState = a && !a.paused && !a.ended ? 'playing' : 'paused'
      }
    } catch { /* 平台无 MediaMetadata */ }
    return Promise.resolve({ ok: true, on: mediaSessionOn })
  },
  // 设置页「音频诊断」：把 <audio> 的真实状态与最近一次失败原因原样返回，
  // 真机上一次截图即可判定是授权 / 静音 / CDN / 解码哪一层出问题。
  audioDiag: () => {
    const a = audioEl()
    return Promise.resolve({
      unlock: audioDiag.unlock,
      lastSrc: audioDiag.lastSrc,
      lastError: audioDiag.lastError,
      lastAt: audioDiag.lastAt,
      lastPlayingAt: audioDiag.lastPlayingAt || 0,
      lastPauseAt: audioDiag.lastPauseAt || 0,
      mediaErrors: audioDiag.mediaErrors.slice(-4),
      paused: a.paused, muted: a.muted, volume: a.volume,
      readyState: a.readyState, networkState: a.networkState,
      errorCode: a.error?.code ?? null, errorMsg: a.error?.message || '',
      currentTime: Math.round(a.currentTime * 100) / 100,
      duration: Number.isFinite(a.duration) ? Math.round(a.duration) : 0,
      src: String(a.currentSrc || a.src || '').slice(0, 180),
      secure: isSecurePage(), standalone: !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches),
      ua: navigator.userAgent,
    })
  },
  play: (track, positionMs) => call('player.play', { track, positionMs }),
  pause: () => call('player.pause'),
  seek: (positionMs) => call('player.seek', { positionMs }),
  setQueue: (tracks, mode) => call('player.setQueue', { tracks, mode }),
  setMetadata: (track) => call('media.setMetadata', { track }),
  // 原生网络层无 CORS 限制，供授权音源 API / 歌单分享页使用
  fetchText: (url) => call('net.fetch', { url }),
  request: (url, options = {}) => call('net.request', { url, options }, 20000),
  pickAudioFiles: () => call('fs.pickAudio'),
  readLocalTrack: (path) => call('fs.readTrack', { path }),
  deviceId: () => call('device.id'),
  // 封面角标清洗专用：Electron 宿主走主进程取原始字节（返回 dataURL）；
  // 纯网页（iOS）没有宿主，返回 null，由 CSS 裁切兜底。
  fetchImage: async (url, timeout) => {
    try {
      const fn = typeof window !== 'undefined' && window.orangeWindow?.fetchImage
      if (!fn) return null
      const r = await fn(url, timeout)
      return r && r.ok ? r.dataUrl : null
    } catch { return null }
  },
}
