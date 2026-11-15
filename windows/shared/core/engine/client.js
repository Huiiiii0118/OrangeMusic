// 渲染端音源客户端（单例）。引擎（crypto/netease/tencent/musicapi）跑在渲染端，
// 只通过注入的 request() 发外网请求，CORS 由「宿主」或「边缘函数」兜底：
//   - Windows exe：native.request → app://orangemusic/api/net → 主进程 proxyNet（无 CORS、可 spoof Origin）
//   - iOS 网页：若设置了 MUSIC_API_BASE（免费边缘函数），走 ${BASE}/proxy（服务端 fetch + CORS *）；
//               没设置则退回 native.request（直连失败→公共代理，降级可用）
//
// 音源后端切换：
//   - 默认走「自写直连引擎」（网易云 + QQ，纯前端加密，无第三方脚本）。
//   - 若在「设置 → 音源」填了「音乐 API 地址」（UnblockNeteaseMusic / Meting 等），
//     则优先走该服务（服务端完成各平台签名/加密，更稳定），直连引擎作为兜底。
import { createEngine } from './index.js'
import { createMusicApi } from './OrangeMusicApi.js'
import { bodianResolve } from './OrangeBodian.js'
import { native } from '../../protocol/bridge.js'

const LS_BASE = 'orangemusic:musicApiBase'
const LS_API = 'orangemusic:musicApiUrl'
const LS_BUILTIN = 'orangemusic:builtinApiOff'
let MUSIC_API_BASE = ''
let MUSIC_API_URL = ''
let BUILTIN_OFF = false
try { MUSIC_API_BASE = (localStorage.getItem(LS_BASE) || '').trim() } catch { /* 隐私模式 */ }
try { MUSIC_API_URL = (localStorage.getItem(LS_API) || '').trim() } catch { /* 隐私模式 */ }
try { BUILTIN_OFF = localStorage.getItem(LS_BUILTIN) === '1' } catch { /* 隐私模式 */ }

// Windows exe 自带音乐引擎（api-enhanced 主进程内嵌，零部署、含解灰）。
// localapi:// 是伪 scheme，由主进程 /api/net 拦截后直接调函数，无需起端口。
// 只在 Windows 桌面宿主启用；iOS 网页 / 浏览器仍走用户填的音乐 API 地址或边缘函数。
const IS_WIN_HOST = typeof document !== 'undefined'
  && document.documentElement.dataset.platform === 'windows'
  && typeof location !== 'undefined' && /^(app|file):/.test(location.protocol)
const BUILTIN_BASE = 'localapi://'

export const setBuiltinApi = (on) => {
  BUILTIN_OFF = !on
  try { localStorage.setItem(LS_BUILTIN, BUILTIN_OFF ? '1' : '0') } catch { /* noop */ }
}
export const getBuiltinApi = () => IS_WIN_HOST && !BUILTIN_OFF
export const isWinHost = () => IS_WIN_HOST

export const setMusicApiBase = (u) => {
  MUSIC_API_BASE = String(u || '').trim()
  try { if (MUSIC_API_BASE) localStorage.setItem(LS_BASE, MUSIC_API_BASE); else localStorage.removeItem(LS_BASE) } catch { /* noop */ }
}
export const getMusicApiBase = () => MUSIC_API_BASE

export const setMusicApiUrl = (u) => {
  MUSIC_API_URL = String(u || '').trim()
  try { if (MUSIC_API_URL) localStorage.setItem(LS_API, MUSIC_API_URL); else localStorage.removeItem(LS_API) } catch { /* noop */ }
}
export const getMusicApiUrl = () => MUSIC_API_URL

