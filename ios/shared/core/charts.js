// 各大音乐平台榜单目录 + 板块智能匹配引擎。
// 这里只收录「榜单名称 / 平台 / 地区 / 曲风」等公开元数据；真实曲目由 chart-tracks.js
// 从 QQ / 网易云 / 酷狗的公开榜单接口取，没有对应接口的榜用同曲风池补齐。
import { chartTracks, hasRealTracks } from './chart-tracks.js'
import { poolOf, tasteOf } from './genre-pool.js'

const PLATFORM = Object.freeze({
  tx: 'QQ音乐', wy: '网易云音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐',
  dy: '抖音', bb: 'Billboard', or: 'Oricon', sp: 'Spotify', uk: 'UK Charts', kr: 'Melon / Circle',
})

// source | 榜名 | boardId | 地区 | 曲风 | 标签（逗号分隔）
const RAW = `
tx|巅峰榜·热歌|tx_hot|华语|流行|热歌,巅峰,流行,全网
tx|巅峰榜·新歌|tx_new|华语|新歌|新歌,首发,巅峰
tx|巅峰榜·飙升|tx_soar|华语|飙升|飙升,涨幅,巅峰
tx|巅峰榜·内地|tx_cn|华语|流行|内地,华语,地区
tx|巅峰榜·港台|tx_hkt|华语|流行|港台,粤语,地区
tx|巅峰榜·欧美|tx_west|欧美|流行|欧美,地区,Western
tx|巅峰榜·日本|tx_jp|日本|流行|日本,J-Pop,地区
tx|巅峰榜·韩国|tx_kr|韩国|流行|韩国,K-Pop,地区
tx|巅峰榜·古典|tx_classic|全球|古典|古典,器乐,曲风
tx|巅峰榜·电音|tx_edm|全球|电音|电音,EDM,曲风
tx|巅峰榜·ACG|tx_acg|全球|ACG|ACG,二次元,曲风
tx|巅峰榜·抖音|tx_douyin|华语|网络|抖音,短视频,曲风
tx|巅峰榜·K歌|tx_ktv|华语|流行|K歌,翻唱,曲风
wy|云音乐飙升榜|wy_soar|华语|飙升|飙升,涨幅,新歌
wy|云音乐新歌榜|wy_new|华语|新歌|新歌,首发
wy|云音乐热歌榜|wy_hot|华语|流行|热歌,流行
wy|云音乐原创榜|wy_original|华语|民谣|原创,独立,民谣
wy|云音乐说唱榜|wy_hiphop|全球|说唱|说唱,HipHop,曲风
wy|云音乐国电榜|wy_edm|华语|电音|电音,国电,曲风
wy|云音乐ACG榜|wy_acg|全球|ACG|ACG,二次元,曲风
kg|酷狗 TOP500|kg_top500|华语|流行|热歌,TOP,全网
kg|酷狗飙升榜|kg_soar|华语|飙升|飙升,涨幅
kg|华语新歌榜|kg_cn_new|华语|新歌|华语,新歌,首发
kg|欧美金曲榜|kg_west|欧美|流行|欧美,金曲,地区
kg|抖音热歌榜|kg_douyin|华语|网络|抖音,短视频,曲风
kg|ACG 新歌榜|kg_acg|全球|ACG|ACG,新歌,曲风
kw|酷我热歌榜|kw_hot|华语|流行|热歌,流行
kw|酷我飙升榜|kw_soar|华语|飙升|飙升,涨幅
kw|酷我华语榜|kw_cn|华语|流行|华语,地区
kw|酷我欧美榜|kw_west|欧美|流行|欧美,地区
kw|酷我日韩榜|kw_jpkr|日本|流行|日韩,地区,J-Pop
kw|DJ 舞曲榜|kw_dj|全球|电音|DJ,舞曲,电音,曲风
kw|古风热歌榜|kw_gufeng|华语|古风|古风,国风,曲风
mg|尖叫·热歌榜|mg_hot|华语|流行|热歌,流行
mg|尖叫·新歌榜|mg_new|华语|新歌|新歌,首发
mg|尖叫·原创榜|mg_original|华语|民谣|原创,独立
mg|视频彩铃榜|mg_ring|华语|网络|彩铃,短视频
dy|抖音热歌榜|dy_hot|华语|网络|抖音,短视频,热歌
dy|抖音飙升榜|dy_soar|华语|飙升|抖音,飙升,短视频
bb|Billboard Hot 100|bb_hot100|欧美|流行|欧美,Billboard,Hot100,地区
bb|Billboard Global 200|bb_global200|全球|流行|全球,Global,World
bb|Billboard 200|bb_200|欧美|流行|欧美,专辑,Billboard
or|Oricon 周榜单曲|or_weekly|日本|流行|日本,Oricon,公信榜,地区
sp|Spotify 全球 Top 50|sp_global50|全球|流行|全球,Spotify,World
sp|Spotify 华语热播|sp_cn50|华语|流行|华语,Spotify,地区
uk|UK Singles Chart|uk_singles|欧美|流行|欧美,UK,地区
kr|Melon 实时榜|kr_realtime|韩国|流行|韩国,K-Pop,Melon,地区
kr|Circle Chart 周榜|kr_circle|韩国|流行|韩国,Circle,地区
`.trim().split('\n').filter((l) => l.trim())

