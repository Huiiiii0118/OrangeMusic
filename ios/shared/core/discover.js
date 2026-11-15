// 发现层：推荐歌单 / 热门歌手。
//
// 只用公开 JSON 接口（QQ 音乐 · 网易云音乐），拿真实数据后统一归一化 + 智能排序：
//   热度（播放量 / 作品数，取对数压缩）  40%
//   跨平台共识（同一歌手/歌单在多平台都上榜） 20%
//   口味匹配（与推荐标签、最近播放歌手重合） 25%
//   新鲜度与多样性（同平台、同标签不过度堆叠） 15%
// 排序用「贪心 + 主题去重」，避免一屏全是同一种调性。
import { native } from '../protocol/bridge.js'
import { filterOfficial } from './official.js'
import { PLAZA_CATEGORIES } from '../protocol/model.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const LS_KEY = 'orangemusic:discover:v1'
const TTL = 20 * 60 * 1000

const clean = (s = '') => String(s)
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
const httpsify = (u) => String(u || '').replace(/^http:/i, 'https:')
const picSize = (u, n = 300) => httpsify(u).replace(/(\?param=)\d+y\d+/, `$1${n}y${n}`)

async function getJson(url, referer, timeout = 6500) {
  const r = await native.request(url, {
    method: 'GET', timeout,
    headers: { Referer: referer, 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
  })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
  const t = String(r.bodyRaw || '').trim()
  if (!t) throw new Error('空响应')
  try { return JSON.parse(t) } catch { throw new Error('返回的不是 JSON') }
}

const normName = (s) => clean(s).toLowerCase().replace(/[\s\-_·.,'’"!！?？()（）[\]【】]/g, '')

// ---- 歌单 ----
// QQ 歌单广场（sortId=5 最热）。多取几个分类，保证调性不单一。
// 各分类并行请求 + 流式回填，所以数量不会拖慢首屏。
const QQ_CATS = [
  { id: 10000000, tag: '全部' },
  { id: 1, tag: '华语' },
  { id: 2, tag: '欧美' },
  { id: 5, tag: '粤语' },
  { id: 6, tag: '小语种' },
  { id: 7, tag: '流行' },
  { id: 8, tag: 'R&B' },
  { id: 11, tag: '民谣' },
  { id: 12, tag: '说唱' },
  { id: 14, tag: '电子' },
  { id: 15, tag: '轻音乐' },
  { id: 16, tag: '校园' },
  { id: 17, tag: '韩语' },
  { id: 18, tag: '乡村' },
  { id: 20, tag: '爵士' },
  { id: 21, tag: '爵士' },
  { id: 22, tag: 'R&B' },
  { id: 24, tag: '电子' },
  { id: 25, tag: '拉丁' },
]

// QQ 歌单广场的完整分类表（6 组 / 65 类：语种、流派、主题、心情、场景…）。
// 启动时拉一次并缓存，歌单广场的每个板块都用真实分类，不再写死 19 个。
const QQ_TAG_CONF = 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg'
  + '?format=json&inCharset=utf8&outCharset=utf-8&platform=yqq&hostUin=0&needNewCode=0'
let qqCatsCache = null
async function qqCategories() {
  if (qqCatsCache) return qqCatsCache
  try {
    const j = await getJson(QQ_TAG_CONF, 'https://y.qq.com/', 6000)
    const seen = new Set()
    const rows = []
    for (const g of j?.data?.categories || []) {
      for (const c of g.items || []) {
        const id = Number(c.categoryId)
        const tag = clean(c.categoryName)
        if (!id || !tag || seen.has(id)) continue
        seen.add(id)
        rows.push({ id, tag })
      }
    }
    qqCatsCache = rows.length >= 5 ? rows : QQ_CATS
  } catch { qqCatsCache = QQ_CATS }
  return qqCatsCache
}

const qqPlaylists = (cat, limit = 20) => async () => {
  const url = 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg'
    + `?categoryId=${cat.id}&sortId=5&sin=0&ein=${limit}&format=json`
    + '&inCharset=utf8&outCharset=utf-8&platform=yqq&hostUin=0&needNewCode=0'
  const j = await getJson(url, 'https://y.qq.com/')
  const list = j?.data?.list || []
  return list.map((p) => ({
    id: `tx:${p.dissid}`,
    source: 'tx',
    platform: 'QQ 音乐',
    pid: String(p.dissid),
    title: clean(p.dissname),
    cover: p.imgurl ? httpsify(p.imgurl).replace(/\/300(\?|$)/, '/300$1') : '',
    creator: clean(p.creator?.name || ''),
    playCount: Number(p.listennum) || 0,
    desc: clean(p.introduction || ''),
    tags: [cat.tag],
  })).filter((p) => p.title && p.pid)
}

const wyPlaylists = async (limit = 30) => {
  const j = await getJson(`https://music.163.com/api/personalized/playlist?limit=${limit}`, 'https://music.163.com/')
  const list = j?.result || []
  return list.map((p) => ({
    id: `wy:${p.id}`,
    source: 'wy',
    platform: '网易云音乐',
    pid: String(p.id),
    title: clean(p.name),
    cover: p.picUrl ? picSize(p.picUrl) : '',
    creator: clean(p.creator?.nickname || ''),
    playCount: Number(p.playCount) || 0,
    desc: clean(p.copywriter || ''),
    tags: [p.alg === 'alg_high_quality' ? '高品质' : '推荐'],
  })).filter((p) => p.title && p.pid)
}

// 网易云「分类歌单」：一个分类一次请求，能按「华语 / 流行 / 摇滚 / 电子 / 说唱 / 古风 / ACG …」
// 拿到各自的真实歌单，歌单广场的多品类板块就靠它铺开（不再只有「推荐」一种调性）。
const wyCatPlaylists = (cat, limit = 24, offset = 0) => async () => {
  const j = await getJson(
    `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(cat)}&type=hot&limit=${limit}&offset=${offset}`,
    'https://music.163.com/',
  )
  const list = j?.playlists || []
  return list.map((p) => ({
    id: `wy:${p.id}`,
    source: 'wy',
    platform: '网易云音乐',
    pid: String(p.id),
    title: clean(p.name),
    cover: p.coverImgUrl ? picSize(p.coverImgUrl) : '',
    creator: clean(p.creator?.nickname || ''),
    playCount: Number(p.playCount || p.subscribedCount) || 0,
    desc: clean(p.description || ''),
    tags: [cat],
  })).filter((p) => p.title && p.pid)
}

// 酷狗歌单广场（移动端公开页）：600 个热门歌单，带真实封面 / 播放量 / 曲目数。
const kgPlaylists = (page = 1, limit = 40) => async () => {
  const j = await getJson(`https://m.kugou.com/plist/index?json=true&page=${page}`, 'https://m.kugou.com/')
  const list = j?.plist?.list?.info || []
  return list.slice(0, limit).map((p) => ({
    id: `kg:${p.specialid}`,
    source: 'kg',
    platform: '酷狗音乐',
    pid: String(p.specialid),
    title: clean(p.specialname),
    cover: httpsify(String(p.imgurl || '').replace('{size}', '300')),
    creator: clean(p.username || ''),
    playCount: Number(p.playcount) || 0,
    count: Number(p.songcount) || 0,
    desc: clean(p.intro || ''),
    tags: String(p.tags || '').split(/[,，]/).map(clean).filter(Boolean),
  })).filter((p) => p.title && p.pid)
}

// 歌单详情曲目：用于「点一下就能播」，只取元数据。
// 网易云优先走 track/all（支持 limit，能一次拿到整单）；失败再回落 playlist/detail。
const wyRow = (s) => ({
  name: clean(s.name), singer: (s.artists || s.ar || []).map((a) => clean(a.name)).join(' / '),
  songmid: String(s.id), source: 'wy', album: clean((s.album || s.al || {}).name || ''),
  cover: (s.album || s.al || {}).picUrl ? picSize((s.album || s.al).picUrl) : '',
  picId: (s.album || s.al || {}).picId || '',
  durationMs: Number(s.duration || s.dt) || 0,
})

// limit=0（默认）→ 全量拉取，安全上限 2000；limit>0 时只取前 limit 首。
export async function playlistTracks(pl, limit = 0) {
  if (!pl?.pid) return []
  const cap = limit > 0 ? limit : 2000
  if (pl.source === 'kg') {
    // 酷狗歌单详情（移动端公开接口）：filename 是「歌手 - 歌名」，remark 是纯歌名
    const j = await getJson(
      `https://mobiles.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(pl.pid)}&page=1&pagesize=${Math.min(cap, 100)}`,
      'https://www.kugou.com/',
    )
    const list = j?.data?.info || []
    return filterOfficial(list.slice(0, cap).map((s) => {
      const fn = String(s.filename || '')
      const i = fn.indexOf(' - ')
      const artist = i >= 0 ? fn.slice(0, i) : ''
      const title = clean(s.remark || (i >= 0 ? fn.slice(i + 3) : fn))
      return {
        name: title, singer: clean(artist || '未知艺人'), songmid: String(s.hash || ''),
        source: 'kg', album: '', cover: '',
        durationMs: (Number(s.duration) || 0) * 1000,
      }
    }).filter((r) => r.name && r.songmid))
  }
  if (pl.source === 'tx') {
    const url = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
      + `?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(pl.pid)}&format=json`
      + '&g_tk=5381&platform=yqq&hostUin=0&needNewCode=0&inCharset=utf8&outCharset=utf-8'
    const j = await getJson(url, 'https://y.qq.com/')
    const songs = j?.cdlist?.[0]?.songlist || []
    return filterOfficial(songs.slice(0, cap).map((s) => ({
      name: clean(s.songname || s.name), singer: (s.singer || []).map((a) => clean(a.name)).join(' / '),
      songmid: String(s.songmid || s.songid || ''), source: 'tx', album: clean(s.albumname || ''),
      cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
      durationMs: (Number(s.interval) || 0) * 1000,
    })).filter((r) => r.name && r.songmid))
  }
  try {
    const songs = []
    for (let offset = 0; songs.length < cap; offset += 100) {
      const j = await getJson(`https://music.163.com/api/playlist/track/all?id=${encodeURIComponent(pl.pid)}&limit=100&offset=${offset}`, 'https://music.163.com/')
      const batch = j?.songs || []
      if (!batch.length) break
      songs.push(...batch)
      if (batch.length < 100) break
    }
    if (songs.length) return filterOfficial(songs.slice(0, cap).map(wyRow).filter((r) => r.name && r.songmid))
  } catch { /* 回落旧接口 */ }
  const j = await getJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(pl.pid)}`, 'https://music.163.com/')
  const songs = j?.result?.tracks || j?.playlist?.tracks || []
  return filterOfficial(songs.slice(0, cap).map(wyRow).filter((r) => r.name && r.songmid))
}

// 只取歌单真实曲目数（用于首页卡片角标 / 详情副标题），不拉整单曲目，省流量。
export async function playlistCount(pl) {
  if (!pl?.pid) return null
  try {
    if (pl.source === 'kg') {
      // 列表接口里已经带了 songcount，直接用它，避免为一个角标再发一次详情请求
      if (pl.count) return Number(pl.count) || null
      return null
    }
    if (pl.source === 'tx') {
      const url = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
        + `?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(pl.pid)}&format=json`
        + '&g_tk=5381&platform=yqq&hostUin=0&needNewCode=0&inCharset=utf8&outCharset=utf-8'
      const j = await getJson(url, 'https://y.qq.com/')
      const cd = j?.cdlist?.[0]
      return Number(cd?.total_song_num || cd?.songlist?.length || 0) || null
    }
    const j = await getJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(pl.pid)}`, 'https://music.163.com/')
    return Number(j?.playlist?.trackCount || j?.result?.trackCount || 0) || null
  } catch { return null }
}

