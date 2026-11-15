// 「只要正式发行的版本」判定层。
//
// 实测问题（以「玻璃糖」为例）：各平台公开搜索会把同名翻唱、伴奏、Remix、
// 音效试音、DJ 版、Live、片段和别的歌一起返回：
//   QQ  → 《玻璃糖-徐梦圆/冯提莫》3DO音效耳机版 / 玻璃糖 (Peter Li Remix) / 玻璃糖 (零6 MIX)
//   网易 → 玻璃糖 (Instrumental) / 玻璃糖（prod by Crazy Yan)
//   酷我 → 玻璃糖 (cover: 徐梦圆|冯提莫) / 玻璃糖（Cover：徐梦圆），还有一堆同名不同歌手的翻唱
// 再加上「跨平台兜底」以前直接取搜索结果第一条，不校验歌名和歌手，
// 于是界面显示「玻璃糖」，实际播出去的是别人的歌 —— 这就是歌名与歌曲不符的主因。
//
// 本模块提供三件事：
//   ① officialVerdict()：判断一条元数据是不是「正式发行的原版」
//   ② filterOfficial()：所有列表入口统一过滤
//   ③ sameTrack()：换源/跨平台时严格核对「歌名 + 歌手」，杜绝串歌
// 只做元数据判定，不接触音频内容、不做任何破解。

const LS_KEY = 'orangemusic:officialOnly'
let enabled = null

/** 用户开关：默认开启「只听正式发行版」。关掉后恢复成不过滤的旧行为。 */
export function isOfficialOnly() {
  if (enabled !== null) return enabled
  try { enabled = localStorage.getItem(LS_KEY) !== '0' } catch { enabled = true }
  return enabled
}
export function setOfficialOnly(on) {
  enabled = !!on
  try { localStorage.setItem(LS_KEY, enabled ? '1' : '0') } catch { /* 隐私模式 */ }
  return enabled
}

// ── 标题 / 歌手 / 专辑字段兼容：搜索 row 用 name/singer，播放 track 用 title/artist ──
export const nameOf = (r) => String(r?.name ?? r?.title ?? '')
export const singerOf = (r) => String(r?.singer ?? r?.artist ?? '')
export const albumOf = (r) => String(r?.albumName ?? r?.album ?? '')
export const durationOf = (r) => Number(r?.durationMs ?? r?.duration ?? 0) || 0

const clean = (s) => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ').trim()

// 括号（中/英/方/书名号）里的版本说明，以及 " - xxx" 形式的后缀。
// 版本标记几乎都写在这里，只在这里做「宽松匹配」可以大幅降低误杀正式歌名。
function tagsOf(title) {
  const tags = []
  const s = clean(title)
  for (const m of s.matchAll(/[（(【\[《]([^）)】\]》]*)[）)】\]》]/g)) tags.push(m[1])
  const dash = s.match(/\s[-–—~]\s*([^-–—~]{1,40})$/)
  if (dash) tags.push(dash[1])
  return tags.join(' ')
}
function bareOf(title) {
  return clean(title)
    .replace(/[（(【\[《][^）)】\]》]*[）)】\]》]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// 括号 / 后缀里的禁用词：出现任意一个就判定不是原版。