export const CHARTS_ALL = Object.freeze(RAW.map((line, i) => {
  const [source, name, boardId, region, genre, tags] = line.split('|')
  return { id: `${source}_${boardId}`, no: i + 1, source, platform: PLATFORM[source] || source,
    name, boardId, region, genre, tags: (tags || '').split(',').filter(Boolean) }
}))

// 板块规则：与 QQ 音乐「排行榜」分组一致。分数越高归属越明确，同时给出可解释理由。
export const BOARD_SECTIONS = Object.freeze([
  { id: 'peak', name: '巅峰榜 · 全网热歌', hint: '各平台主榜与综合热歌', nameKw: ['巅峰', '热歌', 'TOP', '金曲', '尖叫'], tags: ['热歌', '巅峰', '全网'] },
  { id: 'rise', name: '飙升 · 新歌首发', hint: '涨幅榜、新歌榜、原创榜', nameKw: ['飙升', '新歌', '首发', '原创', '涨幅'], tags: ['飙升', '新歌', '首发'] },
  { id: 'genre', name: '特色 · 曲风榜', hint: '抖音 / 电音 / 说唱 / ACG / 古风 / 古典', nameKw: ['抖音', '电音', '说唱', 'ACG', '古风', '古典', '摇滚', '爵士', '民谣', 'DJ', '舞曲', 'K歌', '彩铃', '国风', '二次元'], tags: ['曲风', 'ACG', '抖音', '电音', '国风'] },
  { id: 'cn', name: '华语地区榜', hint: '内地 / 港台 / 华语', nameKw: ['内地', '华语', '港台', '国语', '粤语', '中文', '中国'], region: '华语', tags: ['地区', '华语'] },
  { id: 'jpkr', name: '日韩地区榜', hint: '日本 / 韩国 / 公信榜', nameKw: ['日本', '日韩', '韩国', 'Oricon', '公信', 'Melon', 'Circle', 'K-Pop', 'J-Pop'], regionIn: ['日本', '韩国'], tags: ['地区', '日韩'] },
  { id: 'west', name: '欧美地区榜', hint: 'Billboard / UK / 欧美', nameKw: ['欧美', 'Billboard', 'Hot 100', 'UK', 'Western', '金曲'], region: '欧美', tags: ['地区', '欧美'] },
  { id: 'global', name: '全球榜', hint: 'Global 200 / Spotify 全球', nameKw: ['全球', 'Global', 'World', 'Spotify'], region: '全球', tags: ['全球', 'World'] },
])

function score(chart, rule) {
  let s = 0
  const why = []
  for (const kw of rule.nameKw || []) if (chart.name.includes(kw)) { s += 7; why.push(`榜名含「${kw}」`) }
  for (const t of rule.tags || []) if (chart.tags.includes(t)) { s += 4; why.push(`标签「${t}」`) }
  if (rule.region && chart.region === rule.region) { s += 5; why.push(`地区「${chart.region}」`) }
  if (rule.regionIn?.includes(chart.region)) { s += 5; why.push(`地区「${chart.region}」`) }
  if (rule.genre && chart.genre === rule.genre) { s += 3; why.push(`曲风「${chart.genre}」`) }
  // 「巅峰榜·飙升」这类复合名：最后一个 · 之后是更具体的定性词，优先级高于前缀系列名。
  const tail = chart.name.includes('·') ? chart.name.split('·').pop() : ''
  if (tail && (rule.nameKw || []).some((kw) => tail.includes(kw))) { s += 5; why.push(`尾缀「${tail}」`) }
  return { s, why: why.slice(0, 3) }
}

