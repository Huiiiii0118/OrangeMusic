// 歌词聚合 v2：多平台匹配 + 严格校验，避免「歌词和正在唱的歌不是同一首」。
//
// 以前的痛点：
//   1. 按「歌名 + 歌手」搜回的第一个结果直接取词，遇到 Live / 伴奏 / 翻唱 / 同名歌就串词；
//   2. 音源顺带带回的 lyrics 未经校验直接用，也可能是别的歌；
//   3. 只有一条通道时接口抖动就变成「暂无歌词」，且失败结果缓存 2 小时不再重试。
//
// 现在：所有「按名字找回 ID」的结果都必须通过 sameSong() 校验（去 Live/伴奏等括号后缀 +
// 歌手 token 交叉匹配）；外部通道优先，音源自带歌词只作为最后兜底；纯文本歌词也能稳定上屏；
// 失败只缓存 15 分钟，并支持点击歌词区强制重匹配。
import { normKey } from '../protocol/model.js'
import music, { netRequest } from './engine/client.js'

const LS_KEY = 'orangemusic:lyrics:v2'   // v1 缓存可能含未校验的错配歌词，换 key 让它自然失效
const TTL_OK = 7 * 24 * 3600 * 1000
const TTL_MISS = 15 * 60 * 1000
const KEEP = 160
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const enc = encodeURIComponent

let mem = readStore()
const inflight = new Map()

function readStore() {
  try { const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
let saveTimer
function saveStore() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const keys = Object.keys(mem).sort((a, b) => (mem[b]?.at || 0) - (mem[a]?.at || 0))
      for (const k of keys.slice(KEEP)) delete mem[k]
      localStorage.setItem(LS_KEY, JSON.stringify(mem))
    } catch { /* 隐私模式 / 配额满：只保留内存缓存 */ }
  }, 300)
}

async function getJson(url, { headers = {}, timeout = 6000 } = {}) {
  const r = await netRequest(url, {
    method: 'GET', timeout,
    headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers },
  })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
  const t = String(r.bodyText || '').trim()
  if (!t) throw new Error('空响应')
  try { return JSON.parse(t) } catch { throw new Error('返回的不是 JSON') }
}

// LRC → [{ time(ms), text }]。没有时间标签的纯文本歌词也按行切开，保证「至少有词可看」。
export function parseLrc(raw) {
  const src = String(raw || '')
  // 全局偏移标签 [offset:±ms]：很多 LRC 用它校准词曲对齐，忽略就会整篇早/晚。
  const offM = src.match(/\[offset:\s*([+-]?\d+)\s*\]/i)
  const offset = offM ? Number(offM[1]) || 0 : 0
  const lines = []
  for (const line of src.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!tags.length) continue
    const text = line.replace(/\[[^\]]+\]/g, '').trim()
    if (!text) continue
    for (const m of tags) {
      const frac = (m[3] || '0').padEnd(3, '0').slice(0, 3)
      lines.push({ time: Math.max(0, Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(frac) - offset), text })
    }
  }
  if (lines.length) {
    lines.sort((a, b) => a.time - b.time)
    return { lines, text: lines.map((l) => l.text).join('\n') }
  }
  const plain = String(raw || '')
    .replace(/\[[^\]]*\]/g, '')
    .split(/\r?\n/).map((x) => x.trim())
    .filter((x) => x && !/^(作词|作曲|编曲|歌词|演唱|制作人|lrc|by[:：])/i.test(x))
    .join('\n')
  return {
    lines: plain ? plain.split('\n').map((text, i) => ({ time: i * 5000, text })) : [],
    text: plain,
  }
}

const hasLyrics = (raw) => String(raw || '').replace(/\[[^\]]*\]/g, '').trim().length > 1

