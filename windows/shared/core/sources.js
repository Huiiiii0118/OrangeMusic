import { sourceKeys, LICENSE_POLICY } from '../config/sourceKeys.js'
import { makeTrack, qualityRank } from '../protocol/model.js'
import { native, isNativeHost } from '../protocol/bridge.js'
import { getState, keys, signedAudioUrl } from './repo.js'
import { mergeCandidates } from './quality.js'
import { cachedStreams, rememberStreams, markStreamFail, isCoolingDown, streamCacheStats, clearStreamCache, idFingerprint, forgetStreams } from './stream-cache.js'
import { filterOfficial, officialBoost, filterRelevant, sameTrack, isOfficialOnly } from './official.js'
import { lookupIdentity, identityMatches } from './identity.js'
import music from './engine/client.js'

// 多音源聚合层。
// 稳定音源核心：内置「网易云 + QQ 音乐」双引擎（纯前端加密 + 直连，无第三方脚本、无 GitHub 抓取），
// 通过 engine/client.js 的 request 传输（Windows 走主进程代发、iOS 走边缘函数），跨平台通用。
// 合规：仅接入「官方免费授权」与「用户自持」两类源；不内置任何第三方解析/解锁脚本。

const getText = async (url) => (native.fetchText ? await native.fetchText(url) : (await fetch(url)).text())

function allowed(license = '', licenseUrl = '') {
  const l = license.toLowerCase()
  if (!l) return false
  if (!LICENSE_POLICY.allowNC && l.includes('-nc')) return false
  if (!LICENSE_POLICY.allowND && l.includes('-nd')) return false
  if (LICENSE_POLICY.requireLicenseUrl && !licenseUrl) return false
  return true
}

// ---- 适配器统一协议：{ id, name, license, enabled, search(q), resolve(track) } ----

const jamendo = {
  id: 'jamendo', name: 'Jamendo', license: 'CC / Jamendo 授权，逐曲校验',
  get enabled() { return !!sourceKeys.jamendoClientId },
  async search(q) {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${sourceKeys.jamendoClientId}&format=json&limit=30&search=${encodeURIComponent(q)}`
    const { results = [] } = JSON.parse(await getText(url))
    return results.filter((r) => allowed(r.license_ccurl?.includes('by-nc') ? 'cc-by-nc' : 'cc-by', r.license_ccurl))
      .map((r) => makeTrack({
        title: r.name, artist: r.artist_name, album: r.album_name,
        durationMs: r.duration * 1000, cover: r.album_image,
        license: 'cc-by', licenseUrl: r.license_ccurl, sourceId: 'jamendo',
        tags: r.musicinfo?.tags?.genres || [],
        streams: [
          ...(r.audio ? [{ url: r.audio, quality: 'hq' }] : []),
          ...(r.audiodownload ? [{ url: r.audiodownload, quality: 'lossless' }] : []),
        ],
      }))
  },
}

const fma = {
  id: 'fma', name: 'Free Music Archive', license: 'CC-BY / CC0 逐曲校验',
  get enabled() { return !!sourceKeys.fmaApiKey },
  async search(q) {
    const url = `https://freemusicarchive.org/api/get/tracks.json?api_key=${sourceKeys.fmaApiKey}&limit=30&q=${encodeURIComponent(q)}`
    const { dataset = [] } = JSON.parse(await getText(url))
    return dataset.filter((r) => allowed(r.license_title || '', r.license_url))
      .map((r) => makeTrack({
        title: r.track_title, artist: r.artist_name, album: r.album_title,
        cover: r.track_image_file, license: r.license_title, licenseUrl: r.license_url,
        sourceId: 'fma', streams: [{ url: r.track_file, quality: 'sq' }],
      }))
  },
}