// ---- 歌手 ----
// 网易云歌手列表按分类取（cat: 1000 全部 / 1001 华语男 / 1002 华语女 / 1003 华语组合 / 4001 欧美）
const WY_ARTIST_CATS = [1000, 1001, 1002, 1003]

const wyArtists = (cat, limit = 30) => async () => {
  const j = await getJson(`https://music.163.com/api/artist/list?cat=${cat}&limit=${limit}`, 'https://music.163.com/')
  const list = j?.artists || []
  return list.map((a) => ({
    id: `wy:${a.id}`,
    name: clean(a.name),
    source: 'wy',
    platform: '网易云音乐',
    cover: a.picUrl ? picSize(a.picUrl) : (a.img1v1Url ? picSize(a.img1v1Url) : ''),
    musicSize: Number(a.musicSize) || 0,
    albumSize: Number(a.albumSize) || 0,
    alias: (a.alias || []).map(clean).filter(Boolean),
  })).filter((a) => a.name)
}

// QQ 侧不提供可用的「歌手榜」接口，因此用榜单曲目反推：一张榜里越靠前、上榜次数越多，越热。
// 数据来自 chart-tracks.js 已经拉过并缓存的榜单，不额外发请求。
function artistsFromCharts(chartMap) {
  const acc = new Map()
  for (const [, tracks] of chartMap) {
    tracks.forEach((t, i) => {
      const name = clean(t.artist)
      if (!name || name === '未知艺人') return
      for (const one of name.split(/\s*\/\s*/)) {
        const k = normName(one)
        if (!k) continue
        const cur = acc.get(k) || { name: one, hits: 0, score: 0, cover: '', charts: 0 }
        cur.hits += 1
        cur.score += (tracks.length - i) / tracks.length
        cur.charts += 1
        cur.cover = cur.cover || t.cover || ''
        acc.set(k, cur)
      }
    })
  }
  return [...acc.values()].map((a) => ({
    id: `tx-chart:${normName(a.name)}`,
    name: a.name,
    source: 'tx',
    platform: 'QQ 音乐',
    cover: a.cover,
    musicSize: 0,
    albumSize: 0,
    chartScore: a.score,
    charts: a.charts,
    alias: [],
  }))
}