// 统一请求传输：返回 { statusCode, bodyText, headers }
function makeRequest() {
  if (MUSIC_API_BASE) {
    const base = MUSIC_API_BASE.replace(/\/+$/, '')
    return async (url, opts = {}) => {
      const r = await fetch(`${base}/proxy?url=${encodeURIComponent(url)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
      if (!r.ok) throw new Error(`边缘函数 ${r.status}`)
      const j = await r.json()
      return { statusCode: j.statusCode ?? 502, bodyText: j.bodyRaw ?? '', headers: j.headers || {} }
    }
  }
  // Windows：native.request 经主进程代发；iOS 未配边缘函数：退回 doRequest（含公共代理降级）
  return async (url, opts = {}) => {
    const r = await native.request(url, opts)
    return { statusCode: r.statusCode ?? 502, bodyText: r.bodyRaw ?? '', headers: r.headers || {} }
  }
}

// 惰性取传输：每次调用时才决定走边缘函数还是 native，设置中转地址后无需刷新即生效
const request = (url, opts) => makeRequest()(url, opts)
const directEngine = createEngine(request)

// 音乐 API 引擎实例：按 base 缓存。内置引擎（localapi://）与用户填的外部地址是两路独立实例，
// 二者可同时参与级联——外部 API 连不上/取不到链时，内置引擎（本地函数调用、含解灰）必须能兜住，
// 绝不能因为 localStorage 里残留一个连不上的外部地址就把内置引擎整条掐掉（v1.8.0「完全没法播」的放大器）。
const _engineCache = new Map()
function engineFor(base) {
  if (!base) return null
  let e = _engineCache.get(base)
  if (!e) { e = createMusicApi(request, base); _engineCache.set(base, e) }
  return e
}
// 用户填的外部 API（个人自部署 / 多设备共用）；可能连不上，故只能作为「优先尝试」而非唯一路径。
const externalEngine = () => engineFor(getMusicApiUrl())
// Windows 内置引擎：零部署、含解灰，是最可靠的兜底。
const builtinEngine = () => (getBuiltinApi() ? engineFor(BUILTIN_BASE) : null)

// 供音源页徽标诊断：内置引擎是否处于启用状态（与是否填了外部地址无关）。
export const builtinActive = () => getBuiltinApi()
// 保留旧名以兼容任何外部引用：返回「外部 API 或内置」的第一个可用引擎（用于诊断展示）。
function apiEngineOrNull() { return externalEngine() || builtinEngine() }

// 供推荐页（charts/discover/covers）复用同一传输通道，保证 iOS 也能加载真实榜单/封面。
export const netRequest = async (url, opts = {}) => makeRequest()(url, opts)

// ── 健康检测：判断填的地址是否真的可用（设置页「运行中」徽标用） ──
// 音乐 API：打一个最小 /search，返回可解析 JSON 即视为可用。
// 注意：native.request 返回 { statusCode, bodyRaw }（无 bodyText 字段），
// 必须两个字段都读，否则解析到空对象 → 恒判「不可用」。
export async function checkMusicApi(url) {
  const base = String(url || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, why: '未填写' }
  try {
    const r = await native.request(`${base}/search?keywords=a&type=1&limit=1`, {
      method: 'GET', timeout: 12000, headers: { Accept: 'application/json' },
    })
    if (!r || typeof r.statusCode !== 'number' || r.statusCode >= 400) return { ok: false, why: 'HTTP ' + (r && r.statusCode) }
    const text = String(r.bodyText ?? r.bodyRaw ?? '').trim()
    if (!text) return { ok: false, why: '空响应' }
    let j
    try { j = JSON.parse(text) } catch { return { ok: false, why: '响应不是 JSON' } }
    // 容错多种服务形态：NeteaseCloudMusicApi 系 {result|songs|data, code:200}；Meting 系返回数组
    const ok = Array.isArray(j) || !!(j && (j.result || j.songs || j.data || j.code === 200 || j.lyric || j.url))
    return ok ? { ok: true } : { ok: false, why: '响应格式不符' }
  } catch (e) { return { ok: false, why: (e && e.message) || '连接失败' } }
}

// iOS 音源中转（边缘函数）：打 /proxy，返回 { statusCode, bodyRaw } 即视为可用。
export async function checkRelay(url) {
  const base = String(url || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, why: '未填写' }
  try {
    const r = await fetch(`${base}/proxy?url=${encodeURIComponent('https://music.163.com')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', timeout: 6000 }),
    })
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status }
    const j = await r.json()
    return (j && typeof j.statusCode === 'number') ? { ok: true } : { ok: false, why: '响应格式不符' }
  } catch (e) { return { ok: false, why: (e && e.message) || '连接失败' } }
}

// ── 多路级联引擎（内置 + 外部 API + 直连）──
// 设计要点（v1.8.1 修复「完全没法播」）：
//   ① 内置引擎（localapi://，本地函数调用 + 解灰）是最可靠一路，Windows 下恒参与，
//      绝不被「残留的外部坏地址」取代；
//   ② 用户填的外部 API 与内置并行尝试，谁先给完整链用谁，互不拖死；
//   ③ QQ 平台 id（songmid）只有内置 QQ 引擎认识 → 网易云系引擎直接跳过；
//   ④ 直连引擎（weapi/QQ）作为最后兜底。
// 结果择优：完整链 > 试听片段；同等完整度时按引擎权重（内置 > 外部 > 直连）。
const okUrl = (o) => (o && o.url ? o : null)
// rank 越小越优先。带 rank 的结果对象形如 { url, trial, _rank }。
const better = (a, b) => {
  if (!a) return b
  if (!b) return a
  const ta = a.trial ? 1 : 0, tb = b.trial ? 1 : 0
  if (ta !== tb) return ta < tb ? a : b          // 完整链优先于片段
  return (a._rank ?? 9) <= (b._rank ?? 9) ? a : b // 同等时按引擎权重
}