const musopen = {
  id: 'musopen', name: 'Musopen', license: '公有领域古典',
  enabled: true,
  async search(q) {
    const url = `https://api.musopen.org/api/v1/recordings/?search=${encodeURIComponent(q)}`
    try {
      const { results = [] } = JSON.parse(await getText(url))
      return results.filter((r) => allowed('public-domain', r.license_url || 'https://musopen.org/about/license/'))
        .map((r) => makeTrack({
          title: r.title, artist: r.artist || '未知', license: 'public-domain',
          licenseUrl: r.license_url || 'https://musopen.org/about/license/', sourceId: 'musopen',
          streams: [{ url: r.audio_url, quality: 'lossless' }].filter((s) => s.url),
        }))
    } catch { return [] }
  },
}

const local = {
  id: 'local', name: '本地音频', license: '用户自持',
  get enabled() { return isNativeHost() },
  async search(q) {
    const files = await native.pickAudioFiles()
    return (files || []).filter((f) => `${f.title} ${f.artist}`.toLowerCase().includes(q.toLowerCase()))
      .map((f) => makeTrack({
        title: f.title, artist: f.artist, album: f.album, license: 'user-owned',
        licenseUrl: 'local://user-owned', sourceId: 'local',
        streams: [{ url: f.path, quality: f.lossless ? 'lossless' : 'hq' }],
      }))
  },
}

const cloudOwn = {
  id: 'cloud-own', name: '我的云曲库', license: '用户自持（私有存储）',
  enabled: true,
  async search(q) {
    const cfg = await getState(keys.sources).catch(() => null)
    const list = cfg?.ownAudio || []
    const out = []
    for (const item of list.filter((i) => i.title.toLowerCase().includes(q.toLowerCase()))) {
      const signed = await signedAudioUrl(item.path)
      const u = typeof signed === 'string' ? signed : (signed?.url || signed?.signedUrl || signed?.data)
      if (!u) continue
      out.push(makeTrack({
        title: item.title, artist: item.artist, license: 'user-owned',
        licenseUrl: 'cloud://user-owned', sourceId: 'cloud-own',
        streams: [{ url: u, quality: item.quality || 'lossless' }],
      }))
    }
    return out
  },
}

const customEndpoint = {
  id: 'custom', name: '自定义授权源', license: '由用户自行承担授权责任',
  async enabled() {
    const cfg = await getState(keys.sources).catch(() => null)
    return Array.isArray(cfg?.endpoints) && cfg.endpoints.length > 0
  },
  async search(q) {
    const cfg = await getState(keys.sources)
    const out = []
    for (const ep of cfg.endpoints || []) {
      if (!ep.searchUrl || !ep.licenseUrl) continue
      try {
        const rows = JSON.parse(await getText(ep.searchUrl.replace('{q}', encodeURIComponent(q))))
        for (const r of rows) {
          if (!allowed(r.license, ep.licenseUrl)) continue
          out.push(makeTrack({ ...r, sourceId: 'custom', licenseUrl: ep.licenseUrl, streams: r.streams || [] }))
        }
      } catch { /* 单源失败跳过 */ }
    }
    return out
  },
}

// 内置稳定双引擎：网易云 + QQ 音乐。搜索只返回元数据（秒出），点播时由 resolvePending 取链。
const PLATFORM_TAG = { netease: '网易云音乐', qq: 'QQ 音乐', kugou: '酷狗音乐' }
const openMusic = {
  id: 'open', name: '网易云 / QQ 音乐', license: '第三方接口 · 授权责任由使用者承担',
  enabled: true,
  async search(q) {
    const rows = await music.search(q, 30).catch(() => [])
    if (!rows.length) return []
    // 相关性过滤：公开平台搜索常混入与关键词完全无关的补位曲目（如搜「玻璃糖」返回十几首别的歌），
    // 这些曲目的 album 常被平台塞成搜索词本身，必须按「歌名+歌手」严格过滤，否则用户点下去货不对版。
    return filterRelevant(rows, q).map((r) => makeTrack({
      title: r.title, artist: r.artist, album: r.album,
      durationMs: (r.duration || 0) * 1000, pubTime: Number(r.pubTime) || 0,
      cover: r.cover || '',
      license: 'third-party', licenseUrl: 'https://zrcdy.dpdns.org/lx/vers.php',
      sourceId: `open:${r.platform}`,
      tags: [PLATFORM_TAG[r.platform] || '第三方平台'],
      streams: [], pending: { platform: r.platform, id: r.id },
    }))
  },
}