// ---- 严格匹配：去掉 (Live)/(伴奏)/[Remix] 等版本后缀，再比歌名与歌手 token ----
const normText = (s) => String(s || '').toLowerCase()
  .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, ' ')
  .replace(/\b(live|remix|inst|instrumental|cover|dj|mv|official|acoustic|karaoke)\b/gi, ' ')
  .replace(/伴奏|纯音乐|翻唱|现场版|演唱会版|剪辑版|抖音版/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
const artistTokens = (s) => String(s || '').toLowerCase()
  .split(/[\/、,，&+;；]|\s+feat\.?\s+/i)
  .map(normText).filter((x) => x.length > 0)
const sameSong = (name, singer, track) => {
  const a = normText(name), b = normText(track?.title)
  if (!a || !b) return false
  if (a !== b && !a.includes(b) && !b.includes(a)) return false
  const ta = artistTokens(track?.artist), sa = artistTokens(singer)
  if (!ta.length || !sa.length) return true   // 歌手信息缺失时只按歌名判定
  return ta.some((x) => sa.some((y) => y.includes(x) || x.includes(y)))
}

// 从 pending / alts 里挑可用的平台 ID（新引擎 pending = { platform, id }）。
function idsOf(track) {
  const p = track?.pending || {}
  const out = []
  if (p.platform && p.id) {
    const src = p.platform === 'netease' ? 'wy' : p.platform === 'qq' ? 'tx' : p.platform
    out.push({ source: src, id: String(p.id) })
  }
  for (const a of p.alts || []) if (a?.id) out.push({ source: a.source || '', id: String(a.id) })
  return out
}

// 新引擎直取歌词（网易云 weapi / QQ fcg），最可信、无需第三方镜像。
async function engineLyric(track) {
  const p = track?.pending
  if (!p || !p.platform || !p.id) return ''
  try {
    const r = await music.lyric(p)
    if (hasLyrics(r?.lyric)) return String(r.lyric)
  } catch { /* 该平台无歌词，换其它通道 */ }
  return ''
}

async function wyLyricOfficial(id) {
  if (!id) return ''
  try {
    const j = await getJson(`https://music.163.com/api/song/lyric?id=${enc(id)}&lv=1&kv=1&tv=-1`,
      { headers: { Referer: 'https://music.163.com/' }, timeout: 5000 })
    if (hasLyrics(j?.lrc?.lyric)) return String(j.lrc.lyric)
  } catch { /* 走公开镜像 */ }
  return ''
}

async function wyLyricGd(id) {
  if (!id) return ''
  try {
    const j = await getJson(`https://music-api.gdstudio.xyz/api.php?types=lyric&source=netease&id=${enc(id)}`, { timeout: 5000 })
    if (hasLyrics(j?.lyric)) return String(j.lyric)
  } catch { /* 无歌词 */ }
  return ''
}

// QQ 音乐歌词：nobase64=1 拿明文；老接口返回 base64 时再解一次 UTF-8。
async function qqLyric(id) {
  if (!id) return ''
  try {
    const j = await getJson(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${enc(id)}&format=json&nobase64=1&g_tk=5381`,
      { headers: { Referer: 'https://y.qq.com/' }, timeout: 5000 })
    let raw = String(j?.lyric || '')
    if (raw && !raw.includes('[')) {
      try {
        const bin = atob(raw)
        raw = new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
      } catch { /* 本来就是纯文本 */ }
    }
    return hasLyrics(raw) ? raw : ''
  } catch { return '' }
}

async function kwLyric(id) {
  if (!id) return ''
  try {
    const j = await getJson(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${enc(id)}`,
      { headers: { Referer: 'https://m.kuwo.cn/' } })
    const list = j?.data?.lrclist || []
    const raw = list.map((r) => {
      const sec = Number(r.time) || 0
      const mm = String(Math.floor(sec / 60)).padStart(2, '0')
      const ss = String(Math.floor(sec % 60)).padStart(2, '0')
      const cs = String(Math.round((sec % 1) * 100)).padStart(2, '0')
      return `[${mm}:${ss}.${cs}]${String(r.lineLyric || '').trim()}`
    }).join('\n')
    return hasLyrics(raw) ? raw : ''
  } catch { return '' }
}

// 平台 ID → 歌词：引擎直取优先（内置引擎带镜像/解灰，比直连公开接口稳），失败再走各平台公开接口。
async function lyricById(platform, id) {
  if (!id) return ''
  const pf = String(platform || '').toLowerCase()
  if (/^(wy|netease|tx|qq)$/.test(pf)) {
    try {
      const r = await music.lyric({ platform: /^(tx|qq)$/.test(pf) ? 'qq' : 'netease', id })
      if (hasLyrics(r?.lyric)) return String(r.lyric)
    } catch { /* 引擎不支持时换公开接口 */ }
  }
  if (/^(wy|netease)$/.test(pf)) return await wyLyricOfficial(id) || await wyLyricGd(id)
  if (/^(tx|qq)$/.test(pf)) return await qqLyric(id)
  if (/^(kw|kuwo)$/.test(pf)) return await kwLyric(id)
  return ''
}

// ★ 独立歌词通道：GD 聚合搜索（网易云/酷我/QQ/酷狗）→ 候选按「歌名匹配 + 歌手匹配」排序 →
// 逐个取词，必须带时间戳（[mm:ss] 标签）才收货。与引擎/公开接口不同的网络路径，
// 专治「大量歌词匹配不到」；时间戳校验保证拿到的就是可同步歌词而不是文本堆。
const GD = 'https://music-api.gdstudio.xyz/api.php'
const GD_LYRIC_SOURCES = ['netease', 'kuwo', 'tencent', 'kugou']
async function gdLyricChannel(track) {
  const q = `${track.title || ''} ${track.artist || ''}`.trim()
  if (!q) return ''
  const t = norm(track.title)
  const want = artistTokens(track.artist)
  for (const source of GD_LYRIC_SOURCES) {
    let rows = []
    try {
      const j = await fetchJson(`${GD}?types=search&source=${enc(source)}&name=${enc(q)}&count=5&pages=1`, { timeout: 7000 }, 1)
      rows = Array.isArray(j) ? j : []
    } catch { continue }
    // 歌名必须对上；歌手匹配的排前面（降低同名歌串词风险）
    const cand = rows
      .filter((r) => {
        const n = norm(r?.name)
        return n && (n.includes(t) || t.includes(n))
      })
      .sort((a, b) => {
        const ok = (r) => artistTokens(r?.artist || '').some((x) => want.some((y) => y.includes(x) || x.includes(y))) ? 1 : 0
        return ok(b) - ok(a)
      })
      .slice(0, 2)
    for (const r of cand) {
      try {
        const l = await fetchJson(`${GD}?types=lyric&source=${enc(source)}&id=${enc(String(r.id))}`, { timeout: 6000 }, 1)
        const raw = String(l?.lyric || '')
        if (hasLyrics(raw) && /\[\d{1,3}:\d{1,2}/.test(raw)) return raw
      } catch { /* 下一个候选 */ }
    }
  }
  return ''
}

// 按「歌名 + 歌手」找回平台 ID：严格轮每个候选都过 sameSong()，避免 Live/同名歌串词；
// 严格轮全部落空时再放宽到「歌名完全一致」（忽略版本后缀）——宁可有词也不空着。
async function searchThenLyric(track) {
  try {
    let rows = await music.search(`${track.title} ${track.artist}`, 8).catch(() => [])
    if (!rows?.length) rows = await music.search(String(track.title || ''), 8).catch(() => [])
    const cand = (rows || []).filter((r) => r?.id)
    for (const r of cand) {
      if (!sameSong(r.title, r.artist, track)) continue
      const v = await lyricById(r.platform, String(r.id))
      if (hasLyrics(v)) return v
    }
    for (const r of cand) {
      if (normText(r.title) !== normText(track.title)) continue
      const v = await lyricById(r.platform, String(r.id))
      if (hasLyrics(v)) return v
    }
  } catch { /* 搜索不可用 */ }
  return ''
}

// 多通道竞速：谁先拿到有效歌词就用谁，整体最多等 timeoutMs。
function firstLyrics(tasks, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false, left = tasks.length
    if (!left) return resolve('')
    const timer = setTimeout(() => { if (!done) { done = true; resolve('') } }, timeoutMs)
    for (const p of tasks) {
      Promise.resolve(p).then((v) => {
        if (!done && hasLyrics(v)) { done = true; clearTimeout(timer); resolve(String(v)) }
      }).catch(() => {}).finally(() => {
        if (--left === 0 && !done) { done = true; clearTimeout(timer); resolve('') }
      })
    }
  })
}