// 英文单词用 \b 边界，避免误伤 "lively"、"coverage"、"djent" 这类正常歌名。
const BAN_TAG = new RegExp([
  // 伴奏 / 纯音乐 / 卡拉 OK
  '伴奏', '纯伴奏', '纯音乐', '无伴唱', '伴唱带', 'off\\s*vocal', 'instrumental',
  'karaoke', '卡拉\\s*ok', '清唱', 'acappella', '消音', '和声版', '无和声',
  // 片段 / 非正式 / 试音
  '试听', '片段', '截取', '剪辑', '抢先', '饭制', '未发行', '小样', '铃声', '彩铃',
  'preview', 'snippet', 'teaser', 'tv\\s*size', 'tv版', '片头', '片尾', '念白', '口白',
  '音效', '耳机版', '3d', '3do', '煲机', '试音', 'demo',
  // Remix / 电音 / 变速 / 串烧
  'remix', '混音', '电音', '\\bdj\\b', '舞曲', '慢摇', '串烧', 'mashup', 'bootleg',
  'rework', 'radio\\s*edit', '\\bmix\\b', 'sped\\s*up', 'slowed', 'nightcore', '\\b8d\\b',
  '加速', '变速', '降调', '升调', '变调', '倍速', '抖音版', '快手版', '改编', '翻奏',
  // 现场 / 翻唱 / 同名 Cover
  '\\blive\\b', '现场', '演唱会', '翻唱', '\\bcover\\b', '翻自', '致敬版',
  '原唱\\s*[:：]', '原声\\s*[:：]',
  // 器乐改编版
  '钢琴版', '吉他版', '小提琴版', '古筝版', '口哨版', '器乐版',
].join('|'), 'i')

// 标题主体里的禁用词：必须足够「成词」，否则会误杀正式歌名。
const BAN_TITLE = new RegExp([
  '伴奏', '纯伴奏', '试听版', '试听', '片段版', '片段', '剪辑版', '串烧',
  '电音版', '\\bdj\\s*版\\b', 'dj版', '舞曲版', '加速版', '变速版', '降调版', '升调版',
  '抖音版', '快手版', '现场版', '演唱会版', '翻唱版', '消音版', '和声版', '无和声',
  '清唱版', '钢琴版', '吉他版', '音效', '耳机版', '煲机', '试音', '3do',
  '\\bremix\\b', '\\binstrumental\\b', '\\bkaraoke\\b', '\\bmashup\\b',
  '\\bbootleg\\b', 'sped\\s*up', '\\bslowed\\b', '\\bnightcore\\b',
].join('|'), 'i')

// 专辑名也是很强的信号：GD 返回过 album「徐梦圆 纯音乐版」对应 Instrumental 曲目。
const BAN_ALBUM = /(纯音乐版|纯伴奏|伴奏专辑|伴奏合集|remix|混音|dj版|串烧|翻唱合集|试音碟|音效测试|3do|煲机)/i

// 明确标注「原版 / 正式版」的，算加分（排序时排前），但挡不住上面的禁用词。
const ALLOW_TAG = /(原版|正式版|专辑版|完整版|录音室版|原唱版|发行版|单曲版|original|official|studio|album version)/i
// 兜底规则：括号里出现「XX版 / XX version / prod by / XX组合」，
// 而又没有明确写「原版·正式版·专辑版」的，一律当成改编版本。
// 实测漏网样本：「玻璃糖(超甜姐弟版)」「玻璃糖(彩虹糖组合)」「玻璃糖（prod by Crazy Yan)」。
const EDITION_TAG = /(.+版|.+\bversion\b|prod\s*by|组合)/i

const MIN_FULL_MS = 75000     // 短于 75 秒基本是试听片段 / 铃声
const MAX_TRACK_MS = 900000    // 长于 15 分钟基本是串烧 / 合集

