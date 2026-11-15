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
const audioEl = () => {
  let a = document.getElementById('previewAudio')
  if (!a) { a = document.createElement('audio'); a.id = 'previewAudio'; document.body.appendChild(a) }
  return a
}

function bindAudio() {
  if (audioBound) return
  audioBound = true
  const a = audioEl()
  // 用 addEventListener，避免覆盖 app.js 的 ontimeupdate 赋值。
  a.addEventListener('timeupdate', () => emit('player.position', { positionMs: a.currentTime * 1000, durationMs: (a.duration || 0) * 1000 }))
  a.addEventListener('ended', () => emit('player.ended'))
  if ('mediaSession' in navigator) {
    const set = (handler, event) => { try { navigator.mediaSession.setActionHandler(handler, () => emit(event)) } catch { /* 平台不支持该 action */ } }
    set('play', 'media.play'); set('pause', 'media.pause')
    set('previoustrack', 'media.prev'); set('nexttrack', 'media.next')
    set('seekto', 'media.seek')
  }
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

const webHandlers = {
  'player.play': async ({ track, positionMs = 0 } = {}) => {
    bindAudio()
    const a = audioEl()
    let url = track?.playUrl || track?.streams?.[0]?.url
    if (!url) throw new Error('该曲目没有可播放的授权直链')
    // 应用页面是 secure 上下文（app:// 注册为 secure），http 媒体会被当混合内容拦掉，
    // 这里统一把 http 直链升级成 https（各家 CDN 都支持）。
    if (isSecurePage() && /^http:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:')
    if (a.src !== url) {
      // 换源前彻底清空一次：Chromium 在元素仍处于上一次加载状态时直接改 src，
      // 偶发「play() resolve 了、进度也在走，但就是没声音」。先 pause + removeAttribute + load
      // 把上一次的缓冲彻底丢掉，再挂新地址，可以消除这种状态残留。
      try { a.pause() } catch { /* ignore */ }
      try { a.removeAttribute('src') } catch { /* ignore */ }
      try { a.load() } catch { /* ignore */ }
      a.src = url
      try { a.load() } catch { /* ignore */ }
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
    const started = a.play()
    started.catch(() => { /* 由下面的 race 统一处理 */ })
    // 无损文件大、首包来得慢，但 3 秒还不响应基本就是链接有问题；
    // 其它档位给 4.5 秒。分档可以让「无损取到了但放不出来」的歌少等 1.5 秒。
    // 慢网 / CDN 首包慢时 4.5s 会误判为死链（用户听到的就是「点了没声音」）。
    // 放宽到 9s：真死链由 error 事件立即判死，不会被拖慢。
    const waitMs = track?.quality === 'lossless' ? 9000 : 9000
    try {
      // play() 只表示「开始加载」——死链通常先 resolve、随后才触发 error 事件，
      // 以前等着 play() 就直接当成功，结果界面显示在播、实际没声音、也不会换源。
      // 现在必须等真正的 playing 事件（或 error）才算这一条可用。
      // 单条链路起不来就判死并换下一条：以前给 7 秒，
      // 遇到死链/403 的歌要点下去干等 7 秒才换源（实测酷我部分曲目会这样）。
      await Promise.race([
        Promise.all([started, waitStarting(a, waitMs)]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时（链接失效或网络太慢）')), waitMs + 4000)),
      ])
    } catch (e) {
      // 超时不等于死链：不要 pause()，让后续的 canplay / 重试还能接上；
      // 真正的 error 才把元素停掉，交给下一条候选。
      // 任何失败都必须把元素停掉：以前「超时」分支故意不 pause，
      // 结果上一首继续出声、界面已经切到下一首 —— 用户听到的就是「播的还是上一首」。
      try { a.pause() } catch { /* ignore */ }
      throw new Error(`浏览器拒绝播放：${e.message}`)
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    return { ok: true, durationMs: realMs }
  },
  'player.pause': () => {
    audioEl().pause()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
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
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '橙子音乐', artist: track.artist || '',
        album: track.album || '', artwork,
      })
    } catch { /* 部分浏览器无 MediaMetadata */ }
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
