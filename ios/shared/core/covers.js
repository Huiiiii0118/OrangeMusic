// 封面解析：搜索结果只带 picId，真实图片地址要再换一次。
//
// 慢的根因不是接口慢，而是**串行兜底**：一首歌最多 4 次往返，最坏 20 多秒。
// 现在改成「并行竞速 + 单飞去重 + 小图」：
//   第一档并行：picId 直换（网易云/酷我） ‖ iTunes（单请求、带 ACAO）
//   第二档并行（第一档 900ms 没出才启动）：网易云搜歌补 picId ‖ 酷我搜歌补 picId
// 谁先返回合法图片地址就用谁，其余结果回填缓存供下次用。
// 图片尺寸统一压到 200px（列表封面显示 ~124px，2x 屏足够），省一半流量、肉眼无差。
import { native } from '../protocol/bridge.js'

const GD = 'https://music-api.gdstudio.xyz/api.php'
const ITUNES = 'https://itunes.apple.com/search'
const LS_KEY = 'orangemusic:covers:v1'
const MAX_ENTRIES = 900
const MISS_TTL = 8000      // 失败后 8s 内不重复打，避免一次渲染里反复空转
const PIC_SIZE = 200       // 列表封面实际显示 ~124px，2x 屏 200 足够
const TIER2_DELAY = 900    // 第一档未出结果时，多久后启动第二档

let cache = readCache()
const missAt = new Map()
const inflight = new Map()   // key → Promise<url>：同一首歌并发请求只发一次

function readCache() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

let saveTimer
function writeCache() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const keys = Object.keys(cache)
      if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k]
      localStorage.setItem(LS_KEY, JSON.stringify(cache))
    } catch { /* 隐私模式：只留内存 */ }
  }, 300)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent

async function rawText(url, { timeout = 7000, headers } = {}) {
  const r = await native.request(url, { method: 'GET', timeout, headers, noPublicProxy: true })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode >= 400) {
    const e = new Error(`HTTP ${r.statusCode}`)
    e.status = r.statusCode
    throw e
  }
  return r.bodyRaw || ''
}

// 4xx 是「这条数据本来就没有」，重试没意义；5xx / 超时 / 被截断的 HTML 才重试。
const retryable = (e) => !e?.status || e.status >= 500 || e.status === 429

async function fetchJson(url, opt = {}, tries = 2) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return JSON.parse(await rawText(url, opt))
    } catch (e) {
      last = e
      if (!retryable(e) || i === tries - 1) break
      await sleep(140 + i * 260)
    }
  }
  throw last || new Error('请求失败')
}

const isImage = (u) => /^https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png|webp)(\?|$)/i.test(String(u || ''))
const httpsify = (u) => String(u).replace(/^http:/i, 'https:')
// 网易云 CDN 支持 ?param=WyH，直接换尺寸；其它 CDN 原样返回。
const shrink = (u) => httpsify(u).replace(/(\?param=)\d+y\d+/, `$1${PIC_SIZE}y${PIC_SIZE}`)

export const coverOf = (track) => track?.cover || (track?.key ? cache[track.key] || '' : '')

// 结果里的平台代号 → GD 接口使用的名词（GD 只给网易云/酷我提供图片与搜索）。
const GD_SOURCE = { wy: 'netease', kw: 'kuwo', tx: 'tencent', kg: 'kugou', mg: 'migu' }

async function picById(picId, source = 'netease') {
  if (!picId) return ''
  const j = await fetchJson(`${GD}?types=pic&source=${enc(source)}&id=${enc(picId)}&size=${PIC_SIZE}`, { timeout: 6500 }, 2)
  const u = j?.url || ''
  return isImage(u) ? shrink(u) : ''
}

