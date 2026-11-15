// 真实榜单曲目：QQ 音乐 / 网易云音乐公开榜单接口。
//
// 榜单目录（charts.js）只有元数据，首页「今日榜单」要把每个榜单自己的曲目封面轮播出来，
// 所以这里补一层「榜单元数据 → 真实曲目」。两条通道都是公开 JSON，且**封面可直接拼**：
//   QQ：albummid → https://y.gtimg.cn/music/photo_new/T002R300x300M000{albummid}.jpg
//   网易云：album.picUrl（补 ?param=300y300）
// 因此榜单封面不需要再走 covers.js 的解析链，首屏是「有 URL 就能直接发图片请求」。
//
// 接口都不带 CORS 头：exe（Electron 主进程代发）/ 原生宿主正常可用；
// 纯浏览器（iOS PWA）需要填写 HTTPS 中转，否则只是轮播占位，不影响其它板块。
import { native } from '../protocol/bridge.js'
import { makeTrack, normKey } from '../protocol/model.js'
import { filterOfficial } from './official.js'
import { chartFill } from './genre-pool.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// boardId → QQ 音乐 topId（取自官方榜单目录）
const QQ_TOP = Object.freeze({
  tx_hot: 26, tx_new: 27, tx_soar: 62, tx_cn: 5, tx_hkt: 59, tx_west: 3,
  tx_jp: 17, tx_kr: 16, tx_edm: 57, tx_acg: 72, tx_douyin: 60, tx_ktv: 36,
  tx_classic: 78,
})

// boardId → 网易云歌单 id
const WY_PL = Object.freeze({
  wy_hot: 3778678, wy_new: 3779629, wy_soar: 19723756, wy_original: 2884035,
})

const LS_KEY = 'orangemusic:charttracks:v1'
const TTL = 30 * 60 * 1000
const MAX = 300          // 每个榜单最多推荐 300 首（能取多少取多少）

export const realSourceOf = (chart) => {
  if (!chart) return null
  if (chart.source === 'tx' && QQ_TOP[chart.boardId]) return { kind: 'qq', id: QQ_TOP[chart.boardId] }
  if (chart.source === 'wy' && WY_PL[chart.boardId]) return { kind: 'wy', id: WY_PL[chart.boardId] }
  return null
}
export const hasRealTracks = (chart) => !!realSourceOf(chart)
// 没有真实榜单接口的（Billboard / Oricon / Spotify / 酷狗 / 酷我 / 咪咕 / 抖音…）
// 用「同类型曲目池 + 全网热度」补齐，所以每个榜单都能点进去听，不再有「仅目录」。
export const canFillTracks = () => true

const httpsify = (u) => String(u || '').replace(/^http:/i, 'https:')
const picSize = (u, n = 300) => httpsify(u).replace(/(\?param=)\d+y\d+/, `$1${n}y${n}`)

let store = readStore()
function readStore() {
  try { const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
let saveTimer
function saveStore() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      // 每条榜单最多 300 首，缓存只留最近 12 个榜，避免把 localStorage 塞满
      const keys = Object.keys(store)
        .sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
      for (const k of keys.slice(12)) delete store[k]
      localStorage.setItem(LS_KEY, JSON.stringify(store))
    } catch { /* 隐私模式 / 配额不足：只留内存 */ }
  }, 400)
}

const inflight = new Map()