/** 判定一条元数据是否为正式发行的原版。返回 { ok, why, tag }。 */
export function officialVerdict(row) {
  if (!row) return { ok: false, why: '空条目', tag: '' }
  // 用户自己导入 / 自持的音频不受「正式发行」约束，别把本地文件误判成片段
  const lic = String(row?.license || '')
  const own = String(row?.sourceId || '')
  if (lic === 'user-owned' || /^(local|cloud-own|custom)(:|$)/.test(own)) return { ok: true, why: '', tag: '自持' }
  const title = clean(nameOf(row))
  if (!title) return { ok: false, why: '无歌名', tag: '' }
  const tags = tagsOf(title)
  const bare = bareOf(title)
  if (BAN_TAG.test(tags)) return { ok: false, why: '非原版标记', tag: tags }
  if (EDITION_TAG.test(tags) && !ALLOW_TAG.test(tags)) return { ok: false, why: '改编版本标记', tag: tags }
  if (BAN_TITLE.test(bare)) return { ok: false, why: '标题含非原版标记', tag: '' }
  if (BAN_ALBUM.test(clean(albumOf(row)))) return { ok: false, why: '专辑为非原版', tag: '' }
  const d = durationOf(row)
  if (d > 0 && d < MIN_FULL_MS) return { ok: false, why: '时长过短（试听片段）', tag: '' }
  if (d > MAX_TRACK_MS) return { ok: false, why: '时长过长（合集/串烧）', tag: '' }
  return { ok: true, why: '', tag: ALLOW_TAG.test(tags) ? '原版' : '' }
}

/** 列表统一过滤。开关关闭时原样返回。 */
export function filterOfficial(list) {
  if (!Array.isArray(list)) return []
  if (!isOfficialOnly()) return list
  return list.filter((r) => officialVerdict(r).ok)
}

// ── 歌名 / 歌手严格匹配 ───────────────────────────────────────────────────
// 只保留中英数字，去掉括号内容与所有标点，用来比对「是不是同一首歌」。
export function canonicalTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[（(【\[《][^）)】\]》]*[）)】\]》]/g, ' ')
    .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, '')
    .trim()
}

// 二元组 Dice 相似度：应对「玻璃糖 / 玻璃糖 」这类标点差异，但对不同歌名保持低分。
function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const A = grams(a); const B = grams(b)
  let inter = 0
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0)
  return (2 * inter) / ((a.length - 1) + (b.length - 1))
}

// 歌手名归一化：只去标点/空白，**保留括号内容**。
// 不能用 canonicalTitle（它会删括号内容）——网易云常见「冯沁苑(买辣椒也用券)」「周杰伦(Jay)」这类
// 「艺名(本名)」写法，删括号会把真正要匹配的艺名抹掉，导致 QQ 歌单曲目跨平台匹配大量失败。
const canonArtist = (s) => String(s || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff()（）]+/gi, '').trim()
const artistTokens = (s) => String(s || '').toLowerCase()
  .split(/[\/、,，;；&+·\s|]+/)
  .map(canonArtist)
  .filter((x) => x.length >= 2)

// 高置信歌手别名：同一人在不同平台用中/英名标注（网易云常用英文名，如「周杰伦」↔「Jay」）。
// 零误配设计：只有 want 与 got **都精确命中同一别名组**时才判等价，任一方不在表里则完全
// 退回原子串逻辑——绝不会把「Sunny」误配成「孙燕姿」、把别的「王」姓歌手配成「王力宏」。
// 且 sameTrack 先比歌名，别名只在歌名已对上时才有机会生效。
const ARTIST_ALIAS_MAP = new Map()
for (const group of [
  ['周杰伦', 'jay', 'jaychou'],
  ['林俊杰', 'jjlin'],
  ['陈奕迅', 'eason', 'easonchan'],
  ['张学友', 'jackycheung'],
  ['刘德华', 'andylau'],
  ['王力宏', 'leehom'],
  ['蔡依林', 'jolin'],
  ['张惠妹', 'amit'],
  ['五月天', 'mayday'],
  ['孙燕姿', 'stefanie'],
  ['梁静茹', 'fishleong'],
  ['薛之谦', 'jacker'],
  ['李荣浩', 'lion'],
  ['毛不易', 'maobuyi'],
  ['taylorswift', '泰勒斯威夫特'],
  ['edsheeran', '艾德希兰'],
]) {
  for (const a of group) ARTIST_ALIAS_MAP.set(a, group[0])
}
const aliasEq = (a, b) => {
  const na = canonArtist(a).replace(/[()（）]/g, '')
  const nb = canonArtist(b).replace(/[()（）]/g, '')
  const ca = ARTIST_ALIAS_MAP.get(na), cb = ARTIST_ALIAS_MAP.get(nb)
  return !!(ca && cb && ca === cb)
}