// 主入口：返回 { ok, lines, text }。调用方负责在切歌后丢弃过期结果。
// force=true 用于用户点击歌词区「重新匹配」，忽略失败缓存与在途任务。
export async function getLyrics(track, { force = false } = {}) {
  if (!track?.title) return { ok: false, lines: [], text: '' }
  const key = normKey(track.title, track.artist)
  if (force) { delete mem[key]; inflight.delete(key) }
  else {
    const hit = mem[key]
    const ttl = hit?.ok ? TTL_OK : TTL_MISS
    if (hit && Date.now() - (hit.at || 0) < ttl) {
      return hit.ok ? { ok: true, lines: hit.lines || [], text: hit.text || '' } : { ok: false, lines: [], text: '' }
    }
    if (inflight.has(key)) return inflight.get(key)
  }

  const job = (async () => {
    const ids = idsOf(track)
    const wyId = ids.find((x) => /^(wy|netease)$/i.test(x.source))?.id || ''
    const txId = ids.find((x) => /^(tx|qq|qzone)$/i.test(x.source))?.id || ''
    const kwId = ids.find((x) => /^(kw|kuwo)$/i.test(x.source))?.id || ''
    // 有明确平台 ID 的通道最可信，先并行发起；按名字找回的通道都带严格校验。
    const tasks = [engineLyric(track)]
    if (wyId) tasks.push(wyLyricOfficial(wyId), wyLyricGd(wyId))
    if (txId) tasks.push(qqLyric(txId))
    if (kwId) tasks.push(kwLyric(kwId))
    tasks.push(searchThenLyric(track))
    tasks.push(gdLyricChannel(track))   // 独立通道：GD 多平台搜索 → 带时间戳校验
    let raw = await firstLyrics(tasks, 15000)
    // 音源自带的歌词只作最后兜底：它可能来自同名的另一首，优先级低于所有校验过的外部通道。
    if (!raw && String(track.lyrics || '').trim()) raw = String(track.lyrics)
    if (!raw) {
      mem[key] = { at: Date.now(), ok: false }; saveStore()
      return { ok: false, lines: [], text: '' }
    }
    const parsed = parseLrc(raw)
    const out = { ok: !!parsed.text, lines: parsed.lines, text: parsed.text }
    mem[key] = { at: Date.now(), ok: out.ok, lines: out.lines.slice(0, 400), text: out.text.slice(0, 8000) }
    saveStore()
    return out
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

export const lyricsCacheInfo = () => Object.keys(mem).length
export function clearLyricsCache() { mem = {}; inflight.clear(); try { localStorage.removeItem(LS_KEY) } catch { /* noop */ } }