async function getJson(url, referer, timeout = 9000) {
  const r = await native.request(url, {
    method: 'GET', timeout, noPublicProxy: true,
    headers: { Referer: referer, 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
  })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
  const t = String(r.bodyRaw || '').trim()
  if (!t) throw new Error('空响应')
  try { return JSON.parse(t) } catch { throw new Error('返回的不是 JSON') }
}

const singersOf = (artist) => {
  const list = Array.isArray(artist) ? artist : [artist]
  return list.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(' / ') || '未知艺人'
}

function toTrack(row, source) {
  const pending = {
    source,
    id: String(row.id || ''),
    name: row.title,
    singer: row.artist,
    albumName: row.album || '',
    durationMs: row.durationMs || 0,
    picId: row.picId || '',
  }
  return makeTrack({
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.durationMs,
    cover: row.cover || '',
    license: 'third-party',
    licenseUrl: 'https://zrcdy.dpdns.org/lx/vers.php',
    sourceId: `chart:${source}`,
    tags: [source === 'tx' ? 'QQ 音乐' : '网易云音乐'],
    streams: [],
    pending,
  })
}

async function fetchQq(topId, limit) {
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topId}`
    + '&format=json&inCharset=utf8&outCharset=utf-8&page=detail&type=top&platform=yqq&needNewCode=0'
  const j = await getJson(url, 'https://y.qq.com/')
  const list = (j?.songlist || []).map((x) => x?.data).filter(Boolean)
  return list.slice(0, limit).map((s) => toTrack({
    id: s.songmid || s.songid,
    title: s.songname || s.title || '未知曲目',
    artist: singersOf(s.singer),
    album: s.albumname || '',
    durationMs: (Number(s.interval) || 0) * 1000,
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
  }, 'tx'))
}

async function fetchWy(pid, limit) {
  // 新版 track/all 支持 limit/offset，可一次取到 300 首；失败再回落到 playlist/detail。
  try {
    const j = await getJson(`https://music.163.com/api/playlist/track/all?id=${pid}&limit=${limit}&offset=0`, 'https://music.163.com/', 12000)
    const list = j?.songs || j?.playlist?.tracks || []
    if (list.length) {
      return list.slice(0, limit).map((s) => toTrack({
        id: s.id,
        title: s.name || '未知曲目',
        artist: singersOf(s.artists || s.ar),
        album: (s.album || s.al || {}).name || '',
        durationMs: Number(s.duration || s.dt) || 0,
        picId: (s.album || s.al || {}).picId || '',
        cover: (s.album || s.al || {}).picUrl ? picSize((s.album || s.al).picUrl) : '',
      }, 'wy'))
    }
  } catch { /* 回落旧接口 */ }
  const j = await getJson(`https://music.163.com/api/playlist/detail?id=${pid}`, 'https://music.163.com/')
  const list = j?.result?.tracks || []
  return list.slice(0, limit).map((s) => toTrack({
    id: s.id,
    title: s.name || '未知曲目',
    artist: singersOf(s.artists || s.ar),
    album: (s.album || s.al || {}).name || '',
    durationMs: Number(s.duration || s.dt) || 0,
    picId: (s.album || s.al || {}).picId || '',
    cover: (s.album || s.al || {}).picUrl ? picSize((s.album || s.al).picUrl) : '',
  }, 'wy'))
}