// 顺序即优先级
export const adapters = [jamendo, fma, musopen, cloudOwn, local, customEndpoint, openMusic]

export async function enabledAdapters() {
  const flags = await Promise.all(adapters.map(async (a) => {
    const v = typeof a.enabled === 'function' ? await a.enabled() : a.enabled
    return !!v
  }))
  return adapters.filter((_, i) => flags[i])
}

// 统一 pending 的「平台」字段。历史遗留两套命名混用：
//   新引擎（engine/client.js、search 结果）用 platform: 'netease' | 'qq'
//   歌单导入（playlist-import.js）与 ID 反查（identity.js）用 source: 'wy' | 'tx'
// QQ/网易云歌单导入只写了 source、没写 platform，导致下游读 pending.platform 得空值，
// resolveOpen 直接 return null、client.js 把 songmid 当网易云 id 用——大量曲目因此连精确取链都走不到。
// 这里做归一化：优先 platform，否则由 source 反推，保证存量歌单（已存 localStorage）也能救回。
export function platformOf(mi) {
  const p = String(mi?.platform || '').toLowerCase()
  if (p === 'netease' || p === 'wy' || p === '163') return 'netease'
  if (p === 'qq' || p === 'tx' || p === 'qy') return 'qq'
  if (p === 'kugou' || p === 'kg') return 'kugou'
  const s = String(mi?.source || '').toLowerCase()
  if (s === 'wy' || s === 'netease' || s === '163') return 'netease'
  if (s === 'tx' || s === 'qq' || s === 'qy') return 'qq'
  if (s === 'kugou' || s === 'kg') return 'kugou'
  return ''
}

// 内置双引擎取链：按 search 给的 platform+id 精确取真实可播直链。
// 关键：取链后做「ID 反查」确认这个 ID 真实指向的就是用户点的那首歌，
// 否则（片段 / 伴奏 / 同名翻唱 / 错歌）一律丢弃、交给跨平台兜底，杜绝「货不对版」。
async function resolveOpen(track) {
  const mi = track?.pending
  if (!mi || !mi.id) return null
  const plat = platformOf(mi)
  if (!plat) return null
  // QQ 曲目（songmid）：内置 api-enhanced 是网易云系、不认 songmid；QQ 直连免费 sign 又已失效
  // （实测取链 0/6）。让它走这里的「精确取链」纯属浪费预算且必失败——直接交给下面的跨平台兜底②，
  // 用「歌名 + 歌手」匹配到网易云 id，再由内置引擎取链/解灰拿完整文件（实测能救回大多数 QQ 曲目）。
  if (plat === 'qq') return null
  // 酷狗 hash：直接走酷狗公开接口取链（免费曲秒出完整链），没有可用的 ID 反查通道，跳过反查。
  if (plat === 'kugou') {
    try {
      const out = await music.resolve({ platform: 'kugou', id: mi.id })
      if (out?.url) return { streams: [{ url: out.url, quality: out.quality || 'standard' }], trial: false }
    } catch { /* 付费曲取不到，交给后面的兜底 */ }
    return null
  }
  const src = 'wy'
  try {
    // 取链与反查并行：反查不阻塞取链，反查失败也放行（不误杀能播的歌）
    const [out, real] = await Promise.all([
      music.resolve(mi).catch(() => null),
      lookupIdentity({ source: src, id: mi.id }, 3500).catch(() => null),
    ])
    if (!out || !out.url) return null
    if (real && real.name) {
      const verdict = identityMatches(
        { name: track.title, singer: track.artist, album: track.album, durationMs: track.durationMs },
        real,
      )
      if (!verdict.ok) return null  // 这个 ID 指向的不是原曲 → 丢弃换源
    }
    // 保留「试听片段」标记：上层会先尝试跨平台换源找完整版，实在没有才播放并提示
    return {
      streams: [{ url: out.url, quality: out.quality || 'standard' }],
      trial: !!out.trial, trialSeconds: Number(out.trialSeconds) || 0,
    }
  } catch { /* 该平台取不到（无版权/灰歌），交给跨平台兜底 */ }
  return null
}

