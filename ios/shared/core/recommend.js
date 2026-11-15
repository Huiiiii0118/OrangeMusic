import { cloud, isLocalOnly } from './cloud.js'
import { recentEvents, addEvent, getState, setState, keys } from './repo.js'
import { searchAll } from './sources.js'
import { topCharts } from './charts.js'
import { chartTracks } from './chart-tracks.js'

// 实时动态推荐：行为事件 → 权重更新 → 云端 LLM 流式生成理由 → 写回共享缓存。
// 双端读同一份 recommend 缓存，切换设备后推荐状态不丢。
const WEIGHT = { play: 1, complete: 3, like: 5, skip: -4, seek: -2, import: 1 }
const MIN_INTERVAL_MS = 20000        // 限流，防止用户反复触发耗尽额度

// ── 按时段推荐 ────────────────────────────────────────────────────────
// 同一批歌单在不同时间点的「合适度」差别很大：清晨要轻快、午后要提神、深夜要安静。
// 这里给每个时段配一个检索种子（拼进候选池）与一个偏好词表（给召回结果加分），
// 并把 band 写进推荐缓存：跨时段会自动重算，不用等用户手动刷新。
const PERIODS = [
  { id: 'dawn', from: 0, to: 5, seed: '深夜 安静 慢歌', words: ['安静', '治愈', '轻音乐', '情歌', '伤感', '钢琴'], tip: '夜里适合慢一点的' },
  { id: 'morning', from: 5, to: 9, seed: '清晨 轻快 流行', words: ['轻快', '流行', '治愈', '甜歌', '华语'], tip: '早上来点轻快的' },
  { id: 'forenoon', from: 9, to: 12, seed: '通勤 民谣 华语', words: ['民谣', '华语', '流行', '经典'], tip: '上午顺手听点顺耳的' },
  { id: 'noon', from: 12, to: 14, seed: '午休 舒缓 轻音乐', words: ['舒缓', '轻音乐', '治愈', '钢琴', '安静'], tip: '午休放点舒缓的' },
  { id: 'afternoon', from: 14, to: 18, seed: '活力 节奏 摇滚', words: ['节奏', '摇滚', '电子', '舞曲', 'DJ', '活力'], tip: '下午需要提提神' },
  { id: 'evening', from: 18, to: 22, seed: '放松 温柔 流行', words: ['温柔', '流行', '华语', '情歌', '治愈'], tip: '晚上放松一下' },
  { id: 'night', from: 22, to: 24, seed: '夜晚 氛围 慢歌', words: ['安静', '感人', '慢歌', '情歌', '治愈', '轻音乐'], tip: '夜深了听点安静的' },
]
export function periodOf(hour = new Date().getHours()) {
  const h = Number(hour) || 0
  return PERIODS.find((p) => h >= p.from && h < p.to) || PERIODS[6]
}
const periodRank = (t, period) => (t.tags || []).reduce((n, tag) => {
  const s = String(tag)
  return n + (period.words.some((w) => s.includes(w)) ? 1 : 0)
}, 0)
let lastRun = 0

export const trackEvent = (kind, trackKey, tags = []) =>
  addEvent(kind, trackKey, tags, WEIGHT[kind] ?? 1)

function affinity(events) {
  const w = new Map()
  for (const e of events) {
    for (const tag of e.tags || []) w.set(tag, (w.get(tag) || 0) + Number(e.weight || 0))
  }
  return [...w.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag]) => tag)
}