// 单榜曲目（带 30 分钟本地缓存 + 单飞去重）。
// limit 上限 300：首页只要前 10 首，榜单详情页要整榜；缓存会记住「这个榜是否已经取完」，
// 所以先用小 limit 预热过也不会让后面的整榜请求只拿到 10 首。
export async function chartTracks(chart, { limit = 14, force = false, maxAge = TTL } = {}) {
  const real = realSourceOf(chart)
  const id = chart.id
  const want = Math.min(Math.max(1, limit), MAX)
  const hit = store[id]
  const enough = !!hit?.tracks?.length && (hit.tracks.length >= want || hit.full)
  if (enough && (force || Date.now() - (hit.at || 0) < maxAge)) return filterOfficial(hit.tracks).slice(0, want)
  if (inflight.has(id)) return filterOfficial(await inflight.get(id)).slice(0, want)

  const ask = Math.max(want, 20)
  const isPeakRise = /tx_hot|tx_soar|peak|rise/i.test(id)
  const job = Promise.resolve()
    .then(() => (real ? (real.kind === 'qq' ? fetchQq(real.id, ask) : fetchWy(real.id, ask)) : []))
    .catch(() => [])
    .then(async (tracks) => {
      if (tracks.length) return { tracks, kind: real.kind }
      // 峰/飙榜：单源失败 → 多平台聚合（QQ + 网易云 + 酷狗）
      if (isPeakRise) {
        try {
          const agg = await fetchAggregated(chart, Math.max(ask, 100))
          if (agg.length) return { tracks: agg, kind: 'aggregated' }
        } catch { /* 聚合失败继续回落 */ }
      }
      // 真实接口没曲目，或这个榜根本没有公开接口 → 同类型曲目 + 全网热度补齐。
      const fill = await chartFill(chart, { limit: Math.max(ask, 100), full: true, deep: ask >= 100 }).catch(() => [])
      return { tracks: fill, kind: 'fill' }
    })
    .then(({ tracks: rawTracks, kind }) => {
      // 榜单里也会混进伴奏 / Remix / Live 版，统一在进入界面前挡掉
      const tracks = filterOfficial(rawTracks)
      if (tracks.length) {
        store[id] = { at: Date.now(), tracks, full: tracks.length < ask || kind === 'fill', kind }
        saveStore()
      }
      return tracks
    })
    .finally(() => inflight.delete(id))
  inflight.set(id, job)
  try { return filterOfficial(await job).slice(0, want) } catch { return filterOfficial(hit?.tracks || []).slice(0, want) }
}

// 这个榜的曲目是真实榜单还是「同类型补齐」，用于详情页给一句说明。
export const chartKind = (id) => store[id]?.kind || ''
// 缓存里这个榜的全部曲目（预热时只要了前几首也拿得到整榜）
export const cachedTracks = (id) => filterOfficial(store[id]?.tracks || [])

// 首页多条榜单并发预热（限并发，避免一次打 6 个请求把首屏挤掉）。
// 没有真实接口的榜单走同类型补齐，池子按关键词复用，所以真正的网络请求远少于榜单数。
export async function warmCharts(charts = [], { limit = 14, concurrency = 3, maxAge = TTL, onEach = null } = {}) {
  const out = new Map()
  const queue = charts.filter((c) => canFillTracks(c))
  let i = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (i < queue.length) {
      const c = queue[i++]
      try {
        const tracks = await chartTracks(c, { limit, maxAge })
        const all = cachedTracks(c.id)
        const best = all.length > tracks.length ? all : tracks
        if (best.length) {
          out.set(c.id, best)
          onEach?.(c.id, best)
        }
      } catch { /* 单榜失败不影响其它 */ }
    }
  }))
  return out
}

// 首页/搜索共用的「榜单曲目 → 归一化 key」：用于判断当前列表里有没有同一首歌。
export const chartTrackKey = (t) => t?.key || normKey(t?.title, t?.artist)

// ─── 多平台聚合：巅峰榜 / 飙升榜 ────────────────────────────────────────────
// 用户反馈 QQ 榜单接口不稳定，重建为「QQ + 网易云 + 酷狗」三平台聚合，
// 按排名热度加权去重生成 Top100。巅峰榜=热度最高类；飙升榜=最新/涨幅类。

// 酷狗榜单 rankid
const KG_TOP = Object.freeze({
  kg_top500: 6666,    // TOP500（全网热歌）
  kg_soar: 189118,    // 飙升榜
  kg_cn_new: 23654,   // 华语新歌榜
})

async function fetchKg(rankId, limit) {
  const url = `https://mobilecdn.kugou.com/api/v3/rank/song?rankid=${rankId}&page=1&pagesize=${Math.min(limit, 100)}&plat=0`
  const j = await getJson(url, 'https://www.kugou.com/', 9000)
  const list = j?.data?.info || []
  return list.slice(0, limit).map((s) => {
    // filename 格式: "歌名 - 歌手"（可能有多个歌手用、分隔）
    const parts = String(s.filename || '').split(' - ')
    const title = (parts[0] || '未知曲目').trim()
    const artist = (parts[1] || '未知艺人').trim()
    return toTrack({
      id: s.hash || s.audio_id || String(s.rankid || '') + '_' + title,
      title,
      artist,
      album: s.remark || '',
      durationMs: (Number(s.duration) || 0) * 1000,
      cover: s.cover ? httpsify(s.cover) : (s.hash ? `https://trackercdn.kugou.com/i/v2/?cmd=23&pid=1&behavior=play&hash=${s.hash}` : ''),
    }, 'kg')
  }).filter((t) => t.title && t.title !== '未知曲目')
}