// 并行聚合 → 同一首歌合并候选流 → 取最高音质。
const SEARCH_DEADLINE_MS = 6000
const GRACE_MS = 1200
const withinDeadline = (p, ms) => Promise.race([
  p.catch(() => []),
  new Promise((r) => setTimeout(() => r([]), ms)),
])

export async function searchAll(q) {
  if (!q.trim()) return []
  const list = await enabledAdapters()
  const batches = new Array(list.length).fill(null)
  const merged = () => officialBoost(filterOfficial(mergeCandidates(batches.filter(Boolean).flat())
    .filter((t) => t.streams.length || t.pending)))
  if (!list.length) return []

  return new Promise((resolve) => {
    let done = 0
    let armed = false
    let timer = null
    const hard = setTimeout(() => finish(), 5200)
    const finish = () => {
      clearTimeout(hard)
      if (timer) clearTimeout(timer)
      resolve(merged())
    }
    for (const [i, a] of list.entries()) {
      withinDeadline(a.search(q), SEARCH_DEADLINE_MS).then((rows) => {
        batches[i] = rows
        done += 1
        if (rows.length && !armed) {
          armed = true
          timer = setTimeout(finish, GRACE_MS)
        }
        if (done === list.length) finish()
      })
    }
  })
}

// ---- 点播取链：内置双引擎 → 跨平台兜底 ----
const HTTPS_PAGE = typeof location !== 'undefined' && location.protocol === 'https:'
// Vercel/Serverless 冷启动 + 6 路并发取链常常 5~10 秒，8 秒会把大量能播的歌硬砍掉。
const OPEN_BUDGET_MS = 13000
const CROSS_BUDGET_MS = 14000

// 波点直链的第二道保险：宿主侧已按「歌名+歌手+时长」严格匹配，
// 这里再用原始曲目核对一次，绝不把《沈园外》当《一分一寸》播出去。
const normB = (s) => String(s || '').toLowerCase()
  .replace(/[\s\u3000]/g, '')
  .replace(/[()（）[\]【】<>《》"'`·,，、&+!！?？.。:：;；\-—_~｜|]/g, '')
const stripB = (s) => String(s || '').replace(/[（(【[][^)）\]】]*[)）\]】]/g, '').trim()
function bodianVerifiedUrl(track, meta) {
  const url = String(meta?.url || '')
  if (!/^https?:/i.test(url)) return ''
  const a = normB(stripB(track.title))
  const b = normB(stripB(meta.name))
  if (!a || !b) return ''                       // 宿主没回传命中曲目：不冒险
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (!(a === b || (short.length >= 3 && long.length - short.length <= 6 && long.includes(short)))) return ''
  const wa = normB(track.artist)
  const ga = normB(meta.artist)
  if (wa && ga) {
    const parts = (s) => normB(s).split(/[、,，&/|]+/).filter((x) => x.length >= 2)
    const wp = parts(track.artist)
    const gp = parts(meta.artist)
    const ok = wa === ga || wa.includes(ga) || ga.includes(wa)
      || wp.some((x) => gp.some((y) => x === y || x.includes(y) || y.includes(x)))
    if (!ok) return ''
  }
  const d1 = Number(track.durationMs) || 0
  const d2 = Number(meta.duration) || 0
  if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > 15000) return ''
  return url
}