// ---- 智能排序 ----
const log10 = (n) => Math.log10(Math.max(0, Number(n) || 0) + 1)
const clamp01 = (x) => Math.max(0, Math.min(1, x))

// 需求口味：传入偏好标签/最近歌手，与候选做交集打分。
function tasteHits(item, taste) {
  if (!taste?.length) return 0
  const hay = `${item.title || item.name || ''} ${(item.tags || []).join(' ')} ${item.creator || ''} ${(item.alias || []).join(' ')}`.toLowerCase()
  let n = 0
  for (const t of taste) {
    const k = String(t || '').trim().toLowerCase()
    if (k && hay.includes(k)) n += 1
  }
  return clamp01(n / Math.min(taste.length, 4))
}

function scorePlaylists(list, taste) {
  // 热度归一：以本批最大播放量为基准，避免不同平台量纲差异
  const maxPlay = Math.max(1, ...list.map((p) => p.playCount))
  return list.map((p) => {
    const hot = clamp01(log10(p.playCount) / log10(maxPlay))
    const tagBoost = p.tags.some((t) => ['高品质', '推荐'].includes(t)) ? 0.05 : 0
    const s = hot * 0.55 + tasteHits(p, taste) * 0.3 + tagBoost + (p.cover ? 0.05 : 0)
    return { ...p, score: +s.toFixed(4), reason: hot > 0.75 ? `播放 ${fmtCount(p.playCount)}` : (tasteHits(p, taste) > 0 ? '符合你的口味' : '热门推荐') }
  })
}

function scoreArtists(list, taste, chartMap) {
  const maxMusic = Math.max(1, ...list.map((a) => a.musicSize))
  const maxChart = Math.max(1, ...list.map((a) => a.chartScore || 0))
  // 跨平台共识：同名歌手在网易云列表 + QQ 榜单都出现（合并阶段已标 cross，这里再兜一次重复名）
  const seen = new Set()
  for (const a of list) {
    const k = normName(a.name)
    if (seen.has(k)) a.cross = true
    seen.add(k)
  }
  return list.map((a) => {
    const music = clamp01(log10(a.musicSize) / log10(maxMusic))
    const chart = maxChart > 1 ? clamp01((a.chartScore || 0) / maxChart) : 0
    const hot = Math.max(music, chart)
    const cross = a.cross ? 0.12 : 0
    const tasteHit = tasteHits(a, taste) * 0.25
    const s = hot * 0.55 + cross + tasteHit + (a.cover ? 0.06 : 0)
    return {
      ...a,
      score: +s.toFixed(4),
      reason: cross ? '多平台热播' : (music > 0.6 ? `作品 ${a.musicSize} 首` : '榜单常客'),
      key: `artist:${normName(a.name)}`,
    }
  })
}