// 酷我榜单（简化版：直接用公开排行接口，不需要 token 的版本）
async function fetchKw(bangId, limit) {
  const url = `https://www.kuwo.cn/api/www/bang/bang/musicList?bangId=${bangId}&pn=1&rn=${Math.min(limit, 100)}&httpsStatus=1`
  const j = await getJson(url, 'http://www.kuwo.cn/', 9000)
  const list = j?.data?.musicList || j?.data?.list || []
  return list.slice(0, limit).map((s) => toTrack({
    id: String(s.rid || s.musicrid || ''),
    title: s.name || '未知曲目',
    artist: s.artist || '未知艺人',
    album: s.album || '',
    durationMs: (Number(s.duration) || 0) * 1000,
    cover: s.pic ? httpsify(s.pic) : '',
  }, 'kw')).filter((t) => t.title && t.title !== '未知曲目')
}

// 多源聚合：并行拉 QQ + 网易云 + 酷狗，按「出现平台数 × 权重 + 排名倒序」合并去重
// kind: 'peak' = 热度最高类（拉各平台热歌榜）; 'rise' = 最新飙升类（拉新歌/飙升榜）
export async function fetchAggregated(chart, limit = 100) {
  const want = Math.min(Math.max(10, limit), 200)
  const isRise = /soar|rise|飙升|新歌|首发/i.test(chart?.id + (chart?.tags || []).join())

  // 每个平台取哪几个榜（并行拉）
  const sources = []
  if (isRise) {
    sources.push(
      { fn: () => fetchQq(27, want), weight: 3 },   // QQ 新歌榜
      { fn: () => fetchQq(62, want), weight: 3 },   // QQ 飙升榜
      { fn: () => fetchWy(3779629, want), weight: 3 }, // 网易云新歌榜
      { fn: () => fetchWy(19723756, want), weight: 3 }, // 网易云飙升榜
      { fn: () => fetchKg(KG_TOP.kg_cn_new, want), weight: 2 },
      { fn: () => fetchKg(KG_TOP.kg_soar, want), weight: 2 },
    )
  } else {
    sources.push(
      { fn: () => fetchQq(26, want), weight: 4 },   // QQ 热歌榜（权重最高）
      { fn: () => fetchWy(3778678, want), weight: 4 }, // 网易云热歌榜
      { fn: () => fetchKg(KG_TOP.kg_top500, want), weight: 3 }, // 酷狗 TOP500
    )
  }

  // 并行拉取，单源失败不影响其他
  const results = await Promise.allSettled(sources.map((s) => s.fn()))
  const byKey = new Map() // normKey → { track, score, platforms:Set }
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value?.length) return
    const w = sources[i].weight
    r.value.forEach((t, rank) => {
      const k = normKey(t.title, t.artist)
      if (!k) return
      const rankScore = Math.max(0, 1 - rank / want) // 排名越靠前分越高
      const entry = byKey.get(k)
      if (entry) {
        entry.score += w * (0.6 + 0.4 * rankScore)
        entry.platforms.add(i)
      } else {
        byKey.set(k, { track: t, score: w * (0.6 + 0.4 * rankScore), platforms: new Set([i]) })
      }
    })
  })

  // 排序：综合得分（出现平台多 + 排名靠前）；同分按第一个源的排名
  const sorted = [...byKey.values()]
    .sort((a, b) => b.score - a.score || b.platforms.size - a.platforms.size)
    .map((e) => e.track)
    .slice(0, want)
  return sorted
}