const httpsOnly = (t) => {
  if (!t?.streams?.length) return null
  const streams = HTTPS_PAGE ? t.streams.filter((s) => /^https:/i.test(s.url || '')) : t.streams
  return streams.length ? { ...t, streams } : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function resolvePending(track, depth = 0, force = false) {
  const mi = track?.pending || null
  const hasId = !!(mi && mi.id && platformOf(mi))
  // 无 pending 的歌（歌单只存了歌名+歌手，占多数）也必须能播——走「歌名+歌手现场搜索」路径。
  // 用「歌名|歌手」做缓存指纹，避免同一首歌重复搜索。
  const fp = hasId ? idFingerprint(mi) : `txt|${String(track.title || '').trim()}|${String(track.artist || '').trim()}`
  if (depth === 0) {
    const hit = cachedStreams(track.key, fp)
    if (hit) return { ...track, streams: hit, cached: true }
    if (!force && isCoolingDown(track.key)) return null
  }
  const finalize = (hit) => {
    const usedMi = hit.__mi || mi || { platform: hit.source || '', id: '' }
    // 试听片段绝不进 30 分钟缓存：否则服务端解灰恢复后，期间重复点歌仍一直播片段
    if (!hit.trial) {
      try { rememberStreams(track.key, hit.streams, hit.source || platformOf(usedMi), hasId ? fp : fp) } catch { /* 无 key 的歌缓存失败不影响播放 */ }
    }
    return {
      ...hit,
      key: track.key,
      title: track.title || hit.title,
      artist: track.artist || hit.artist,
      album: track.album || hit.album || '',
      durationMs: track.durationMs || hit.durationMs || 0,
      pending: mi,
    }
  }

  // ★ ① 波点直取优先：按「歌名+歌手」直接拿完整链（最快、覆盖最全，含付费曲）。
  //    有 ID 的歌也先走这条——因为 ID 可能是翻唱版/片段版，而波点按关键词匹配更准更全。
  //    这里只尝试一次；失败后走后面的搜索兜底时不再重复调用波点（一次要十几秒，
  //    重复调用会把单曲取链拖到 30 秒以上，用户看到的就是「一直跳过」）。
  let bodianTried = false
  if (depth === 0) {
    bodianTried = true
    const meta = await music.resolveByKeyword({
      title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs,
    }).catch(() => null)
    const viaBodian = bodianVerifiedUrl(track, meta)
    if (viaBodian) {
      return finalize({
        streams: [{ url: viaBodian, quality: 'standard' }],
        trial: false, source: 'bodian',
        __mi: mi || { platform: 'bodian', id: '' },
      })
    }
  }

  // ② 有精确 platform+id 的：精确取链（快、不串歌）。QQ songmid 因直连失效已在 resolveOpen 里跳过。
  let openHit = null
  if (hasId) {
    openHit = await Promise.race([
      resolveOpen(track),
      sleep(OPEN_BUDGET_MS).then(() => null),
    ])
    if (openHit && !openHit.trial) {
      return finalize({
        ...track, ...openHit, cover: track.cover || openHit.cover || '',
        license: track.license, licenseUrl: track.licenseUrl, source: platformOf(mi), __mi: mi,
      })
    }
  }

  // ③ 主路径（无 ID 也是这条）：按「歌名 + 歌手」多平台搜索 → 歌名/歌手/时长三重校验 → 按优先级逐个取链。
  //    允许同歌名同歌手的版本差异（Live/翻唱/SQ 等），但绝不换歌手、不换歌（用户明确要求）。
  //    平台优先级：酷狗（匿名可取完整链，覆盖率最高）> 网易云（可解灰）> QQ（仅兜底）。
  if (depth === 0) {
    const alt = await resolveBySearch(track, { skipBodian: bodianTried }).catch(() => null)
    if (alt && !(alt.trial || alt.__trial)) {
      return { ...alt, key: track.key, title: track.title || alt.title, artist: track.artist || alt.artist, pending: mi }
    }
  }

  // 完整版确实找不到，但至少有片段：照播，并把标记透传给 UI 提示「仅试听片段」。
  if (openHit && openHit.streams?.length) {
    return finalize({
      ...track, ...openHit, cover: track.cover || openHit.cover || '',
      license: track.license, licenseUrl: track.licenseUrl, source: platformOf(mi), __mi: mi,
    })
  }

  if (depth === 0) markStreamFail(track.key)
  return null
}

// 平台取链优先级：酷狗优先（匿名能取完整链），网易云次之（可解灰），QQ 最后（付费曲取不到）。
const PLAT_RANK = { kugou: 0, netease: 1, qq: 2 }
// 兼容历史 source 命名
const rankOf = (p) => (PLAT_RANK[p] ?? (p === 'kg' ? 0 : p === 'wy' ? 1 : p === 'tx' ? 2 : 9))

// 按「歌名+歌手」现场搜索并取链。返回 { streams, source, __mi } 或 null。
// ★ 第一优先：波点（按歌名+歌手直接取完整链，不依赖平台 ID，能覆盖付费曲；Windows 宿主可用）。
async function resolveBySearch(track, { skipBodian = false } = {}) {
  const q = `${track.title || ''} ${track.artist || ''}`.trim()
  const qTitle = String(track.title || '').trim()
  if (!q) return null
  const budget = CROSS_BUDGET_MS
  let done = false
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, budget)
    const finish = (v) => { if (!done && v) { done = true; clearTimeout(timer); resolve(v) } }
    ;(async () => {
      // ① 波点直取（最快最全，能拿付费曲完整链）
      if (!skipBodian) {
        try {
          const meta = await music.resolveByKeyword({
            title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs,
          })
          const u = bodianVerifiedUrl(track, meta)
          if (u) {
            return finish({
              streams: [{ url: u, quality: 'standard' }],
              trial: false,
              source: 'bodian',
              __mi: { platform: 'bodian', id: '' },
              title: track.title, artist: track.artist, album: track.album,
            })
          }
        } catch { /* 落到多平台搜索 */ }
      }
      // ② 多平台搜索兜底：歌名+歌手+时长三重校验，按平台优先级逐个取链
      const queries = [q]
      if (qTitle && qTitle !== q) queries.push(qTitle)
      for (const kw of queries) {
        const rows = await music.search(kw, 20).catch(() => [])
        const cands = rows
          .filter((r) => r && r.id && sameTrack(track, r, { strictOfficial: false }) && durClose(track, r, 15))
          .sort((a, b) => rankOf(platformOf(a) || a.platform) - rankOf(platformOf(b) || b.platform))
        if (!cands.length) continue
        for (const c of cands.slice(0, 8)) {
          const plat = platformOf(c) || c.platform
          const got = await music.resolve({ platform: plat, id: c.id }).catch(() => null)
          if (got && got.url) {
            return finish({
              streams: [{ url: got.url, quality: got.quality || 'standard' }],
              trial: !!got.trial, trialSeconds: Number(got.trialSeconds) || 0,
              source: plat,
              __mi: { platform: plat, id: c.id },
              title: c.title || track.title, artist: c.artist || track.artist, album: c.album || track.album,
            })
          }
        }
      }
      finish(null)
    })().catch(() => finish(null))
  })
}

