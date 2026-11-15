/**
 * 播放直链缓存池（内存 + localStorage 双层）
 *
 * 解决的问题：每次点歌都要重新走「搜索元数据 → 多平台取链」的链路，
 * 一首歌 2~8 秒起步；列表里来回切歌时体验很差。
 *
 * 策略：
 *   · 命中缓存直接返回（毫秒级），播放失败时由上层换源重试并覆盖缓存；
 *   · 直链有效期按 30 分钟算（各平台签名链接普遍 20 分钟以上），过期自动丢弃；
 *   · 取链失败的曲目进「冷却名单」，10 分钟内不再反复重试，避免整列死歌把 UI 拖住；
 *   · 最多存 300 条，超了按最久未使用淘汰（localStorage 不能无限长）。
 */

const LS_KEY = 'orangemusic:streams'
// 直链有效期：酷我 / 波点的签名地址（bd-*.kuwo.cn/<md5>/<hex>/...）实测半小时内就会失效，
// 以前按 30 分钟算，于是「上一轮缓存的链还在 TTL 里、其实已经过期」→ 界面显示在播却没声音，
// 而且缓存落盘，重启软件照样复用这条死链。压到 10 分钟，播放失败时还会主动作废。
const TTL = 10 * 60 * 1000
const FAIL_TTL = 90 * 1000        // 失败冷却：缩短到 90 秒，有问题的歌过一会儿还会再试
const MAX_ENTRIES = 300
// 缓存格式版本：v2 起只收「解析 + 校验过」的直链；
// v3 起只收「正式发行版」的直链；
// v4 起每个条目绑定「平台+ID」指纹（idfp）—— 同一个歌名|歌手在各平台有原版/片段/
// 电音改编各自独立的 ID，只按歌名做 key 会把错 ID 的链接固化下来，点「哼」一直播电音版。
// 每次升级整批作废旧缓存，让上层重新取链并做身份反查。
const VER = 4

// 「平台+ID」指纹：缓存读取时核对，对不上说明这是给另一个 ID 存的链，作废
export const idFingerprint = (mi) => (mi?.id ? `${mi.source || 'wy'}|${mi.id}` : '')

const mem = new Map()   // key -> { streams, source, at }
let fails = new Map()   // key -> ts
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const obj = JSON.parse(raw)
    const now = Date.now()
    for (const [k, v] of Object.entries(obj?.streams || {})) {
      if (v && Array.isArray(v.streams) && v.streams.length && now - (v.at || 0) < TTL) mem.set(k, v)
    }
    for (const [k, ts] of Object.entries(obj?.fails || {})) {
      if (now - (ts || 0) < FAIL_TTL) fails.set(k, ts)
    }
  } catch { /* 存档损坏就当空的 */ }
}

let saveTimer = 0
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      // 超出上限：按写入时间淘汰最旧的
      if (mem.size > MAX_ENTRIES) {
        const sorted = [...mem.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
        for (const [k] of sorted.slice(0, mem.size - MAX_ENTRIES)) mem.delete(k)
      }
      localStorage.setItem(LS_KEY, JSON.stringify({
        streams: Object.fromEntries(mem),
        fails: Object.fromEntries(fails),
      }))
    } catch { /* 配额满 / 隐私模式：只留内存缓存 */ }
  }, 600)
}

const valid = (s) => s && /^https?:\/\//i.test(String(s.url || ''))

/** 取缓存直链；没有 / 过期 / ID 指纹对不上 返回 null */
export function cachedStreams(key, idfp = '') {
  if (!key) return null
  load()
  const hit = mem.get(key)
  if (!hit) return null
  if (hit.v !== VER) { mem.delete(key); save(); return null }   // 旧格式（未校验）作废
  // 指纹对不上：这条链是给「同名但不同 ID」的版本存的（例如原版 key 命中了电音版缓存），
  // 必须作废重新取链，否则点原版一直播电音版。
  if (idfp && hit.idfp && hit.idfp !== idfp) { mem.delete(key); save(); return null }
  if (Date.now() - (hit.at || 0) > TTL) { mem.delete(key); save(); return null }
  const streams = (hit.streams || []).filter(valid)
  if (!streams.length) { mem.delete(key); return null }
  // 命中即刷新使用时间（近似 LRU）
  hit.at = Date.now()
  return streams
}

/** 写入/覆盖缓存（带来源平台 + ID 指纹） */
export function rememberStreams(key, streams, source = '', idfp = '') {
  if (!key || !Array.isArray(streams) || !streams.length) return
  const clean = streams.filter(valid).map((s) => ({ url: s.url, quality: s.quality }))
  if (!clean.length) return
  load()
  mem.set(key, { streams: clean, source, idfp, at: Date.now(), v: VER })
  fails.delete(key)
  save()
}

/** 记一次取链失败（进冷却名单） */
export function markStreamFail(key) {
  if (!key) return
  load()
  fails.set(key, Date.now())
  save()
}

/** 是否处在失败冷却期内 */
export function isCoolingDown(key) {
  if (!key) return false
  load()
  const ts = fails.get(key)
  if (!ts) return false
  if (Date.now() - ts > FAIL_TTL) { fails.delete(key); return false }
  return true
}

/** 播放失败时废弃这首歌的直链缓存，下次必然重新取链（签名地址会过期，复用就是「在播但没声音」） */
export function forgetStreams(key) {
  if (!key) return
  load()
  if (mem.delete(key)) save()
}

export function clearStreamCache() {
  mem.clear()
  fails.clear()
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
}

export const streamCacheStats = () => {
  load()
  return { entries: mem.size, cooling: fails.size }
}
