import { qualityRank } from '../protocol/model.js'
import { native } from '../protocol/bridge.js'

// 音质完美 = 多源聚合同一首歌的所有候选流，按 lossless > 320k > 192k > 128k 排序，
// 逐条尝试播放，失败自动降级；全程不静默失败，全部失败才报错。
//
// 优先级规则（对应「播放音质按用户选择，无源时按音质从高到低」）：
//   · auto                 → 直接从最高档往最低档依次尝试
//   · 用户指定某一档       → 该档的所有候选先试；这一档「无源」时，
//                            其余候选**仍按音质从高到低**依次尝试，保证尽量播到最好的那条
// 用户选择永远是第一优先级，不会被更高档的链接抢先。
const TIERS = ['lossless', 'hq', 'sq', 'lq']
let preferred = 'auto'

export const setPreferred = (q) => { preferred = TIERS.includes(q) ? q : 'auto' }
export const getPreferred = () => preferred
export const isTier = (q) => TIERS.includes(q)

export function rankCandidates(track) {
  return (track.streams || []).slice().sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
}

// 本曲实际可用的档位（去重、按音质降序），用于界面上解释「为什么播的是这一档」
export function availableTiers(track) {
  return [...new Set((track.streams || []).map((s) => s.quality).filter(isTier))]
    .sort((a, b) => qualityRank(b) - qualityRank(a))
}

// 链接「可信度」：官方 CDN 直连 vs 第三方中转。
// 聚合音源（GitHub 脚本）给的常常是别人家的中转站（yy.zddyr.top / yinyue.haitangw.net 等），
// 探测头能过、真放却 403/超时。所以只要有一条官方 CDN 的链接，就先播它，
// 哪怕档位低一档 —— 用户要的是「点下去就有声」，不是「音质标着无损但放不出来」。
const TRUSTED_HOST = /(^|\.)(music\.126\.net|music\.163\.com|qqmusic\.qq\.com|stream\.qqmusic\.qq\.com|kuwo\.cn|kugou\.com|migu\.cn|music\.migu\.cn)$/i
export function trustRank(url) {
  try { return TRUSTED_HOST.test(new URL(String(url)).hostname) ? 1 : 0 } catch { return 0 }
}

export function orderStreams(track, pref = preferred) {
  // 空 / 非法 URL 的候选直接丢掉：否则 audio.src='' 会抛
  // 「The element has no supported sources」，把整条降级链误判成「无可用音源」。
  const valid = (s) => !!s && /^https?:\/\/|^blob:|^file:/i.test(String(s.url || ''))
  // 先按「可信 CDN 优先」，同信任级别内按音质从高到低；用户指定档位时该档整体前置。
  const list = (track.streams || []).filter(valid)
    .sort((a, b) => (trustRank(b.url) - trustRank(a.url)) || (qualityRank(b.quality) - qualityRank(a.quality)))
  if (!pref || pref === 'auto' || !isTier(pref)) return list
  return [...list.filter((s) => s.quality === pref), ...list.filter((s) => s.quality !== pref)]
}

export function mergeCandidates(tracks) {
  const map = new Map()
  for (const t of tracks) {
    const hit = map.get(t.key)
    if (!hit) { map.set(t.key, { ...t, streams: [...t.streams] }); continue }
    hit.streams = rankCandidates({ streams: [...hit.streams, ...t.streams] })
    if (!hit.lyrics && t.lyrics) hit.lyrics = t.lyrics
    if (!hit.cover && t.cover) hit.cover = t.cover
  }
  return [...map.values()]
}

export async function playWithFallback(track, positionMs = 0, pref = preferred) {
  const errors = []
  // 单次尝试（一本曲目的所有候选链接）预算 12 秒；整体超过就交给上层「换源重试 / 跳过下一首」。
  // 现在上层还会换平台重试，所以这里不能拖太久，否则一首死歌要等半分钟。
  const deadline = Date.now() + 15000
  for (const s of orderStreams(track, pref)) {
    if (Date.now() > deadline) { errors.push('超时'); break }
    try {
      await native.play({ ...track, playUrl: s.url, quality: s.quality }, positionMs)
      return s
    } catch (e) {
      errors.push(`${s.quality}: ${e.message}`)
    }
  }
  const usable = orderStreams(track, pref)
  if (!usable.length) throw new Error('这首暂时没有可用的播放链接')
  throw new Error(`暂时无法播放：${errors[errors.length - 1] || '无可用链接'}（已试 ${errors.length} 条链路）`)
}