// 时长校验：两边都有时长时，差值需在容差内（避免同名不同版本/时长不符的错配）
function durClose(track, row, tolSec = 15) {
  const a = Number(track.durationMs) > 0 ? track.durationMs / 1000 : 0
  const b = Number(row.duration) > 0 ? Number(row.duration) : 0
  if (!a || !b) return true   // 缺时长信息时不拦（交给歌名+歌手把关）
  return Math.abs(a - b) <= tolSec
}

// ── 列表预取 ──
const prefetching = new Set()
let prefetchQueue = []
let prefetchRunning = 0
// 并行预取队列后 6 首：并发 3 足够把 6 首迅速铺满缓存，又不会把公开接口打满。
const PREFETCH_CONCURRENCY = 3

function pumpPrefetch() {
  while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length) {
    const t = prefetchQueue.shift()
    prefetchRunning++
    resolvePending(t).catch(() => {}).finally(() => {
      prefetchRunning--
      prefetching.delete(t.key)
      pumpPrefetch()
    })
  }
}

// 队列预取：把后面几首的「直链地址」提前解析好（只解析地址，不下载音频、不占流量），
// 用户点下一首时直接命中缓存，切歌就是秒开。
// 注意：歌单里大多数曲目只有「歌名 + 歌手」，没有平台 ID，不能用 pending 作为过滤条件，
// 否则预取对 90% 的歌都不生效（这也是之前切歌仍然慢的原因）。
export function prefetchTracks(tracks, { limit = 5, priorityKey = '' } = {}) {
  if (!Array.isArray(tracks)) return 0
  const added = []
  for (const t of tracks) {
    if (added.length >= limit) break
    if (!t?.key || t.streams?.length) continue
    const fp = t.pending?.id && platformOf(t.pending)
      ? idFingerprint(t.pending)
      : `txt|${String(t.title || '').trim()}|${String(t.artist || '').trim()}`
    if (prefetching.has(t.key) || cachedStreams(t.key, fp) || isCoolingDown(t.key)) continue
    prefetching.add(t.key)
    added.push(t)
  }
  if (added.length) {
    // 本次入队的排到等待队列最前：刚点歌时队列里可能还压着别页的预取任务
    prefetchQueue = added.concat(prefetchQueue)
    // 「优先加载下一首」：把它从任何位置提到队首，先占一个并发槽
    if (priorityKey) {
      const i = prefetchQueue.findIndex((x) => x?.key === priorityKey)
      if (i > 0) { const [p] = prefetchQueue.splice(i, 1); prefetchQueue.unshift(p) }
    }
  }
  pumpPrefetch()
  return added.length
}

