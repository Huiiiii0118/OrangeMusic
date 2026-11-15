// 同类型曲目池：把「榜单名 / 电台标签」翻译成曲风关键词，再向多个平台要同类型的歌。
//
// 为什么需要这一层：48 个榜单里只有 17 个能拿到真实榜单接口，其它（Billboard / Oricon /
// Spotify / 酷狗 / 酷我 / 咪咕 / 抖音…）公开接口拿不到曲目，只能显示「仅目录」，点进去空白。
// 这里用「同类型 + 全网热度」把它们补齐：
//   1. 关键词：曲风优先（电音 / 说唱 / ACG / 古风 / 古典…），否则按地区（华语 / 欧美 / 日韩 / 全球）
//   2. 取数：网易云搜索 + QQ 音乐搜索并行（同一首歌合并，跨平台命中加权）
//   3. 热度：网易云 song/detail 批量取 popularity(0-100)，QQ 侧用搜索排名折算
//   4. 排序：热度 / 发行时间 / 涨幅三种口味，按榜单标签自动选
// 池子按关键词缓存 45 分钟，48 个榜单实际只会产生十来个池子，且并发请求会合并成一次。
import { native } from '../protocol/bridge.js'
import { makeTrack, normKey } from '../protocol/model.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const LS_KEY = 'orangemusic:pools:v1'
const TTL = 45 * 60 * 1000
const KEEP = 10                 // 本地最多留 10 个池，避免把 localStorage 撑爆
const enc = encodeURIComponent

const httpsify = (u) => String(u || '').replace(/^http:/i, 'https:')
const picSize = (u, n = 300) => httpsify(u).replace(/(\?param=)\d+y\d+/, `$1${n}y${n}`)
const clean = (s = '') => String(s)
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

const singersOf = (artist) =>
  (Array.isArray(artist) ? artist : [artist]).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(' / ') || '未知艺人'

async function getJson(url, headers, timeout = 4500) {
  const r = await native.request(url, { method: 'GET', timeout, noPublicProxy: true, headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers } })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
  const t = String(r.bodyRaw || '').trim()
  if (!t) throw new Error('空响应')
  try { return JSON.parse(t) } catch { throw new Error('返回的不是 JSON') }
}

// ---- 关键词推导 ----
// 曲风词最准，其次地区；「新歌 / 飙升」不改关键词，只改排序口味（省一半请求）。
const GENRE_KW = Object.freeze({
  电音: '电音 EDM',
  ACG: 'ACG 二次元',
  古典: '古典 钢琴',
  说唱: '中文说唱',
  古风: '古风 国风',
  民谣: '民谣 独立',
  网络: '抖音 热歌',
})
const REGION_KW = Object.freeze({
  华语: '华语流行',
  欧美: '欧美流行',
  日本: '日语流行',
  韩国: '韩语流行',
  全球: '全球热门',
})

export function poolOf(chart) {
  if (!chart) return '华语流行'
  if (chart.keyword) return chart.keyword
  return GENRE_KW[chart.genre] || REGION_KW[chart.region] || '华语流行'
}

// 排序口味：新歌榜按发行时间，飙升榜热度+新鲜度加权，其余按热度。
export function tasteOf(chart) {
  const tags = chart?.tags || []
  const name = chart?.name || ''
  if (tags.includes('新歌') || tags.includes('首发') || /新歌|首发/.test(name)) return 'new'
  if (tags.includes('原创') || /原创/.test(name)) return 'new'
  if (tags.includes('飙升') || /飙升|涨幅/.test(name)) return 'rise'
  return 'hot'
}

// ---- 两个平台的搜索 ----
async function wySearch(keyword, size, offset = 0) {
  const j = await getJson(`https://music.163.com/api/search/get/web?s=${enc(keyword)}&type=1&limit=${size}&offset=${offset}`,
    { Referer: 'https://music.163.com/' })
  return (j?.result?.songs || []).map((s) => {
    const al = s.album || s.al || {}
    return {
      source: 'wy',
      id: String(s.id),
      title: clean(s.name) || '未知曲目',
      artist: singersOf(s.artists || s.ar),
      album: clean(al.name),
      cover: al.picUrl ? picSize(al.picUrl) : '',
      picId: al.picId ? String(al.picId) : '',
      durationMs: Number(s.duration || s.dt) || 0,
      pubTime: Number(al.publishTime) || 0,
      heat: 0,
    }
  }).filter((r) => r.id)
}

