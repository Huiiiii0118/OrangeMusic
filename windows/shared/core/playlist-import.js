import { LICENSE_POLICY } from '../config/sourceKeys.js'
import { native } from '../protocol/bridge.js'

// 只导入歌单「元数据」（标题 / 艺人 / 专辑 / 平台 ID），不导入任何音频、不绕过登录或加密。
// 播放由 sources.resolvePending 在合法授权源里重新匹配。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const PLATFORMS = [
  { id: 'netease', name: '网易云音乐', re: /music\.163\.com|163cn\.tv/i },
  { id: 'qq', name: 'QQ音乐', re: /y\.qq\.com|c\.y\.qq\.com|i2\.ti\.itc\.cn/i },
  { id: 'kugou', name: '酷狗音乐', re: /kugou\.com/i },
  { id: 'kuwo', name: '酷我音乐', re: /kuwo\.cn/i },
  { id: 'migu', name: '咪咕音乐', re: /music\.migu\.cn/i },
  { id: 'spotify', name: 'Spotify', re: /open\.spotify\.com/i },
  { id: 'apple', name: 'Apple Music', re: /music\.apple\.com/i },
  { id: 'bilibili', name: '哔哩哔哩', re: /bilibili\.com/i },
]

export const detectPlatform = (url) => PLATFORMS.find((p) => p.re.test(url))?.name || '文本歌单'

const clean = (s) => String(s || '')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim()
const httpsify = (u) => String(u || '').replace(/^http:/i, 'https:')