/** 歌手是否对得上：只要有一个艺人对上即可（多人合唱常只列其中一位）。 */
export function artistMatches(want, got) {
  const A = artistTokens(want); const B = artistTokens(got)
  if (!A.length || /未知艺人|unknown/i.test(String(want))) return true   // 没有歌手信息时不臆断
  if (!B.length) return false
  const hit = (a, b) =>
    b === a || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b)) || aliasEq(a, b)
  return A.some((a) => B.some((b) => hit(a, b)))
}

/**
 * 换源 / 跨平台兜底专用：候选必须和原曲是同一首「歌名 + 歌手」，
 * 且本身也是正式发行版。宁可放不出来，也不能点 A 播 B。
 */
export function sameTrack(want, got, { strictOfficial = true } = {}) {
  if (!want || !got) return false
  if (strictOfficial && !officialVerdict(got).ok) return false
  const a = canonicalTitle(nameOf(want))
  const b = canonicalTitle(nameOf(got))
  if (!a || !b) return false
  if (a !== b && similarity(a, b) < 0.86) return false
  return artistMatches(singerOf(want), singerOf(got))
}

/**
 * 用户搜索的相关性校验：公开聚合偶尔会混入跟关键词完全无关的曲目
 * （实测搜「玻璃糖」返回过十几首「李知遥年」的别的歌）。
 * 歌名命中第一个关键词，或所有关键词都能在「歌名+歌手+专辑」里找到，才算相关。
 * 只用于用户显式搜索；推荐 / 电台的关键词是曲风词，不走这一步。
 */
export function relevantTo(row, q) {
  const terms = String(q || '').trim().toLowerCase().split(/[\s,，、|/]+/).filter((t) => t.length >= 2)
  if (!terms.length) return true
  const title = canonicalTitle(nameOf(row))
  if (title.includes(canonicalTitle(terms[0]))) return true
  // 刻意不看专辑名：平台补位曲目的 album 常被塞成搜索词本身
  // （实测搜「玻璃糖」返回十几首「李知遥年」的无关歌，专辑全写「玻璃糖」），
  // 算进 hay 就会把补位曲目误判成相关。
  const hay = `${nameOf(row)} ${singerOf(row)}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}
export function filterRelevant(list, q) {
  if (!Array.isArray(list) || !isOfficialOnly()) return list || []
  return list.filter((r) => relevantTo(r, q))
}

/**
 * 同名组限流 + 原版优先。
 * 实测搜「玻璃糖」会返回 30 条同名，其中 29 条是不同歌手的网络翻唱 ——
 * 用户看到「玻璃糖」点下去，播出来的当然「不是那首歌」。
 * 每个歌名只留前 maxSame 条，优先级：明确标「原版/正式版」> 有发行时间 > 平台原顺序。
 * 只是不展示，不删数据；关掉开关时原样返回。
 */
export function officialBoost(list, maxSame = 4) {
  if (!Array.isArray(list) || !isOfficialOnly()) return list || []
  const rank = (r) => (officialVerdict(r).tag ? 2 : 0) + (Number(r?.pubTime) > 0 ? 1 : 0)
  const sorted = [...list].sort((a, b) => rank(b) - rank(a))   // 稳定排序，同档保持原顺序
  const seen = new Map()
  const out = []
  for (const r of sorted) {
    const k = canonicalTitle(nameOf(r))
    const n = seen.get(k) || 0
    if (n >= maxSame) continue
    seen.set(k, n + 1)
    out.push(r)
  }
  return out
}

export const officialInfo = () => ({ enabled: isOfficialOnly(), minFullMs: MIN_FULL_MS, maxTrackMs: MAX_TRACK_MS })