async function qqSearch(keyword, size, page = 1) {
  const j = await getJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=${page}&n=${size}&w=${enc(keyword)}&format=json`,
    { Referer: 'https://y.qq.com/' })
  return (j?.data?.song?.list || []).map((s) => ({
    source: 'tx',
    id: String(s.songmid || s.songid || ''),
    title: clean(s.songname) || '未知曲目',
    artist: (s.singer || []).map((x) => clean(x.name)).filter(Boolean).join(' / ') || '未知艺人',
    album: clean(s.albumname),
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
    picId: '',
    durationMs: (Number(s.interval) || 0) * 1000,
    pubTime: (Number(s.pubtime) || 0) * 1000,
    heat: 0,
  })).filter((r) => r.id)
}

// 网易云热度：song/detail 一次可带多个 id，返回 popularity（0-100），这是唯一公开的热度字段。
async function wyPopularity(ids) {
  const map = new Map()
  const list = ids.filter(Boolean)
  const parts = []
  for (let i = 0; i < list.length; i += 50) parts.push(list.slice(i, i + 50))
  // 分批「并行」而不是串行：deep 池最多 4 批，串行最坏要等 4×6s=24s，
  // 正是「正在聚合该歌手全部作品…」迟迟不结束的主因。
  const results = await Promise.all(parts.map((part) =>
    getJson(`https://music.163.com/api/song/detail?ids=${enc(JSON.stringify(part))}`,
      { Referer: 'https://music.163.com/' }, 3500).catch(() => null)
  ))
  for (const j of results) {
    for (const s of j?.songs || []) map.set(String(s.id), Number(s.popularity) || 0)
  }
  return map
}

// ---- 池子 ----
const mem = readLS()
let saveTimer
function readLS() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}
function saveLS() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const keys = Object.keys(mem).sort((a, b) => (mem[b]?.at || 0) - (mem[a]?.at || 0))
      for (const k of keys.slice(KEEP)) delete mem[k]
      localStorage.setItem(LS_KEY, JSON.stringify(mem))
    } catch { /* 隐私模式 / 配额不足：只留内存 */ }
  }, 500)
}

const inflight = new Map()

function toTrack(row, keyword) {
  const alts = row.alt ? [{ source: row.alt.source, id: row.alt.id, name: row.title, singer: row.artist, picId: row.alt.picId || '' }] : []
  return makeTrack({
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.durationMs,
    cover: row.cover,
    license: 'third-party',
    licenseUrl: 'auto-discovered',
    sourceId: `pool:${keyword}`,
    tags: row.platforms?.length > 1 ? ['多平台'] : [],
    streams: [],
    pending: {
      source: row.source, id: row.id, name: row.title, singer: row.artist,
      albumName: row.album || '', durationMs: row.durationMs || 0, picId: row.picId || '',
      alts,
    },
  })
}

const heatOf = (row, index, total, pop) => {
  // 热度 0-100 为主（网易云 popularity），QQ 没有热度时按搜索排名折算成 0-70 的保守值，
  // 再对「两个平台都搜到」的歌加 8 分——同一首歌多处上榜，本身就是热度信号。
  const base = pop != null ? pop : 0
  const rankScore = total > 1 ? (1 - index / total) * 70 : 30
  const heat = pop != null ? base : rankScore
  return Math.min(100, heat + (row.cross ? 8 : 0))
}