// 归一化曲目平台：新引擎用 platform:'netease'|'qq'，歌单导入历史用 source:'wy'|'tx'（存量歌单无 platform）。
function platOf(track) {
  const p = String(track?.platform || '').toLowerCase()
  if (p === 'qq' || p === 'tx') return 'qq'
  if (p === 'netease' || p === 'wy') return 'netease'
  if (p === 'kugou' || p === 'kg') return 'kugou'
  const s = String(track?.source || '').toLowerCase()
  if (s === 'qq' || s === 'tx') return 'qq'
  if (s === 'netease' || s === 'wy') return 'netease'
  if (s === 'kugou' || s === 'kg') return 'kugou'
  return p
}

// 收集本次请求要用的引擎（内置在前、外部次之、直连最后）。
function collectEngines() {
  const list = []
  const bi = builtinEngine()
  const ext = externalEngine()
  if (bi) list.push({ engine: bi, rank: 0, name: 'builtin' })
  if (ext && ext !== bi) list.push({ engine: ext, rank: 1, name: 'external' })
  list.push({ engine: directEngine, rank: 2, name: 'direct' })
  return list
}

export const music = {
  async search(keyword, limit = 30) {
    const engines = collectEngines()
    const groups = await Promise.all(
      engines.map(({ engine }) => engine.search(keyword, limit).catch(() => [])),
    )
    const seen = new Set()
    const out = []
    // 按引擎顺序（内置→外部→直连）合并，内置结果排前；按 platform:id 去重。
    for (const rows of groups) {
      for (const r of rows) {
        const k = `${r.platform}:${r.id}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(r)
      }
    }
    return out
  },

  async resolve(track) {
    // track 就是 pending（{platform|source, id}）；platOf 兼容两套字段，避免 songmid 被当网易云 id。
    const plat = platOf(track)
    // 酷狗 hash 只有酷狗引擎认识；QQ songmid 的取链主路径在 sources.js（歌名+歌手→波点），
    // 这里保留酷狗直连作为精确兜底（免费曲可直接出链）。
    if (plat === 'kugou' || plat === 'qq') return directEngine.resolve(track)

    const engines = collectEngines()
    // 所有引擎并行取链；每个结果带引擎权重。拿到「完整非片段链」立即返回（不等慢引擎），
    // 否则等预算结束，从全部结果里挑最好的。内置引擎内部已分阶段（普通 7s + 解灰 16s），
    // 外层给 18s 总预算，避免 Vercel 冷启动 / 解灰回源被硬砍。
    return new Promise((resolve, reject) => {
      const hits = []
      let pending = engines.length
      let finished = false
      let timer = null
      const finish = () => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        if (!hits.length) { reject(new Error('所有音源均未返回直链（可能无版权/灰歌）')); return }
        resolve(hits.reduce((best, x) => better(best, x)))
      }
      timer = setTimeout(finish, 18000)
      engines.forEach(({ engine, rank }) => {
        Promise.resolve(engine.resolve(track))
          .then(okUrl)
          .catch(() => null)
          .then((v) => {
            if (v && v.url) {
              const hit = { ...v, _rank: rank }
              hits.push(hit)
              if (!v.trial) { finish(); return }   // 完整链：立即返回
            }
            if (--pending === 0) finish()
          })
      })
    })
  },

  async lyric(track) {
    const plat = platOf(track)
    if (plat === 'qq' || plat === 'kugou') return directEngine.lyric(track).catch(() => ({ lyric: '', trans: '' }))
    const engines = collectEngines()
    const rows = await Promise.all(
      engines.map(({ engine }) => engine.lyric(track).catch(() => ({ lyric: '', trans: '' }))),
    )
    // 按引擎顺序取第一份非空歌词（内置优先）。
    return rows.find((r) => r && r.lyric) || rows[0] || { lyric: '', trans: '' }
  },

  // 诊断：当前取链策略
  backend: () => (getMusicApiUrl()
    ? `music-api:${getMusicApiUrl()}（内置引擎兜底）`
    : getBuiltinApi() ? 'builtin(波点取链 + api-enhanced 解灰，零部署)' : 'kugou(酷狗公开接口兜底)'),

  // ★ 主力取链：按「歌名+歌手」直接取完整链（波点/酷我，不依赖平台 ID，覆盖付费曲）。
  //   仅 Windows 宿主可用；其它端返回 null。返回 {url,name,artist,album,duration}，
  //   由 sources.js 再做一次歌名/歌手校验，避免 provider 的 list[0] 兜底造成「点 A 播 B」。
  async resolveByKeyword(track) {
    try {
      return await bodianResolve(track, request)
    } catch {
      return null
    }
  },
}

export default music