const fmtCount = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${Math.round(n / 1e4)} 万` : String(n))

// 贪心挑选：同平台、同 creator、同标签都要付出多样性代价，避免整屏同质。
function pickDiverse(list, n, { keyOf, groupOf }) {
  const out = []
  const used = new Set()
  const groups = new Map()
  const pool = list.slice()
  while (out.length < n && pool.length) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const it = pool[i]
      const k = keyOf(it)
      if (used.has(k)) continue
      const g = groupOf(it)
      const penalty = (groups.get(g) || 0) * 0.12
      const s = it.score - penalty
      if (s > bestScore) { bestScore = s; best = i }
    }
    if (best < 0) break
    const [it] = pool.splice(best, 1)
    used.add(keyOf(it))
    groups.set(groupOf(it), (groups.get(groupOf(it)) || 0) + 1)
    out.push(it)
  }
  return out
}

// ---- 对外 ----
let memo = readMemo()
function readMemo() {
  try { const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
function writeMemo() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(memo)) } catch { /* 隐私模式 */ }
}

const settle = async (tasks) => {
  const r = await Promise.allSettled(tasks.map((t) => Promise.resolve().then(t)))
  return r.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))
}

// 分源缓存：某一平台偶发超时，不会再把整屏拖成空白——上次的结果先顶上。
const srcCache = () => (memo.src && typeof memo.src === 'object' ? memo.src : {})
const cachedBatch = (key) => {
  const e = srcCache()[key]
  return e && Date.now() - (e.at || 0) < TTL && e.items?.length ? e.items : null
}
const putBatch = (key, items) => {
  if (!items?.length) return
  const src = { ...srcCache(), [key]: { at: Date.now(), items: items.slice(0, 80) } }
  const keys = Object.keys(src).sort((a, b) => (src[b]?.at || 0) - (src[a]?.at || 0))
  for (const k of keys.slice(220)) delete src[k]
  memo.src = src
}

// 推荐歌单：QQ 多分类 + 网易云推荐，去重后按热度/口味/多样性排序。
// 各平台并行、谁先回来谁先渲染（onPartial），不再等所有请求跑完才出第一屏。
export async function recommendedPlaylists({ limit = 12, taste = [], force = false, refresh = false, chartMap = null, onPartial = null } = {}) {
  const hit = memo.playlists
  if (!force && hit?.at && Date.now() - hit.at < TTL && hit.items?.length) {
    const out = hit.items.slice(0, limit)
    onPartial?.(out)                       // 命中缓存也回一次，界面秒开
    if (!refresh) return out               // refresh：缓存照上屏，但继续后台取最新
  }
  const useCache = !force && !refresh

  const jobs = [
    { key: 'wy', run: () => wyPlaylists(40) },
    ...QQ_CATS.map((c) => ({ key: `tx:${c.id}`, run: () => qqPlaylists(c, 20)() })),
  ]
  const acc = new Map()
  for (const j of jobs) {
    const c = useCache ? cachedBatch(j.key) : null
    if (c) acc.set(j.key, c)
  }

  const assemble = () => {
    const seen = new Set()
    const seenId = new Set()
    const flat = []
    for (const items of acc.values()) {
      for (const p of items) {
        const k = normName(p.title)
        if (!k || seen.has(k)) continue
        // 同一个歌单可能从「个性化 / 分类 / 广场」多条通道回来，标题写法略有差异时
        // 标题去重留不住它，但 id 相同 —— 点击卡片按 id find 就只会命中数组里最靠前
        // 那一条，表现为「点右边的歌单却载入了左边的」。按 id 再兜一层去重。
        const pid = String(p.id || `${p.source || ''}:${p.pid || ''}`)
        if (pid && pid !== ':' && seenId.has(pid)) continue
        seen.add(k)
        if (pid && pid !== ':') seenId.add(pid)
        flat.push(p)
      }
    }
    const scored = scorePlaylists(flat, taste)
    scored.sort((a, b) => b.score - a.score)
    return pickDiverse(scored, Math.max(limit, 12), { keyOf: (p) => normName(p.title), groupOf: (p) => p.source })
  }

  if (acc.size) {
    const quick = assemble()
    if (quick.length) onPartial?.(quick.slice(0, limit))
  }

  await Promise.allSettled(jobs.map(async (j) => {
    let items = useCache ? cachedBatch(j.key) : null
    // 空数组也当没有缓存：上一次网络失败留下的空批不能被永久复用，否则池子再也长不大
    if (!items || !items.length) {
      items = await j.run().catch(() => [])
      if (items.length) putBatch(j.key, items)
    }
    acc.set(j.key, items || [])
    const top = assemble()
    if (top.length) onPartial?.(top.slice(0, limit))
  }))

  const picked = assemble()
  if (picked.length) {
    memo.playlists = { at: Date.now(), items: picked }
    writeMemo()
  }
  return picked.slice(0, limit)
}

// ── 歌单广场：多平台 + 多品类聚合 ──────────────────────────────────────────
// 数据源：QQ 歌单广场（多分类）· 网易云推荐 · 网易云分类歌单 · 酷狗歌单广场。
// 输出统一按「播放热度 + 口味 + 来源多样性」排序，并按封面去重，避免一屏全是同一张图。
const WY_PLAZA_CATS = [
  '华语', '流行', '摇滚', '民谣', '电子', '说唱', '古风', 'ACG', '轻音乐', '影视',
  '爵士', '乡村', '古典', 'R&B', '粤语', '韩语', '日语', '治愈', '校园', '夜晚',
]

export async function plazaPlaylists({ limit = 400, taste = [], force = false, refresh = false, onPartial = null } = {}) {
  const memoKey = 'plaza'
  const TTL_PLAZA = 10 * 60 * 1000   // 歌单广场要「实时」：10 分钟就重新聚合
  const hit = memo[memoKey]
  if (!force && hit?.at && Date.now() - hit.at < TTL_PLAZA && hit.items?.length) {
    const out = hit.items.slice(0, limit)
    onPartial?.(out)
    if (!refresh) return out
  }
  const useCache = !force && !refresh
  // QQ 全量分类（65 个板块）+ 网易云 20 类各翻两页 + 酷狗 10 页 + 网易云推荐。
  // 并发压到 10，避免一次打出 120 个请求把公开接口打限流。
  const qqCats = await qqCategories()
  const jobs = [
    { key: 'wy', run: () => wyPlaylists(50) },
    ...qqCats.map((c) => ({ key: `tx:${c.id}`, run: () => qqPlaylists(c, 30)() })),
    ...WY_PLAZA_CATS.flatMap((c) => [0, 30].map((off) => ({ key: `wyc:${c}:${off}`, run: () => wyCatPlaylists(c, 30, off)() }))),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ key: `kg:${n}`, run: () => kgPlaylists(n, 40)() })),
  ]
  const acc = new Map()
  for (const j of jobs) {
    const c = useCache ? cachedBatch(j.key) : null
    if (c?.length) acc.set(j.key, c)
  }
  // 同一张封面只保留一个（不同平台/不同标题但封面相同，本质是同一个歌单或同一套物料）
  const coverSig = (p) => String(p.cover || '').replace(/\?.*$/, '').replace(/\/\d+(\?|$)/, '/').toLowerCase()
  const assemble = () => {
    const seenTitle = new Set()
    const seenCover = new Set()
    const seenId = new Set()
    const flat = []
    for (const items of acc.values()) {
      for (const p of items) {
        const k = normName(p.title)
        if (!k || seenTitle.has(k)) continue
        const ck = coverSig(p)
        if (ck && seenCover.has(ck)) continue
        // 同 id 只留一条：保证卡片 data-pl 与数组 find 一一对应，杜绝点右载入左
        const pid = String(p.id || `${p.source || ''}:${p.pid || ''}`)
        if (pid && pid !== ':' && seenId.has(pid)) continue
        seenTitle.add(k)
        if (ck) seenCover.add(ck)
        if (pid && pid !== ':') seenId.add(pid)
        flat.push(p)
      }
    }
    const scored = scorePlaylists(flat, taste)
    scored.sort((a, b) => b.score - a.score)
    // 来源多样性：同一平台连出会被扣分，避免一屏只有 QQ 或只有网易云
    return pickDiverse(scored, Math.max(limit, 24), { keyOf: (p) => normName(p.title), groupOf: (p) => p.source })
  }
  const emit = () => {
    const top = assemble()
    if (top.length) onPartial?.(top.slice(0, limit))
  }
  if (acc.size) emit()
  let cursor = 0
  let lastEmit = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const j = jobs[cursor++]
      let items = useCache ? cachedBatch(j.key) : null
      if (!items || !items.length) {
        items = await j.run().catch(() => [])
        if (items.length) putBatch(j.key, items)
      }
      acc.set(j.key, items || [])
      const now = Date.now()
      if (now - lastEmit > 1500) { lastEmit = now; emit() }
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, jobs.length) }, worker))
  const picked = assemble()
  if (picked.length) {
    memo[memoKey] = { at: Date.now(), items: picked.slice(0, 800) }
    writeMemo()
  }
  return picked.slice(0, limit)
}

// 启动同步快照：上次打开软件拿到的歌单 / 歌手，过期也照样先上屏（stale-while-revalidate）。
// 后台刷新失败时界面不会因为「正在聚合…」变成空白。
export function cachedDiscover() {
  const playlists = Array.isArray(memo.playlists?.items) ? memo.playlists.items : []
  const artists = Array.isArray(memo.artists?.items) ? memo.artists.items : []
  const plaza = Array.isArray(memo.plaza?.items) ? memo.plaza.items : []
  return {
    playlists,
    artists,
    plaza,
    at: Math.max(Number(memo.playlists?.at) || 0, Number(memo.artists?.at) || 0, Number(memo.plaza?.at) || 0),
  }
}

// 热门歌手：网易云多分类 + QQ 榜单反推，同名合并后按「热度 / 跨平台 / 口味」排序。
// 默认只要 8 个（首页一行展示），所以取 8 就够时不再多算。
export async function hotArtists({ limit = 8, taste = [], force = false, refresh = false, chartMap = null, onPartial = null } = {}) {
  const hit = memo.artists
  if (!force && hit?.at && Date.now() - hit.at < TTL && hit.items?.length) {
    const out = hit.items.slice(0, limit)
    onPartial?.(out)
    if (!refresh) return out
  }
  const useCache = !force && !refresh

  const jobs = WY_ARTIST_CATS.map((c) => ({ key: `wy:${c}`, run: () => wyArtists(c, 30)() }))
  const acc = new Map()
  for (const j of jobs) {
    const c = useCache ? cachedBatch(j.key) : null
    if (c) acc.set(j.key, c)
  }
  const fromCharts = chartMap ? artistsFromCharts(chartMap) : []

  const assemble = () => {
    const merged = new Map()
    const push = (a) => {
      const k = normName(a.name)
      if (!k) return
      const cur = merged.get(k)
      if (!cur) { merged.set(k, { ...a }); return }
      cur.musicSize = Math.max(cur.musicSize || 0, a.musicSize || 0)
      cur.albumSize = Math.max(cur.albumSize || 0, a.albumSize || 0)
      cur.chartScore = (cur.chartScore || 0) + (a.chartScore || 0)
      cur.charts = (cur.charts || 0) + (a.charts || 0)
      cur.cover = cur.cover || a.cover
      cur.platform = ''
      if (a.source !== cur.source) cur.cross = true
    }
    for (const items of acc.values()) for (const a of items) push(a)
    for (const a of fromCharts) push(a)
    const scored = scoreArtists([...merged.values()], taste, chartMap)
    scored.sort((a, b) => b.score - a.score)
    return pickDiverse(scored, Math.max(limit, 8), {
      keyOf: (a) => normName(a.name),
      groupOf: (a) => (a.source === 'wy' ? 'wy' : 'tx'),
    })
  }

  if (acc.size) {
    const quick = assemble()
    if (quick.length) onPartial?.(quick.slice(0, limit))
  }

  await Promise.allSettled(jobs.map(async (j) => {
    let items = useCache ? cachedBatch(j.key) : null
    // 空数组也当没有缓存：上一次网络失败留下的空批不能被永久复用，否则池子再也长不大
    if (!items || !items.length) {
      items = await j.run().catch(() => [])
      if (items.length) putBatch(j.key, items)
    }
    acc.set(j.key, items || [])
    const top = assemble()
    if (top.length) onPartial?.(top.slice(0, limit))
  }))

  const picked = assemble()
  if (picked.length) {
    memo.artists = { at: Date.now(), items: picked }
    writeMemo()
  }
  return picked.slice(0, limit)
}

export const discoverState = () => ({
  playlists: memo.playlists?.at || 0,
  artists: memo.artists?.at || 0,
})

// ---- 歌手名录（乐馆「歌手」页用）----
// ★ 重做：性别来自「酷狗 sextype 分类 + 网易云 cat 分类」的归属，A-Z 一律用本地拼音首字母计算，
//   不再拿网易云 initial 与酷狗名单求交集（交集会把孙燕姿塞进 J、把女歌手混进男）。
//   名录一次拉全量并本地筛选，切换分类/字母不再重新请求，也不会出现「新增歌手看不到」。
export const ARTIST_LETTERS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))

// 汉字 → 拼音首字母：Intl 的 pinyin collator 本身就按拼音排序，用 23 个声母边界代表字做区间判断。
// 无第三方依赖、双端一致。拉丁字母/数字开头的艺名直接取首字符。
const PY_COLLATOR = new Intl.Collator('zh-CN-u-co-pinyin')
const PY_BOUNDS = Object.freeze([
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'], ['G', '噶'], ['H', '哈'],
  ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '期'],
  ['R', '然'], ['S', '撒'], ['T', '塌'], ['W', '挖'], ['X', '昔'], ['Y', '压'], ['Z', '匝'],
])
// 多音姓氏按艺人习惯读音修正
const PY_FIX = new Map([
  ['曾', 'Z'], ['单', 'S'], ['查', 'Z'], ['区', 'O'], ['仇', 'Q'], ['解', 'X'], ['朴', 'P'],
  ['缪', 'M'], ['翟', 'Z'], ['乐', 'L'], ['覃', 'Q'], ['任', 'R'], ['石', 'S'], ['华', 'H'],
])
export function pinyinInitial(name) {
  const ch = String(name || '').trim().charAt(0)
  if (!ch) return '#'
  if (/^[A-Za-z]$/.test(ch)) return ch.toUpperCase()
  if (/^[0-9]$/.test(ch)) return '#'
  if (PY_FIX.has(ch)) return PY_FIX.get(ch)
  let out = '#'
  for (const [L, bound] of PY_BOUNDS) {
    if (PY_COLLATOR.compare(ch, bound) < 0) break
    out = L
  }
  return out
}

// 内置补充名录：保证新生代/常见华语歌手一定在列表里，且性别是人工核对过的。
// 在线分类接口偶尔漏人（例如鞠婧祎），用户明确反馈「新加了很多歌手却看不到」。
const CURATED_ARTISTS = [
  ['鞠婧祎', 'female'], ['孙燕姿', 'female'], ['邓紫棋', 'female'], ['张韶涵', 'female'],
  ['梁静茹', 'female'], ['蔡依林', 'female'], ['王菲', 'female'], ['莫文蔚', 'female'],
  ['那英', 'female'], ['容祖儿', 'female'], ['杨千嬅', 'female'], ['韩红', 'female'],
  ['阿YueYue', 'female'], ['程响', 'female'], ['任然', 'female'], ['苏运莹', 'female'],
  ['田馥甄', 'female'], ['陈绮贞', 'female'], ['刘若英', 'female'], ['李宇春', 'female'],
  ['周笔畅', 'female'], ['张靓颖', 'female'], ['谭维维', 'female'], ['郁可唯', 'female'],
  ['黄龄', 'female'], ['单依纯', 'female'], ['希林娜依·高', 'female'], ['于文文', 'female'],
  ['戴佩妮', 'female'], ['许茹芸', 'female'], ['江美琪', 'female'], ['郭静', 'female'],
  ['丁当', 'female'], ['陈粒', 'female'], ['双笙', 'female'], ['银临', 'female'],
  ['周杰伦', 'male'], ['陈奕迅', 'male'], ['林俊杰', 'male'], ['薛之谦', 'male'],
  ['毛不易', 'male'], ['李荣浩', 'male'], ['刘德华', 'male'], ['郭顶', 'male'],
  ['许嵩', 'male'], ['赵雷', 'male'], ['汪苏泷', 'male'], ['孙楠', 'male'],
  ['陶喆', 'male'], ['伍佰', 'male'], ['萧敬腾', 'male'], ['张国荣', 'male'],
  ['齐秦', 'male'], ['潘玮柏', 'male'], ['罗大佑', 'male'], ['费玉清', 'male'],
  ['刀郎', 'male'], ['周深', 'male'], ['张杰', 'male'], ['华晨宇', 'male'],
  ['王力宏', 'male'], ['林宥嘉', 'male'], ['吴青峰', 'male'], ['李健', 'male'],
  ['朴树', 'male'], ['老狼', 'male'], ['郑钧', 'male'], ['崔健', 'male'],
  ['五月天', 'band'], ['苏打绿', 'band'], ['凤凰传奇', 'band'], ['TFBOYS', 'band'],
  ['时代少年团', 'band'], ['Beyond', 'band'], ['八三夭', 'band'], ['S.H.E', 'band'],
  ['动力火车', 'band'], ['羽泉', 'band'], ['好妹妹乐队', 'band'], ['房东的猫', 'band'],
  ['告五人', 'band'], ['草东没有派对', 'band'], ['万能青年旅店', 'band'], ['二手玫瑰', 'band'],
].map(([name, sex]) => ({
  id: `curated:${name}`, name, source: 'curated', platform: '', cover: '',
  heat: 9000, alias: [], sex, curated: true,
}))

const KG_UA = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96 Mobile Safari/537.36'
const SEX_TYPE = { all: 0, male: 1, female: 2, band: 3 }
const SEX_NAME = { 1: 'male', 2: 'female', 3: 'band' }
const WY_CAT_SEX = { 1001: 'male', 1002: 'female', 1003: 'band' }
const dirCache = new Map()
const DIR_TTL = 15 * 60 * 1000
const DIR_LS = 'orangemusic:artistdir:v1'
const DIR_LS_MAX_AGE = 7 * 24 * 60 * 60 * 1000
let allArtistsCache = null

// 全量名录落盘：清缓存 / 首次启动后不必再等 15 路网络请求；先同步读旧名单上屏，再后台刷新。
function readDirLS() {
  try {
    const j = JSON.parse(localStorage.getItem(DIR_LS) || 'null')
    if (Array.isArray(j?.rows) && j.rows.length && Date.now() - (Number(j.at) || 0) < DIR_LS_MAX_AGE) return j.rows
  } catch { /* 隐私模式 / 旧格式 */ }
  return null
}
function writeDirLS(rows) {
  try { localStorage.setItem(DIR_LS, JSON.stringify({ at: Date.now(), rows: rows.slice(0, 3000) })) } catch { /* 配额不足：只留内存 */ }
}
// 同步可用名单：内存 → 落盘 → 内置补充名录。任何情况下都能立刻给 UI 一批歌手，
// 杜绝「正在取歌手名单…」长时间空白。
export function peekArtistDirectory({ sex = 'all', initial = '' } = {}) {
  let rows = allArtistsCache?.rows
  if (!rows?.length) {
    rows = readDirLS()
    if (rows?.length) allArtistsCache = { at: 0, rows }
  }
  if (!rows?.length) rows = CURATED_ARTISTS
  const s = sex === 'all' ? '' : String(sex)
  const L = String(initial || '').toUpperCase()
  return rows.filter((a) => (!s || a.sex === s) && (!L || (a.initial || pinyinInitial(a.name)) === L))
    .map((a) => a.initial ? a : { ...a, initial: pinyinInitial(a.name) })
}

// 翻页改为并行：以前 3 个性别 × 3 页 + 网易云 3 类 × 2 页是串行等待，
// 网络稍慢就要 20~40s 才出名单（用户反馈「乐馆歌手名单获取过慢」）。
// 现在同一分类的几页同时发，最慢一页决定耗时。
async function kgSingers(sex = 0, pagesize = 300, pages = 3) {
  const one = async (page) => {
    const url = `https://mobiles.kugou.com/api/v5/singer/list?sextype=${sex}&type=0&page=${page}&pagesize=${pagesize}`
    try {
      const r = await native.request(url, {
        method: 'GET', timeout: 5000,
        headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/', Accept: 'application/json,text/plain,*/*' },
      })
      const raw = String(r?.bodyRaw || '').trim()
      if (!raw) return []
      return JSON.parse(raw)?.data?.info || []
    } catch { return [] }
  }
  const lists = await Promise.all(Array.from({ length: pages }, (_, i) => one(i + 1)))
  const seen = new Set()
  return lists.flat().filter((x) => {
    const k = String(x?.singerid || '')
    if (!k || seen.has(k)) return false
    seen.add(k); return true
  }).map((x) => ({
    id: `kg:${x.singerid}`,
    name: clean(x.singername),
    source: 'kg',
    platform: '酷狗音乐',
    cover: httpsify(String(x.imgurl || '').replace('{size}', '240')),
    heat: Number(x.score) || 0,
    alias: [],
    initial: '',
  })).filter((a) => a.name)
}

// 网易云「歌手分类」：1000 全部 / 1001 华语男 / 1002 华语女 / 1003 华语组合。
// 每类翻几页，和酷狗名单合并去重后，新生代歌手（如鞠婧祎）也能覆盖到。
const WY_ARTIST_SEX = { all: 1000, male: 1001, female: 1002, band: 1003 }
async function wyArtistsByCat(cat, limit = 200) {
  const cap = Math.min(Math.max(limit, 1), 400)
  const offsets = []
  for (let off = 0; off < cap; off += 100) offsets.push([off, Math.min(100, cap - off)])
  const pages = await Promise.all(offsets.map(async ([off, n]) => {
    try {
      const j = await getJson(`https://music.163.com/api/artist/list?cat=${cat}&limit=${n}&offset=${off}`, 'https://music.163.com/', 5000)
      return (j?.artists || []).filter((a) => a && a.name)
    } catch { return [] }
  }))
  const out = pages.flat()
  return out.map((a) => ({
    id: `wy:${a.id}`,
    name: clean(a.name),
    source: 'wy',
    platform: '网易云音乐',
    cover: a.picUrl ? picSize(a.picUrl) : (a.img1v1Url ? picSize(a.img1v1Url) : ''),
    heat: (Number(a.musicSize) || 0) + (Number(a.albumSize) || 0) * 2,
    alias: (a.alias || []).map(clean).filter(Boolean),
    initial: '',
  })).filter((a) => a.name)
}

// 网易云 artist/list 的 limit 硬上限是 100（给 120 直接返回 0 条），要更多只能翻 offset。
async function wyArtistsByInitial(letter, limit = 200) {
  const code = String(letter || 'A').toUpperCase().charCodeAt(0)
  const cap = Math.min(Math.max(limit, 1), 200)
  const list = []
  for (let off = 0; off < cap; off += 100) {
    const n = Math.min(100, cap - off)
    const j = await getJson(`https://music.163.com/api/artist/list?type=1&area=1&initial=${code}&limit=${n}&offset=${off}`, 'https://music.163.com/')
    const page = (j?.artists || []).filter((a) => a && a.name)
    list.push(...page)
    if (page.length < n) break
  }
  const seen = new Set()
  return list.filter((a) => {
    const k = `${a.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).map((a) => ({
    id: `wy:${a.id}`,
    name: clean(a.name),
    source: 'wy',
    platform: '网易云音乐',
    cover: a.picUrl ? picSize(a.picUrl) : (a.img1v1Url ? picSize(a.img1v1Url) : ''),
    heat: (Number(a.musicSize) || 0) + (Number(a.albumSize) || 0) * 2,
    alias: (a.alias || []).map(clean).filter(Boolean),
    initial: String(letter || '').toUpperCase(),
  })).filter((a) => a.name)
}

// 一次拉全量（酷狗男/女/组合各 3 页 + 网易云对应分类各 200），合并去重后本地缓存 15 分钟。
// 每个歌手都带 sex 与 initial，UI 切分类/字母只是本地 filter，不再重新联网，也不会串性别。
async function buildArtistDirectory() {
  if (allArtistsCache?.rows?.length && Date.now() - allArtistsCache.at < DIR_TTL) return allArtistsCache.rows
  // 有落盘旧名单时先置入内存（at=0 表示仍需后台刷新），保证期间任何读取都不空
  if (!allArtistsCache?.rows?.length) {
    const old = readDirLS()
    if (old?.length) allArtistsCache = { at: 0, rows: old }
  }
  const jobs = [
    ...[1, 2, 3].map((s) => ({ sex: SEX_NAME[s], run: () => kgSingers(s, 300, 3) })),
    ...[1001, 1002, 1003].map((c) => ({ sex: WY_CAT_SEX[c], run: () => wyArtistsByCat(c, 200) })),
  ]
  const groups = await Promise.all(jobs.map((j) => j.run()
    .catch((e) => { console.warn('[歌手名录] ' + e.message); return [] })
    .then((rows) => rows.map((a) => ({ ...a, sex: j.sex })))))
  const merged = new Map()
  const put = (a) => {
    const k = normName(a.name)
    if (!k) return
    const cur = merged.get(k)
    if (!cur) { merged.set(k, { ...a, initial: pinyinInitial(a.name) }); return }
    cur.heat = Math.max(cur.heat || 0, a.heat || 0)
    cur.cover = cur.cover || a.cover
    if (!cur.alias?.length && a.alias?.length) cur.alias = a.alias
    // 人工核对过的补充名单优先级最高，纠正上游错分的性别
    if (a.curated) { cur.sex = a.sex; cur.curated = true; cur.heat = Math.max(cur.heat || 0, 9000) }
  }
  // 先把落盘的旧名单并入：网络全失败时也不会把已有名录清空
  for (const a of (allArtistsCache?.rows || [])) put(a)
  for (const g of groups) for (const a of g) put(a)
  for (const a of CURATED_ARTISTS) put(a)
  const rows = [...merged.values()].sort((a, b) => (b.heat || 0) - (a.heat || 0)
    || String(a.name).localeCompare(String(b.name), 'zh-CN'))
  allArtistsCache = { at: Date.now(), rows }
  writeDirLS(rows)
  return rows
}

// sex: all | male | female | band；initial: '' 表示全部字母
// onPartial：先用「落盘 / 内置」名单回调一次，UI 立刻有内容，不必等全量网络请求结束。
export async function artistDirectory({ sex = 'all', initial = '', onPartial = null } = {}) {
  const key = `${sex}|${initial}`
  const hit = dirCache.get(key)
  if (hit && Date.now() - hit.at < DIR_TTL) return hit.rows
  const quick = peekArtistDirectory({ sex, initial })
  if (quick.length && onPartial) {
    try { onPartial(quick) } catch { /* UI 回调异常不影响取数 */ }
  }
  const all = await buildArtistDirectory()
  const s = sex === 'all' ? '' : String(sex)
  const L = String(initial || '').toUpperCase()
  const rows = all.filter((a) => (!s || a.sex === s) && (!L || a.initial === L))
  if (rows.length) dirCache.set(key, { at: Date.now(), rows })
  return rows
}
