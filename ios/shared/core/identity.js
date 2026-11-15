// 曲目身份反查：拿「平台 + ID」去官方详情接口问「这个 ID 真实指向哪首歌」。
//
// 为什么必须要这一层：搜索结果里的 name/singer 是干净的（「哼」「玻璃糖」），
// 但同一个歌名在各平台有原版 / 52 秒片段 / 消音伴奏 / 电音改编 / 同名翻唱等**各自独立的 ID**。
// 以前取链只按 ID 拿音频，全程不核对 ID 真实指向什么 —— 只要自建歌单里存的是
// 电音版或补位曲目（半壶纱）的 ID，就照播不误，界面还显示「哼 / 玻璃糖」。
//
// 这一层是「点 A 播 B」的最后一道闸：音频链接取到后、交给播放器前，
// 用官方详情接口反查 ID 的真实歌名/歌手/时长，跟界面元数据核对；对不上就丢弃换源。
// 只做只读元数据核对，不碰任何受保护音频内容。
import { netRequest } from './engine/client.js'
import { canonicalTitle, artistMatches } from './official.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
const enc = encodeURIComponent

const getJson = async (url, referer, timeout = 3500) => {
  const r = await netRequest(url, {
    method: 'GET', timeout, noPublicProxy: true,
    headers: { Referer: referer, 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
  })
  if (!r || typeof r.statusCode !== 'number' || r.statusCode >= 400) throw new Error(`HTTP ${r?.statusCode || 0}`)
  // netRequest 归一化给 bodyText；native 直连给 bodyRaw —— 两个字段都读，避免静默解析失败
  return JSON.parse(String(r.bodyText ?? r.bodyRaw ?? ''))
}

// 各平台「按 ID 反查真实曲目」的官方详情接口。
// 返回统一结构 { name, singer, durationMs, album }，查不到就返回 null（放行，不误杀）。
async function neteaseDetail(id) {
  const j = await getJson(`https://music.163.com/api/song/detail?ids=${enc(`[${id}]`)}`, 'https://music.163.com/')
  const s = j?.songs?.[0]
  if (!s) return null
  return {
    name: s.name || '',
    singer: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
    durationMs: Number(s.duration || s.dt) || 0,
    album: s.album?.name || s.al?.name || '',
  }
}

async function qqDetail(songmid) {
  const j = await getJson(`https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${enc(songmid)}&format=json&platform=yqq`, 'https://y.qq.com/')
  const s = j?.data?.[0]
  if (!s) return null
  const interval = Number(s.interval) || 0
  return {
    name: s.name || s.title || '',
    singer: (s.singer || []).map((a) => a.name).filter(Boolean).join(' / '),
    durationMs: interval > 0 ? interval * 1000 : 0,
    album: s.album?.name || s.album?.title || '',
  }
}

// 酷我详情接口要签名，拿不到；酷狗/咪咕同理。
// 这些平台靠「搜索时 sameTrack 严格核对 + 缓存绑定 ID」兜，不做反查（返回 null = 放行）。
const LOOKUP = { wy: neteaseDetail, tx: qqDetail }

// 反查结果缓存（同一 ID 7 天内不重复查，切歌/来回点同一首都是毫秒级）
const LS_KEY = 'orangemusic:identity'
const TTL = 7 * 86400000
let mem = null
let saveTimer = 0
function load() {
  if (mem) return mem
  try { mem = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {} } catch { mem = {} }
  return mem
}
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const c = load()
      const keys = Object.keys(c)
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete c[k]
      localStorage.setItem(LS_KEY, JSON.stringify(c))
    } catch { /* 配额满忽略 */ }
  }, 500)
}

// 单飞：同一 ID 并发只发一次请求，避免「verifiedP 与 tryOpen 各自查、各自 2.5s 超时」
// 导致首次冷启动两边都拿到 null（其实网络是通的，只是被各自超时砍了）。
const inflight = new Map()

async function doLookup(src, id, key, timeout) {
  const c = load()
  const hit = c[key]
  if (hit && Date.now() - (hit.at || 0) < TTL) return hit.info || null
  const fn = LOOKUP[src]
  if (!fn) return null
  try {
    const info = await Promise.race([
      fn(id),
      new Promise((_, rej) => setTimeout(() => rej(new Error('反查超时')), timeout)),
    ])
    if (info?.name) {
      c[key] = { at: Date.now(), info }
      save()
      return info
    }
  } catch { /* 网络抖动：放行，交给下一首/换源兜底 */ }
  return null
}

/**
 * 反查 pending 元数据里 ID 的真实曲目身份。
 * 查不到 / 接口挂了 → 返回 null（放行，不因为查不到就误杀能播的歌）。
 */
export function lookupIdentity(mi, timeout = 3500) {
  if (!mi?.id) return Promise.resolve(null)
  const src = mi.source || 'wy'
  if (!LOOKUP[src]) return Promise.resolve(null)
  const key = `${src}|${mi.id}`
  if (inflight.has(key)) return inflight.get(key)
  const p = doLookup(src, mi.id, key, timeout)
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

// 明确的「片段 / 伴奏 / 纯音乐」标记（只拦这些，不拦 Live / 童声版 / 特别版等正式发行版本）。
// 实测教训：以前用 officialVerdict 判反查结果，官方详情名带「(童声版)」「(Live)」就被当成
// 改编版本丢弃，导致大量正常歌曲点播失败。反查的职责只有一件：确认 ID 指向的是同一首歌。
const NON_SONG = /(伴奏|纯音乐|无伴唱|instrumental|karaoke|试听|片段|铃声|彩铃|preview|snippet|tv\s*size|煲机|试音碟|音效测试)/i

/**
 * 核对「ID 真实身份」是否与界面元数据一致，且本身是正式版。
 * 返回 { ok, why }。ok=false 表示这条链接指向的不是用户点的那首（或不是原版），必须丢弃。
 */
export function identityMatches(want, real) {
  if (!real || !real.name) return { ok: true, why: '' }   // 没查到就不能臆断，放行
  // 只拦明确不是完整歌曲的：伴奏/纯音乐/试听片段/过短时长
  if (NON_SONG.test(real.name)) return { ok: false, why: `ID 指向片段或伴奏：${real.name}` }
  if (real.durationMs > 0 && real.durationMs < 60000) {
    return { ok: false, why: `ID 指向过短音频（${Math.round(real.durationMs / 1000)}s）：${real.name}` }
  }
  // 歌名必须对得上（允许标点/空格差异，但不同歌名相似度很低）
  const a = canonicalTitle(want?.name ?? want?.title ?? '')
  const b = canonicalTitle(real.name)
  if (a && b && a !== b) {
    // 用是否包含判断，兼容「哼」vs「哼 (原版)」这类；但「半壶纱」不含「哼」
    if (!a.includes(b) && !b.includes(a)) return { ok: false, why: `ID 指向另一首：${real.name}` }
  }
  // 歌手对不上也不行（同一歌名不同歌手 = 翻唱）
  if (!artistMatches(want?.singer ?? want?.artist ?? '', real.singer)) {
    return { ok: false, why: `ID 歌手不符：${real.singer}` }
  }
  return { ok: true, why: '' }
}

/** 供自检显示反查缓存规模 */
export const identityInfo = () => ({ entries: Object.keys(load()).length })