async function picBySearch(source, title, artist) {
  const q = `${title || ''} ${artist || ''}`.trim()
  if (!q) return ''
  const j = await fetchJson(`${GD}?types=search&source=${enc(source)}&name=${enc(q)}&count=5&pages=1`, { timeout: 7000 }, 1)
  const rows = Array.isArray(j) ? j : []
  const t = norm(title)
  // 必须歌名对得上才用它的封面：名歌手按「歌名+歌手」搜，第一条常是同一张热门合辑，
  // 之前无条件取 count=1 的第一条，整页同名歌手的歌全是同一张封面。
  const hit = t ? rows.find((r) => {
    const n = norm(r?.name)
    return n && (n.includes(t) || t.includes(n))
  }) : null
  return hit?.pic_id ? picById(hit.pic_id, source) : ''
}

// iTunes（Apple Music）图形接口：带 ACAO:*，曲库对华语覆盖不错，作为 GD 抖动时的并行通路。
// artworkUrl100 里的尺寸段可以直接替换，不需要再请求一次。
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）[\]【】·.,'’"!！?？]/g, '')
async function picByItunes(title, artist) {
  const term = `${title || ''} ${artist || ''}`.trim()
  if (!term) return ''
  const j = await fetchJson(`${ITUNES}?term=${enc(term)}&entity=song&limit=5&country=cn`, { timeout: 6500 }, 1)
  const rows = (Array.isArray(j?.results) ? j.results : []).filter((r) => r?.artworkUrl100)
  if (!rows.length) return ''
  const t = norm(title)
  // 严禁「搜不到就取第一条」：名歌手的搜索第一条常是同一张最热专辑，整页封面会变成同一张。
  // 歌名对不上宁可不配（走其它通道 / 显示占位），也不给错封面。
  if (!t) return ''
  const hit = rows.find((r) => {
    const n = norm(r.trackName)
    return n && (n.includes(t) || t.includes(n))
  })
  if (!hit) return ''
  const u = String(hit.artworkUrl100).replace(/\/\d+x\d+bb\./, `/${PIC_SIZE}x${PIC_SIZE}bb.`)
  return isImage(u) ? httpsify(u) : ''
}

// 两档竞速：第一档慢于 TIER2_DELAY 还没结果，就把第二档也放出来一起跑；
// 第一档整档都空（比如没有 picId 又 iTunes 查无此歌）则立刻补第二档，不必等满 900ms。
// iOS 网页版：浏览器的 fetch 会被 CORS 拦，iTunes / GD 由同源服务端代查（/api/cover）。
const IS_IOS_PAGE = typeof document !== 'undefined' && document.documentElement?.dataset?.platform === 'ios'

async function picByServer(title, artist) {
  if (!title) return ''
  try {
    const r = await fetch(`/api/cover?title=${enc(title)}&artist=${enc(artist || '')}`, { signal: AbortSignal.timeout(9000) })
    const j = await r.json()
    return isImage(j?.url) ? httpsify(j.url) : ''
  } catch { return '' }
}

async function resolveOne(t) {
  const src = GD_SOURCE[t.pending?.source] || 'netease'
  const tier1 = []
  const tier2 = []
  if (IS_IOS_PAGE) tier1.push(() => picByServer(t.title, t.artist))
  if (t.pending?.picId && (src === 'netease' || src === 'kuwo')) tier1.push(() => picById(t.pending.picId, src))
  tier1.push(() => picByItunes(t.title, t.artist))
  tier2.push(() => picBySearch('netease', t.title, t.artist))
  tier2.push(() => picBySearch('kuwo', t.title, t.artist))

  return new Promise((resolve) => {
    let done = false
    let pending = 0
    let tier2Started = false
    let timer = null
    const finish = (u) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(u || '')
    }
    const launch = (fn) => {
      pending += 1
      fn().then((u) => { if (u && !done) finish(u) })
        .catch(() => {})
        .finally(() => {
          pending -= 1
          if (done || pending > 0) return
          if (!tier2Started) startTier2()
          else finish('')
        })
    }
    const startTier2 = () => {
      if (tier2Started || done) return
      tier2Started = true
      clearTimeout(timer)
      tier2.forEach(launch)
      if (pending === 0) finish('')
    }
    timer = setTimeout(startTier2, TIER2_DELAY)
    if (!tier1.length) startTier2()
    else tier1.forEach(launch)
  })
}