async function getJson(url, referer, timeout = 9000) {
  const r = await native.request(url, {
    method: 'GET', timeout,
    headers: { Referer: referer, 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
  })
  const body = String(r?.bodyRaw || '').trim()
  if (!body) throw new Error('空响应')
  try { return JSON.parse(body) } catch { throw new Error('返回的不是 JSON') }
}

// ---- 从「分享文案 / 链接 / 裸 ID」里认出平台 + 歌单 ID ----
// QQ：/playlist/<数字>、taoge.html?id=<数字>、disstid=<数字>、任意带 id= 的 QQ 链接
// 网易云：playlist?id=<数字>、#/playlist/<数字>、163cn.tv 短链（后面再抓页面找 id）
const HINT_SHORT_QQ = '腾讯短链（.../base/fcgi-bin/u?__=xxx）会在几小时后失效。请在手机 QQ 音乐里打开歌单 →「分享」→「复制链接」，粘贴带 playlist/数字 或 id=数字 的完整链接；也可以直接粘贴歌单 ID（纯数字）。'

export function parsePlaylistTarget(input) {
  const text = String(input || '').trim()
  const urlMatch = text.match(/https?:\/\/[^\s"'<>）)]+/i)
  const url = urlMatch ? urlMatch[0] : ''
  const hay = url || text
  const isQQ = /y\.qq\.com|qq\.com/i.test(hay)
  const isWy = /163\.com|163cn\.tv/i.test(hay)

  if (isQQ) {
    const m = hay.match(/playlist\/(\d+)/i) || hay.match(/taoge\.html[^\s]*?[?&]id=(\d+)/i)
      || hay.match(/[?&]disstid=(\d+)/i) || hay.match(/[?&]id=(\d+)/i)
    if (m) return { platform: 'qq', pid: m[1], url }
    if (url) return { platform: 'qq', pid: '', url, short: true }
  }
  if (isWy) {
    const m = hay.match(/playlist[^\d]{0,16}(\d+)/i) || hay.match(/[?&]id=(\d+)/i) || hay.match(/\/(\d{5,})/)
    if (m) return { platform: 'wy', pid: m[1], url }
    if (url) return { platform: 'wy', pid: '', url, short: true }
  }
  const kg = hay.match(/special\/single\/(\d+)/i) || hay.match(/[?&]specialid=(\d+)/i)
  if (kg) return { platform: 'kg', pid: kg[1], url }
  const kw = hay.match(/playlist_detail\/(\d+)/i) || (/kuwo\.cn/i.test(hay) ? hay.match(/[?&]pid=(\d+)/i) : null)
  if (kw) return { platform: 'kw', pid: kw[1], url }

  // 只有一串数字：先按 QQ 试，失败再按网易云试
  const bare = text.match(/^\d{5,}$/)
  if (bare) return { platform: 'auto', pid: bare[0], url: '' }
  return null
}

// ---- 平台歌单接口（公开 JSON，只返回元数据）----
// QQ 歌单接口有两种返回结构：v8（name/mid/album.mid）与老 fcg（songname/songmid/albummid）
const txRow = (s) => {
  const albumMid = s.albummid || s.album?.mid || ''
  return {
    name: clean(s.songname || s.name || s.title),
    singer: (s.singer || []).map((a) => clean(a.name)).join(' / '),
    album: clean(s.albumname || s.album?.name || ''),
    songmid: String(s.songmid || s.mid || s.songid || ''),
    source: 'tx',
    cover: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
    durationMs: (Number(s.interval) || 0) * 1000,
  }
}

// 全量拉取：分页 50 一首歌单，直到取完或到达安全上限（limit>0 时只取前 limit 首）。
// 2026-11-10：旧版默认 limit=120，217 首的歌单只导入 120 首；改为默认全量。
async function txPlaylist(pid, limit = 0) {
  const rows = []
  let title = ''
  let total = 0
  const CAP = 1000
  for (let begin = 0; ; begin += 50) {
    const size = 50
    const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg'
      + `?id=${encodeURIComponent(pid)}&format=json&newsong=1&song_begin=${begin}&song_num=${size}`
      + '&platform=yqq&hostUin=0&needNewCode=0&inCharset=utf8&outCharset=utf-8'
    const j = await getJson(url, 'https://y.qq.com/')
    const cd = j?.data?.cdlist?.[0]
    if (!cd) break
    title = title || clean(cd.dissname)
    total = Number(cd.total_song_num || cd.sum) || total
    const list = cd.songlist || []
    rows.push(...list.map(txRow))
    if (list.length < size) break
    if (total && rows.length >= total) break
    if (rows.length >= (limit > 0 ? limit : CAP)) break
  }
  return { title, rows: rows.slice(0, limit > 0 ? limit : undefined).filter((r) => r.name && r.songmid) }
}

const wyRow = (s) => ({
  name: clean(s.name),
  singer: (s.ar || s.artists || []).map((a) => clean(a.name)).join(' / '),
  album: clean((s.al || s.album || {}).name || ''),
  songmid: String(s.id),
  source: 'wy',
  cover: httpsify((s.al || s.album || {}).picUrl || '').replace(/\?.*$/, ''),
  durationMs: Number(s.dt || s.duration) || 0,
})

// 全量拉取（分页 100，安全上限 1000；limit>0 时只取前 limit 首）
async function wyPlaylist(pid, limit = 0) {
  let title = ''
  let total = 0
  try {
    const d = await getJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(pid)}`, 'https://music.163.com/')
    title = clean(d?.playlist?.name)
    total = Number(d?.playlist?.trackCount) || 0
  } catch { /* 标题拿不到不影响曲目 */ }
  const CAP = limit > 0 ? limit : 1000
  let songs = []
  try {
    for (let offset = 0; songs.length < CAP; offset += 100) {
      const j = await getJson(`https://music.163.com/api/playlist/track/all?id=${encodeURIComponent(pid)}&limit=100&offset=${offset}`, 'https://music.163.com/')
      const batch = j?.songs || []
      if (!batch.length) break
      songs.push(...batch)
      if (batch.length < 100) break
      if (total && songs.length >= total) break
    }
  } catch { /* 回落旧接口 */ }
  if (!songs.length) {
    const j = await getJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(pid)}`, 'https://music.163.com/')
    songs = j?.result?.tracks || j?.playlist?.tracks || []
  }
  return { title, rows: songs.slice(0, CAP).map(wyRow).filter((r) => r.name && r.songmid) }
}

// 从公开分享页的 JSON-LD / 内嵌 JSON / 列表 DOM 里提取「标题 + 艺人」。
function extractFromHtml(html) {
  const out = []
  const push = (title, artist) => {
    const t = clean(title), a = clean(artist)
    if (t && t.length < 120 && !out.some((x) => x.title === t && x.artist === a)) out.push({ title: t, artist: a || '未知艺人', album: '' })
  }
  for (const m of html.matchAll(/"@type"\s*:\s*"MusicRecording"[^{]*\{[^}]*\}/g)) {
    const n = m[0].match(/"name"\s*:\s*"([^"]+)"/)
    const by = m[0].match(/"byArtist"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/)
    if (n) push(n[1], by?.[1])
  }
  for (const m of html.matchAll(/\{[^{}]{0,400}?"(?:name|title|songName)"\s*:\s*"([^"]{1,80})"[^{}]{0,400}?\}/g)) {
    const chunk = m[0]
    const artist = chunk.match(/"(?:artist|singer|artistName|artists|author)"\s*:\s*"([^"]{1,80})"/)
    if (artist || /"name"/.test(chunk)) push(m[1], artist?.[1])
  }
  return out
}

// 分享页里找歌单 ID（短链跳转后的落地页 / 服务端渲染页都可能带着）
function findIdInHtml(html, platform) {
  if (!html) return ''
  if (platform === 'qq') {
    const m = html.match(/"dissid"\s*:\s*"?(\d{5,})/) || html.match(/playlist\/(\d{5,})/) || html.match(/[?&]disstid=(\d{5,})/)
    return m ? m[1] : ''
  }
  if (platform === 'wy') {
    const m = html.match(/"id"\s*:\s*(\d{5,})/) || html.match(/playlist\/(\d{5,})/) || html.match(/[?&]id=(\d{5,})/)
    return m ? m[1] : ''
  }
  return ''
}

function parsePlainText(text) {
  return text.split(/\r?\n/).map((line) => {
    const s = line.trim().replace(/^\d+[.、)]\s*/, '')
    if (!s) return null
    const m = s.split(/\s+[-–—]\s+|\t|\s+\/\s+/)
    return { title: clean(m[0]), artist: clean(m[1]) || '未知艺人', album: '' }
  }).filter((x) => x?.title)
}

// 可选通道：直接粘贴 LX Music / 榜单端点返回的 JSON（含 songmid 或 hash）。
function parseJsonRows(text) {
  let data
  try { data = JSON.parse(text) } catch { return null }
  const rows = Array.isArray(data) ? data
    : (data?.data?.list || data?.data || data?.list || data?.songs || data?.tracks || data?.result || [])
  if (!Array.isArray(rows) || !rows.length) return null
  const out = rows.map((r) => {
    if (typeof r === 'string') { const [name, singer = ''] = r.split(/\s+[-–—]\s+/); return { title: clean(name), artist: clean(singer) || '未知艺人', album: '', songmid: '', hash: '', source: '' } }
    const artists = Array.isArray(r.artists) ? r.artists.map((a) => a?.name || a).filter(Boolean).join(' / ') : ''
    return {
      title: clean(r.name || r.title || r.songname || r.song),
      artist: clean(artists || r.artist || r.singer || r.author) || '未知艺人',
      album: clean(r.album || r.albumname),
      songmid: String(r.songmid ?? r.mid ?? r.songId ?? r.id ?? ''),
      hash: String(r.hash ?? r.fileHash ?? r.file_hash ?? ''),
      source: r.source || '',
    }
  }).filter((r) => r.title)
  if (!out.length) return null
  return {
    platform: 'JSON 歌单',
    tracks: out.map((r) => ({ title: r.title, artist: r.artist, album: r.album })),
    musicInfo: out.map((r) => ({ name: r.title, singer: r.artist, album: r.album,
      songmid: r.songmid, hash: r.hash, source: r.source })),
  }
}

// 平台接口拿到的行 → 可直接播放的待解析曲目（点播时再按 songmid 取链接）
function toResult(platform, title, rows, extra = {}) {
  return {
    platform: title ? `${platform}「${title}」` : platform,
    title,
    tracks: rows.map((r) => ({ title: r.name, artist: r.singer, album: r.album, durationMs: r.durationMs, cover: r.cover })),
    pendingRows: rows.map((r) => ({ name: r.name, singer: r.singer, album: r.album, songmid: r.songmid,
      source: r.source, cover: r.cover, durationMs: r.durationMs })),
    needsManualPaste: false,
    ...extra,
  }
}

async function byPlatform(platform, pid, limit) {
  if (platform === 'qq' || platform === 'auto') {
    const r = await txPlaylist(pid, limit)
    if (r.rows.length) return toResult('QQ音乐 歌单', r.title, r.rows)
    if (platform === 'qq') return null
  }
  if (platform === 'wy' || platform === 'auto') {
    const r = await wyPlaylist(pid, limit)
    if (r.rows.length) return toResult('网易云音乐 歌单', r.title, r.rows)
  }
  return null
}

export async function importPlaylist(input) {
  const text = String(input || '').trim()
  if (!text) return { platform: '', tracks: [] }
  if (text.startsWith('[') || text.startsWith('{')) return parseJsonRows(text) || { platform: '文本歌单', tracks: parsePlainText(text) }

  const target = parsePlaylistTarget(text)
  if (target) {
    const limit = 0   // 0 = 全量（旧版 120 会把大歌单截断）
    // 1) 链接里直接带 ID：走平台接口，最快最准
    if (target.pid) {
      try {
        const hit = await byPlatform(target.platform, target.pid, limit)
        if (hit) return hit
      } catch { /* 接口失败再走页面兜底 */ }
    }
    // 2) 短链 / 接口没给曲目：抓分享页，从页面里找 ID 或曲目
    if (target.url) {
      let html = ''
      try { html = await native.fetchText(target.url) } catch { html = '' }
      const id = findIdInHtml(html, target.platform)
      if (id && id !== target.pid) {
        try {
          const hit = await byPlatform(target.platform, id, limit)
          if (hit) return hit
        } catch { /* 继续兜底 */ }
      }
      if (html) {
        const tracks = extractFromHtml(html)
        if (tracks.length) return { platform: `${detectPlatform(target.url)} 歌单`, tracks, needsManualPaste: false }
      }
      return {
        platform: detectPlatform(target.url),
        tracks: [],
        needsManualPaste: true,
        hint: target.short
          ? (target.platform === 'qq' ? HINT_SHORT_QQ : '这个短链解析不到歌单，请粘贴带 playlist/数字 或 id=数字 的完整链接，或直接粘贴歌单 ID。')
          : '这个链接没有可解析的歌单 ID（可能是单曲、电台或已下架），请用歌单「分享 → 复制链接」里的完整链接。',
      }
    }
    return {
      platform: '文本歌单',
      tracks: [],
      needsManualPaste: true,
      hint: `ID ${target.pid} 没有取到曲目：可能是私密歌单、已删除，或该平台接口暂不可用。可以换成「歌名 - 歌手」文本粘贴。`,
    }
  }

  const isUrl = /^https?:\/\//i.test(text)
  if (!isUrl) return { platform: '文本歌单', tracks: parsePlainText(text) }

  const platform = detectPlatform(text)
  let tracks = []
  try {
    const html = await native.fetchText(text)
    tracks = extractFromHtml(html)
  } catch { tracks = [] }
  if (!LICENSE_POLICY.metadataOnlyImport) throw new Error('合规开关被关闭：禁止导入音频')
  return {
    platform,
    tracks,
    needsManualPaste: tracks.length === 0,
    hint: tracks.length ? '' : '没从这个页面解析到曲目。请粘贴歌单「分享 → 复制链接」的完整链接，或直接粘贴「歌名 - 歌手」多行文本。',
  }
}