export function matchChart(chart) {
  // 置信度 = 与「次优板块」的相对分差；两者接近时明确标注歧义，而不是一律 100%。
  const ranked = BOARD_SECTIONS.map((rule) => ({ id: rule.id, ...score(chart, rule) }))
    .sort((a, b) => b.s - a.s)
  const best = ranked[0], second = ranked[1]
  if (!best || best.s < 4) return { section: 'peak', score: best?.s || 0, confidence: 0.2, reasons: ['未命中关键词，按平台默认归档'] }
  const reasons = [...best.why]
  const confidence = +Math.min(1, best.s / (best.s + (second?.s || 0) || 1)).toFixed(2)
  if (confidence < 0.8 && second?.s > 0) reasons.push(`次选「${BOARD_SECTIONS.find((s) => s.id === second.id)?.name}」`)
  return { section: best.id, score: best.s, confidence, reasons }
}

// 每个板块最多展示几个榜。以前 48 个榜里大量是「同一曲风 + 同一地区」的马甲榜，
// 没有真实接口的那些又都从同一个曲风池补齐，结果一屏出现七八张一模一样的封面。
const MAX_PER_GROUP = 4

export function groupedBoards() {
  const groups = BOARD_SECTIONS.map((s) => ({ ...s, charts: [] }))
  for (const c of CHARTS_ALL) {
    const m = matchChart(c)
    const g = groups.find((x) => x.id === m.section) || groups[0]
    g.charts.push({ ...c, match: m })
  }
  for (const g of groups) {
    // 有真实榜单接口的优先保留（曲目各不相同），其次按匹配分；同池的无源榜只留一个。
    g.charts.sort((a, b) =>
      (Number(hasRealTracks(b)) - Number(hasRealTracks(a))) ||
      b.match.score - a.match.score || a.no - b.no)
    const seen = new Set()
    g.charts = g.charts.filter((c) => {
      if (hasRealTracks(c)) return true
      const sig = `${poolOf(c)}|${tasteOf(c)}`
      if (seen.has(sig)) return false
      seen.add(sig)
      return true
    }).slice(0, MAX_PER_GROUP)
  }
  return groups.filter((g) => g.charts.length)
}

export const findChart = (id) => CHARTS_ALL.find((c) => c.id === id) || null
// 首页「今日榜单」按板块轮转取样，避免整屏都是同一个板块。
// 传 real=true 时只取「能拿到真实曲目」的榜单（QQ / 网易云），这样每条榜单都能显示自己的封面轮播。
export function topCharts(n = 6, { real = false } = {}) {
  const groups = groupedBoards().map((g) => ({
    ...g,
    charts: real ? g.charts.filter((c) => hasRealTracks(c)) : g.charts,
  })).filter((g) => g.charts.length)
  const out = []
  for (let i = 0; out.length < n; i++) {
    let added = false
    for (const g of groups) if (g.charts[i]) { out.push(g.charts[i]); added = true; if (out.length >= n) break }
    if (!added) break
  }
  return out
}

// 榜单词云 → 热搜词 / 歌单分类 / 推荐标签（板块由榜单元数据反向驱动其它板块）。
export function chartKeywords() {
  const freq = new Map()
  for (const c of CHARTS_ALL) for (const t of c.tags) freq.set(t, (freq.get(t) || 0) + 1)
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
}
export const hotSearches = (n = 10) => chartKeywords().filter((t) => !['地区', '曲风', '全网'].includes(t)).slice(0, n)
export const genreCategories = () => [...new Set(CHARTS_ALL.map((c) => c.genre).filter((g) => g && g !== '流行'))].slice(0, 12)

export async function loadChartTracks(chart) {
  // 只走公开榜单接口（QQ / 网易云 / 酷狗聚合），不再支持旧的自建端点 / LX 脚本。
  const tracks = await chartTracks(chart, { limit: 30 }).catch(() => [])
  return {
    rows: tracks.map((t) => ({
      name: t.title, singer: t.artist, album: t.album || '',
      songmid: t.pending?.id || '', hash: '', source: t.pending?.source || chart.source,
      cover: t.cover || '', picId: t.pending?.picId || '', durationMs: t.durationMs || 0,
      tags: chart.tags,
    })),
    configured: false, real: tracks.length > 0,
  }
}