function localRecall(events, pool) {
  const tags = affinity(events)
  const heard = new Set(events.map((e) => e.track_key).filter(Boolean))
  return pool
    .filter((t) => !heard.has(t.key))
    .map((t) => ({ ...t, score: (t.tags || []).reduce((n, x) => n + (tags.includes(x) ? 2 : 0), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 12)
}

// 各大站点的「猜你喜欢」本质上是「同类型（曲风 / 标签）」推荐，而不是「同歌手」——
// 即同一个曲风池子里尽量铺开不同歌手，避免一屏全是同一个人的歌。
// 这里把偏好标签收敛成「曲风词」，剔除平台标签（QQ 音乐 / 网易云）和歌手名，作为检索种子。
const GENRE_WORDS = ['华语', '流行', '轻音乐', '经典', '老歌', '摇滚', '民谣', '电子', '电音', '说唱', 'rap',
  '古风', '国风', '古典', '爵士', '抖音', 'ACG', '二次元', '欧美', '日韩', 'K-Pop', 'J-Pop', '舞曲', 'DJ',
  '治愈', '伤感', '甜歌', '情歌', '影视', '游戏', '韩语', '日语', '粤语', '怀旧']
function genreSeeds(events) {
  const genres = affinity(events).filter((t) => GENRE_WORDS.some((w) => String(t).includes(w)))
  return genres.length ? genres.slice(0, 3) : ['华语流行', '轻音乐', '经典老歌']
}

// 同类型 ≠ 同歌手：按分数排序后，限制每个歌手最多 2 首，把位置让给不同歌手的同类型歌。
function diversify(picks, maxPerArtist = 2) {
  const byArtist = new Map()
  const out = []
  for (const t of [...picks].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const a = String(t.artist || '').split(/\s*\/\s*/)[0].trim().toLowerCase()
    const used = byArtist.get(a) || 0
    if (a && used >= maxPerArtist) continue
    byArtist.set(a, used + 1)
    out.push(t)
  }
  // 去重后不足时放宽限制补齐
  if (out.length < 12) {
    const seen = new Set(out.map((t) => t.key))
    for (const t of picks) if (!seen.has(t.key)) { out.push(t); if (out.length >= 12) break }
  }
  return out.slice(0, 12)
}

async function llmReason(tags, tracks) {
  if (isLocalOnly()) return null    // 离线试用：只做本地召回，不调用模型
  const models = await cloud.llm.models.list()
  const model = models.find((m) => m.disabled !== true)
  if (!model) return null
  let answer = ''
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: 'system', content: '你是音乐推荐助手。只输出 JSON：{"reasons":[{"key":"...","text":"不超过20字的推荐理由"}]}。不要编造曲目信息，只解释给定列表。' },
      { role: 'user', content: `偏好标签：${tags.join('、') || '暂无'}。候选：${JSON.stringify(tracks.map((t) => ({ key: t.key, title: t.title, tags: t.tags })).slice(0, 20))}` },
    ],
    stream: true,
    response_format: { type: 'json_object' },
    temperature: 0.6,
  })) {
    const d = chunk.choices[0]?.delta?.content
    if (d) answer += d
  }
  try { return JSON.parse(answer).reasons || [] } catch { return [] }
}

export async function refreshRecommend(force = false) {
  const now = Date.now()
  const period = periodOf()
  if (!force && now - lastRun < MIN_INTERVAL_MS) {
    const cached = await getState(keys.recommend)
    // 时段变了（下午→晚上）就别用旧缓存，重算一批
    if (cached && cached.band === period.id) return cached
    if (!cached) return cached
  }
  lastRun = now

  const events = await recentEvents(80)
  const tags = affinity(events)
  // 候选池来自公开音源检索；种子收敛成「曲风词」，保证推荐的是同类型而不是同歌手。
  // 再拼一个时段种子：同一份口味，清晨给轻快、深夜给安静。
  const seeds = [...genreSeeds(events).slice(0, 3), period.seed]
  const batches = await Promise.all(seeds.map((s) => searchAll(s).catch(() => [])))
  const pool = [...new Map(batches.flat().map((t) => [t.key, t])).values()]

  let picks = localRecall(events, pool)
  if (!picks.length) picks = pool.slice(0, 12)   // 都听过了/没有行为数据时，直接给一批新歌
  // 同分时按时段偏好靠前：不改变「口味优先」，只在该时段更合气氛的歌往前挪。
  picks = picks
    .map((t, i) => ({ t, i, p: periodRank(t, period) }))
    .sort((a, b) => (b.p - a.p) || (a.i - b.i))
    .map((x) => x.t)
  // 同类型不同歌手：限制每个歌手最多 2 首，避免推荐被单一歌手占据。
  picks = diversify(picks)
  // 公开搜索被限流时（网易云偶发「操作频繁」）池子会是空的。
  // 此时用真实榜单曲目兜底：有封面、有 songmid，点开就能播，首页不会出现「正在准备推荐…」。
  if (picks.length < 4) {
    const lanes = await Promise.all(
      topCharts(4, { real: true }).map((c) => chartTracks(c, { limit: 6 }).catch(() => [])),
    )
    const fill = lanes.flat().filter((t) => t?.title)
    const seen = new Set(picks.map((t) => t.key))
    picks = [...picks, ...fill.filter((t) => !seen.has(t.key))].slice(0, 12)
  }
  let reasons = []
  try { reasons = (await llmReason(tags, picks)) || [] } catch { /* 模型不可用时保留本地召回 */ }
  const reasonMap = new Map(reasons.map((r) => [r.key, String(r.text || '').slice(0, 20)]))
  picks = picks.map((t) => ({ ...t, reason: reasonMap.get(t.key) || '按你最近的收听偏好' }))

  const payload = { tracks: picks, tags, band: period.id, bandTip: period.tip, updatedAt: new Date().toISOString() }
  await setState(keys.recommend, payload)
  return payload
}

export const cachedRecommend = () => getState(keys.recommend)