async function buildPool(keyword, size, deep = false) {
  // 网易云一页最多 100 条、QQ 搜索一页最多 60 条。普通池两路并行就够（约 130 首去重后）；
  // deep 池再各翻一页，稳稳凑到 200+ 首，用于「电台 100 首」和空榜单补齐。
  const wySize = Math.min(Math.max(size, 60), 100)
  const jobs = [
    wySearch(keyword, wySize).catch(() => []),
    qqSearch(keyword, 60).catch(() => []),
  ]
  if (deep) {
    jobs.push(wySearch(keyword, 100, 100).catch(() => []))
    jobs.push(qqSearch(keyword, 60, 2).catch(() => []))
  }
  const [wy1, qq1, wy2 = [], qq2 = []] = await Promise.all(jobs)
  const wy = [...wy1, ...wy2]
  const qq = [...qq1, ...qq2]
  const pop = wy.length ? await wyPopularity(wy.map((r) => r.id)) : new Map()

  const merged = new Map()
  const push = (row, index, total) => {
    const k = normKey(row.title, row.artist)
    if (!k || k === '|') return
    const p = row.source === 'wy' ? (pop.get(row.id) ?? null) : null
    const cur = merged.get(k)
    if (!cur) {
      merged.set(k, { ...row, platforms: [row.source], cross: false, _i: index, _n: total, _pop: p })
      return
    }
    // 同一首歌两个平台都有：保留封面色更全的一条，记下另一平台的 ID 作为取链后备
    cur.platforms.push(row.source)
    cur.cross = true
    if (row.source === 'wy' && p != null && (cur._pop == null || p > cur._pop)) cur._pop = p
    if (!cur.cover && row.cover) cur.cover = row.cover
    if (!cur.picId && row.picId) cur.picId = row.picId
    if (cur.source === row.source) return
    if (!cur.alt) cur.alt = { source: row.source, id: row.id, picId: row.picId }
    // 网易云 id 更适合取链（有公开通道），优先把它留在主字段
    if (row.source === 'wy' && cur.source !== 'wy') {
      const old = { source: cur.source, id: cur.id, picId: cur.picId }
      Object.assign(cur, { source: row.source, id: row.id, picId: row.picId || cur.picId, covalt: cur.cover })
      cur.alt = old
    }
  }
  wy.forEach((r, i) => push(r, i, wy.length))
  qq.forEach((r, i) => push(r, i, qq.length))

  const rows = [...merged.values()].map((r) => ({
    ...r,
    heat: heatOf(r, r._i || 0, r._n || 1, r._pop),
  }))
  rows.sort((a, b) => b.heat - a.heat || (b.pubTime || 0) - (a.pubTime || 0))
  return rows.map((r) => ({ ...toTrack(r, keyword), heat: r.heat, pubTime: r.pubTime || 0 }))
}

// 取一个池子（关键词级缓存 + 单飞去重）。deep 会多翻一页，保证 100 首够用。
export async function poolTracks(keyword, { size = 100, force = false, deep = false } = {}) {
  const kw = String(keyword || '').trim() || '华语流行'
  const want = deep ? Math.max(size, 160) : size
  const hit = mem[kw]
  const fresh = hit?.rows?.length && Date.now() - (hit.at || 0) < TTL
  // 缓存够用就立即返回：以前 deep 强制凑满 160 首才复用，导致每次进歌手页都重跑
  // 4 路搜索 + 热度请求（最坏 20s+）。60 首已够两屏，是「聚合时间过长」的另一半原因。
  const enough = fresh && hit.rows.length >= (deep ? 60 : Math.min(size, 60))
  if (!force && enough) return rehydrate(hit.rows)
  const fk = deep ? `${kw}#deep` : kw
  if (inflight.has(fk)) return inflight.get(fk)
  const job = buildPool(kw, Math.min(Math.max(size, 60), 100), deep)
    .then((rows) => {
      if (rows.length) {
        // 只存可序列化的最小字段，避免把 makeTrack 的完整结构写进 localStorage
        mem[kw] = {
          at: Date.now(), deep: !!deep,
          rows: rows.map((t) => ({
            title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs,
            cover: t.cover, heat: t.heat, pubTime: t.pubTime, pending: t.pending,
          })),
        }
        saveLS()
      }
      return rows
    })
    .finally(() => inflight.delete(fk))
  inflight.set(fk, job)
  return job
}