// 单飞去重：同一首歌被多处同时请求时只发一次网络请求。
function resolveKey(t) {
  if (inflight.has(t.key)) return inflight.get(t.key)
  const job = resolveOne(t)
    .then((url) => {
      if (url) { cache[t.key] = url; missAt.delete(t.key) } else missAt.set(t.key, Date.now())
      return url
    })
    .catch(() => { missAt.set(t.key, Date.now()); return '' })
    .finally(() => inflight.delete(t.key))
  inflight.set(t.key, job)
  return job
}

// 网易云「批量取详情」：一次请求拿 40 首的 album.picUrl，比逐首解析快一个数量级。
// 这是封面加载慢的主要解法——推荐/搜索里的网易云曲目全都命中这一条通路。
const WY_DETAIL = 'https://music.163.com/api/song/detail'
const WY_HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
}

async function fillByNeteaseBatch(tracks = []) {
  const out = new Map()
  const ids = []
  const byId = new Map()
  for (const t of tracks) {
    const p = t.pending
    if (p?.source !== 'wy') continue
    const id = String(p.id || '')
    if (!/^\d{4,}$/.test(id)) continue
    ids.push(id)
    byId.set(id, t.key)
  }
  if (!ids.length) return out
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40)
    try {
      const j = await fetchJson(`${WY_DETAIL}?ids=${enc(JSON.stringify(chunk))}`, { timeout: 7000, headers: WY_HEADERS }, 2)
      for (const s of j?.songs || []) {
        const pic = (s.album || s.al || {}).picUrl
        const key = byId.get(String(s.id))
        if (pic && key) out.set(key, shrink(pic))
      }
    } catch { /* 批量失败就退回逐首解析 */ }
  }
  return out
}

// 批量补封面：返回 Map<trackKey, coverUrl>。已带封面/已缓存的不会重复请求。
export async function fillCovers(tracks = [], { concurrency = 8, limit = 60, force = false } = {}) {
  const out = new Map()
  const todo = []
  const seen = new Set()
  const now = Date.now()
  for (const t of tracks) {
    if (!t?.key || seen.has(t.key)) continue
    seen.add(t.key)
    if (t.cover) { out.set(t.key, t.cover); continue }
    if (cache[t.key]) { out.set(t.key, cache[t.key]); continue }
    if ((missAt.get(t.key) || 0) > now - MISS_TTL) {
      if (!force) continue
      missAt.delete(t.key)
    }
    todo.push(t)
    if (todo.length >= limit) break
  }
  if (!todo.length) return out

  // 先走「一次请求拿一批」的快路，剩下的再逐首解析。
  const batch = await fillByNeteaseBatch(todo)
  for (const [k, v] of batch) {
    if (!v) continue
    cache[k] = v
    missAt.delete(k)
    out.set(k, v)
  }
  const rest = todo.filter((t) => !out.has(t.key))
  if (!rest.length) { writeCache(); return out }

  let i = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, rest.length) }, async () => {
    while (i < rest.length) {
      const t = rest[i++]
      try {
        const url = await resolveKey(t)
        if (url) out.set(t.key, url)
      } catch { /* 交给占位 */ }
    }
  }))
  writeCache()
  return out
}

// 后台预热：不 await，先把可见区之外的封面提前解析好，滚动时直接命中缓存。
export function prefetchCovers(tracks = [], limit = 30) {
  const todo = tracks.filter((t) => t?.key && !t.cover && !cache[t.key]).slice(0, limit)
  if (!todo.length) return
  const run = () => fillCovers(todo, { concurrency: 4 })
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 })
  else setTimeout(run, 1200)
}

// 稳定色相：没封面时按 key 生成确定性渐变，视觉上不会出现空白格子。
export function fallbackHue(key) {
  let h = 0
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