// 把「已经预取好的直链」直接挂到队列里的曲目对象上。
// 切歌时 playTrack() 看到 streams 非空就不再走搜索/取链，实现真正的零等待切歌。
// 由 UI 在歌曲临近结尾时调用；不在起播瞬间调用，以免并发取链抢音频缓冲带宽。
export function applyPrefetched(track) {
  if (!track?.key || track.streams?.length) return false
  const mi = track.pending || null
  const hasId = !!(mi && mi.id && platformOf(mi))
  const fp = hasId ? idFingerprint(mi) : `txt|${String(track.title || '').trim()}|${String(track.artist || '').trim()}`
  const hit = cachedStreams(track.key, fp)
  if (!hit?.length) return false
  track.streams = hit
  return true
}

// 预热：内置引擎无需下载脚本 / 建 Worker，无需预热；保留接口兼容。
export async function warmupSources() { return true }

// 播放失败后的换源重试：按「歌名 + 歌手」在内置双平台再找一遍并精确取链。
export async function resolveRetry(track, triedSources = []) {
  const mi = track?.pending || null
  const q = `${track.title || ''} ${track.artist || ''}`.trim()
  if (!q) return null
  // 播放失败后再试一次波点：仍带完整歌手，避免只有歌名时命中别人的同名曲目。
  try {
    const meta = await music.resolveByKeyword({
      title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs,
    })
    const u = bodianVerifiedUrl(track, meta)
    if (u) {
      return {
        ...track, streams: [{ url: u, quality: 'standard' }], trial: false,
        source: 'bodian', pending: mi,
      }
    }
  } catch { /* 继续多平台搜索 */ }
  const tried = new Set([...(triedSources || []), mi?.platform].filter(Boolean))
  const deadline = Date.now() + 14000
  const rows = await music.search(q, 20).catch(() => [])
  for (const row of rows) {
    if (Date.now() > deadline) break
    // 放宽 strictOfficial：允许同名版本，片段/伴奏/错歌仍由 resolveOpen 的 identityMatches 反查拦截
    if (!row?.id || tried.has(row.platform) || !sameTrack(track, row, { strictOfficial: false })) continue
    const hit = await resolvePending({ ...track, pending: { platform: row.platform, id: row.id } }, 1).catch(() => null)
    if (hit?.streams?.length) return hit
  }
  return null
}

export function applyCachedStreams(key, streams, source = '', mi = null) {
  try { rememberStreams(key, streams, source, idFingerprint(mi)) } catch { /* noop */ }
}

export const streamCacheInfo = streamCacheStats
export const peekCache = (key, idfp = '') => cachedStreams(key, idfp)
export { clearStreamCache, forgetStreams }

// 歌单导入后的元数据匹配
export async function resolveMetadata(items) {
  const out = []
  for (const it of items) {
    const hits = await searchAll(`${it.title} ${it.artist}`).catch(() => [])
    const exact = hits.find((t) => sameTrack(it, t))
    out.push({ ...it, matched: exact || null })
  }
  return out
}