// localStorage 里的行 → 完整 track（含 heat / pubTime，供排序用）
function rehydrate(rows) {
  return rows.map((r) => {
    const t = makeTrack({
      title: r.title, artist: r.artist, album: r.album, durationMs: r.durationMs,
      cover: r.cover, license: 'third-party', licenseUrl: 'auto-discovered',
      sourceId: 'pool:cache', streams: [], pending: r.pending,
    })
    return { ...t, heat: r.heat || 0, pubTime: r.pubTime || 0 }
  })
}

const hashOf = (s) => {
  let h = 0
  for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 9973
  return h
}

// 按榜单口味排序 + 按榜单 id 做稳定错位，避免同一池子的榜单长得一模一样。
function arrange(list, taste, seed) {
  const rows = list.slice()
  if (taste === 'new') {
    rows.sort((a, b) => (b.pubTime || 0) - (a.pubTime || 0) || b.heat - a.heat)
  } else if (taste === 'rise') {
    const now = Date.now()
    const fresh = (t) => {
      const days = t.pubTime ? (now - t.pubTime) / 86400000 : 400
      return Math.max(0, 1 - Math.min(days, 400) / 400)
    }
    rows.sort((a, b) => (b.heat * 0.6 + fresh(b) * 40) - (a.heat * 0.6 + fresh(a) * 40))
  } else {
    rows.sort((a, b) => b.heat - a.heat || (b.pubTime || 0) - (a.pubTime || 0))
  }
  if (rows.length > 12 && seed) {
    // 只在前几名内小幅轮转：榜单之间不会长得一模一样，也不会把冷门歌顶到第一位。
    const head = 4
    const off = hashOf(seed) % head
    if (off > 0) return [...rows.slice(off, head), ...rows.slice(0, off), ...rows.slice(head)]
  }
  return rows
}

// 榜单兜底曲目：没有真实接口的榜单用它补齐。
// full=true 时返回整个池子（卡片上就能显示真实总量），只 slice 交给调用方。
// deep 只在「打开整榜」时开，首页预热保持轻量（两路搜索，不多翻页）。
export async function chartFill(chart, { limit = 30, full = false, deep = false } = {}) {
  const kw = poolOf(chart)
  const rows = await poolTracks(kw, { size: Math.max(100, limit), deep }).catch(() => [])
  if (!rows.length) return []
  const arranged = arrange(rows, tasteOf(chart), chart.id)
  // 卡片只展示第一首。多个榜共用同一个曲风池时，给每个榜一个稳定的「冠军位」：
  // 只在热度前 8 名里错位，既保证还是热歌，又不会一屏出现五六张相同的封面。
  const span = Math.min(8, Math.max(1, Math.floor(arranged.length / 3)))
  const off = span > 1 ? hashOf(String(chart.id || '')) % span : 0
  const rotated = off
    ? [...arranged.slice(off, span), ...arranged.slice(0, off), ...arranged.slice(span)]
    : arranged
  return full ? rotated : rotated.slice(0, limit)
}

// 电台曲目：电台就是「一个有明确口味的池子」，固定 100 首，用深度池保证够数。
// 封面预热只要十几首，传 deep:false 避免为了 6 张封面去翻第二页。
export async function stationTracks(station, { limit = 100, deep = true, force = false } = {}) {
  const kw = station?.keyword || '华语流行'
  const rows = await poolTracks(kw, { size: Math.max(100, limit), deep, force }).catch(() => [])
  if (!rows.length) return []
  return arrange(rows, station?.taste || 'hot', station?.id).slice(0, limit)
}

export const poolInfo = () => Object.entries(mem).map(([k, v]) => ({ keyword: k, at: v.at, count: v.rows?.length || 0 }))

// 同步读池子缓存（不联网）。用于电台/榜单首屏：有缓存就直接上真实封面，
// 没有就让界面显示「载入中」，绝不用别的榜单的封面冒充（会出现「要打开了才变」的错觉）。
export function peekPool(keyword, { maxAge = TTL } = {}) {
  const kw = String(keyword || '').trim() || '华语流行'
  const hit = mem[kw]
  if (!hit?.rows?.length) return []
  if (Date.now() - (hit.at || 0) > maxAge) return []
  return rehydrate(hit.rows)
}
