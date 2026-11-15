/* 橙子音乐 · iOS PWA + orange-music-api 合体服务
   一个 Node 进程同时做两件事：
     1）托管 www/ 下的 PWA 静态站点（Safari 添加到主屏幕可用）；
     2）提供 /api/* 音源接口（搜索聚合 / 多平台取链 / 榜单）。
   同源部署的好处：前端不需要配置任何 API 域名，也没有 CORS 与混合内容问题。
   接口：
     GET /health
     GET /api/search?q=&limit=
     GET /api/url?title=&artist=   或  ?id=&source=wy|kw
     GET /api/charts?type=hot|rise|new|original
*/
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const nodeRequire = createRequire(import.meta.url)
// Windows 那套内置音源引擎（api-enhanced + 波点/酷我），纯 Node、不依赖 Electron。
// 加载失败时只降级：/api/url 的两源通道照常工作，站点不会因此起不来。
let localApiMod = null
let localApiErr = ''
let localApiTried = false
// 惰性加载：api-enhanced 有 19MB 依赖，启动时 require 会把首屏拖到 7 秒以上。
// 改成「第一次真正要取链时才加载」，首页/榜单不受影响。
function getLocalApi() {
  if (localApiTried) return localApiMod
  localApiTried = true
  const t0 = Date.now()
  try {
    localApiMod = nodeRequire('./local-api.cjs')
    console.log(`[local-api] 内置引擎已加载（${Date.now() - t0}ms）`)
  } catch (e) {
    localApiErr = String((e && e.message) || e)
    console.log('[local-api] 内置引擎不可用（降级为两源通道）：' + localApiErr)
  }
  return localApiMod
}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
// 部署产物是「扁平的 www 内容」：server.js 与 index.html 同级 → 站点根就是自身目录；
// 本地从 ios/ 启动时 index.html 在 ./www/ 下 → 才退回 www 子目录。
// 不能用「是否存在 www 子目录」来判断：发布沙箱可能残留旧的 www/ 目录，
// 那样会把新上传的静态文件全部读成旧快照（改版不生效）。
const WWW = fs.existsSync(path.join(ROOT, 'index.html')) ? ROOT : path.join(ROOT, 'www')
const PORT = Number(process.env.PORT || 3000)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const TTL = 10 * 60 * 1000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const cache = new Map()
function cget(key) {
  const v = cache.get(key)
  if (!v) return null
  if (Date.now() - v.at > v.ttl) { cache.delete(key); return null }
  return v.data
}
function cset(key, data, ttl = TTL) {
  if (cache.size > 1200) cache.clear()
  cache.set(key, { at: Date.now(), data, ttl })
  return data
}

async function req(url, opt = {}) {
  return fetch(url, {
    redirect: opt.redirect || 'follow',
    headers: {
      'User-Agent': opt.ua || UA,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(opt.headers || {}),
    },
    signal: AbortSignal.timeout(opt.timeout || 9000),
  })
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_·.()（）[\]【】「」《》,，、!！?？'"]/g, '')
// 严格歌手比对：给了歌手就要求「结果歌手里确实包含这位歌手」，否则视为别人的翻唱/同名歌。
// 用户反馈「哼/冯提莫」被解析成『哼着你爱听的歌(烟嗓版)/失守』、时女声时男声 —— 就是原版取不到时
// 被同名/别的歌顶替。宁可不播（暂时无法播放），也不要播成别人的歌。多歌手用 / & 分隔会逐段比。
const sameArtist = (a, artist) => {
  const want = norm(artist)
  if (!want) return true
  const n = norm(a)
  if (!n) return false
  if (n.includes(want)) return true
  return n.split(/[\/&]+/).some((p) => p && p.includes(want))
}

// ── 搜索：网易云 ──────────────────────────────────
async function wySearch(q, limit = 20) {
  const u = `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=${limit}`
  const r = await req(u, { headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' } })
  const j = await r.json()
  const list = j?.result?.songs || []
  return list.map((s) => ({
    source: 'wy',
    id: String(s.id),
    title: s.name || '',
    artist: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join('/'),
    album: s.album?.name || s.al?.name || '',
    cover: String(s.album?.picUrl || s.al?.picUrl || '').split('http://').join('https://'),
    durationMs: Number(s.duration || s.dt || 0),
  })).filter((x) => x.title)
}

// 搜索接口本身不带封面（只有 album.id），批量用 song/detail 把 picUrl 补回来。
// 一次请求补 40 首，比分端一首一首查快一个数量级。
async function wyFillCovers(list = []) {
  const need = list.filter((x) => x.source === 'wy' && !x.cover && x.id)
  if (!need.length) return list
  try {
    const ids = need.slice(0, 40).map((x) => x.id)
    const r = await req(`https://music.163.com/api/song/detail?ids=${encodeURIComponent('[' + ids.join(',') + ']')}`, {
      headers: { Referer: 'https://music.163.com/' }, timeout: 8000,
    })
    const j = await r.json()
    const map = new Map()
    for (const s of j?.songs || []) {
      const pic = String(s?.album?.picUrl || s?.al?.picUrl || '').split('http://').join('https://')
      if (pic) map.set(String(s.id), pic)
    }
    if (map.size) for (const x of need) { const hit = map.get(x.id); if (hit) x.cover = hit }
  } catch { /* 补不到就走客户端兜底 */ }
  return list
}

// ── 搜索：酷我（无需 token 的老接口，返回单引号 JSON）──
async function kwSearch(q, limit = 20) {
  const u = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(q)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${limit}&rformat=json&encoding=utf8`
  const r = await req(u, { headers: { Referer: 'https://www.kuwo.cn/' } })
  let t = await r.text()
  t = t.replace(/'/g, '"')
  let j
  try { j = JSON.parse(t) } catch { return [] }
  const list = j?.abslist || []
  return list.map((s) => {
    const rid = String(s.MUSICRID || '').replace(/^MUSIC_/, '')
    return {
      source: 'kw',
      id: rid,
      title: String(s.SONGNAME || '').replace(/&nbsp;/g, ' ').replace(/\\u0026/g, '&').trim(),
      artist: String(s.ARTIST || '').replace(/\\u0026/g, '&').trim(),
      album: String(s.ALBUM || '').trim(),
      cover: '',
      durationMs: Number(s.DURATION || 0) * 1000,
    }
  }).filter((x) => x.title && x.id)
}

// ── 取链 ─────────────────────────────────────────
async function kwUrl(rid) {
  const u = `https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=MUSIC_${rid}&format=mp3&response=url`
  const r = await req(u, { headers: { Referer: 'https://www.kuwo.cn/' }, timeout: 8000 })
  const t = (await r.text()).trim()
  if (/^https?:\/\//i.test(t)) return t
  try {
    const j = JSON.parse(t)
    if (j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) return j.url
  } catch { /* 非 JSON 判失败 */ }
  return ''
}
// 酷狗：很多「原版」只在酷狗有（酷我 / 网易云只剩翻唱）。搜索走 msearchcdn，取链走 getSongInfo（免登录）。
async function kgSearch(q, limit = 12) {
  try {
    const r = await req(`https://msearchcdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=${limit}&showtype=1`, { timeout: 6000 })
    const j = await r.json()
    const info = j?.data?.info || []
    return info.map((s) => ({
      source: 'kg', id: String(s.hash || ''),
      title: String(s.songname || '').trim(), artist: String(s.singername || '').trim(),
      album: String(s.album_name || '').trim(), durationMs: Number(s.duration || 0) * 1000,
    })).filter((x) => x.id && x.title)
  } catch { return [] }
}
async function kgUrl(hash) {
  if (!hash) return ''
  try {
    const r = await req(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`, { timeout: 7000, headers: { Referer: 'https://m.kugou.com/' } })
    const j = await r.json()
    return /^https?:/i.test(String(j?.url || '')) ? String(j.url) : ''
  } catch { return '' }
}
async function wyUrl(id) {
  const u = `https://music.163.com/song/media/outer/url?id=${id}.mp3`
  const r = await req(u, { headers: { Referer: 'https://music.163.com/' }, timeout: 8000 })
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const final = r.url || ''
  if (ct.includes('audio') || ct.includes('octet-stream') || ct.includes('mpeg')) return final
  if (r.status === 200 && !ct.includes('html') && /\.(mp3|m4a|flac|aac)/i.test(final)) return final
  return ''
}

async function resolveOne(t) {
  try {
    const url = t.source === 'kw' ? await kwUrl(t.id) : await wyUrl(t.id)
    if (url) return { url, source: t.source, id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs }
  } catch { /* 换下一个候选 */ }
  return null
}

// 波点取链（UNM 的 bodian provider：酷我搜索 + 波点音频接口，按「歌名+歌手」直接出链，
// 不依赖平台 ID、不依赖会员）。命中率高于 anti.s，优先走这条。
// ── 波点取链（酷我综合搜索 + 波点 audioUrl）——纯 HTTP，不依赖 node_modules ──
// 为什么必须有这条：酷我 anti.s 对付费曲只回 11 秒试听、网易云直接 404，
// 「哼 - 冯提莫」这类只有酷我有原版的歌，只有波点接口能拿到 320k 完整音频。
// 波点的取链要先过一次「广告解锁」，再按音乐 ID 换 audioUrl；签名是
// md5('kuwotest' + 排序后的 query 字母数字 + pathname) + &timestamp=…
const BODIAN_DEV = String(Math.floor(Math.random() * 1e11))
const BODIAN_HEAD = {
  'user-agent': 'Dart/2.19 (dart:io)', plat: 'ar', channel: 'aliopen',
  devid: BODIAN_DEV, ver: '3.9.0', host: 'bd-api.kuwo.cn',
}
let bodianUnlockAt = 0
async function bodianUnlock() {
  if (Date.now() - bodianUnlockAt < 20 * 60 * 1000) return true
  try {
    const r = await fetch('http://bd-api.kuwo.cn/api/service/advert/watch?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da', {
      method: 'POST',
      headers: { ...BODIAN_HEAD, qimei36: '1e9970cbcdc20a031dee9f37100017e1840e', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 5, subType: 5, musicId: 0, adToken: '' }),
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => null)
    if (j && j.code === 200) { bodianUnlockAt = Date.now(); return true }
  } catch { /* 解锁失败也继续试：免费曲不需要解锁 */ }
  return false
}
function bodianSign(str) {
  const u = new URL(str)
  const withTs = str + '&timestamp=' + Date.now()
  const filtered = withTs.substring(withTs.indexOf('?') + 1).replace(/[^a-zA-Z0-9]/g, '').split('').sort().join('')
  const sign = crypto.createHash('md5').update('kuwotest' + filtered + u.pathname).digest('hex')
  return withTs + '&sign=' + sign
}
// 酷我「综合搜索」：比 web_2013 那套返回更全（付费曲也在，且带 MUSICRID）
async function kwComprehensive(keyword, rows = 15) {
  const u = 'http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8'
    + '&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&rn=' + rows
    + '&all=' + encodeURIComponent(keyword)
  const r = await req(u, { headers: { Referer: 'http://www.kuwo.cn/' }, timeout: 8000 })
  const txt = (await r.text()).replace(/'/g, '"')
  let j = null
  try { j = JSON.parse(txt) } catch { return [] }
  const list = j?.content?.[1]?.musicpage?.abslist || j?.abslist || []
  return list.map((s) => ({
    id: String(s.MUSICRID || '').replace(/^MUSIC_/, ''),
    title: String(s.SONGNAME || '').replace(/&nbsp;/g, ' ').replace(/\\u0026/g, '&').trim(),
    artist: String(s.ARTIST || '').replace(/\\u0026/g, '&').trim(),
    album: String(s.ALBUM || '').trim(),
    durationMs: (Number(s.DURATION) || 0) * 1000,
  })).filter((x) => x.id && x.title)
}
async function bodianAudioUrl(rid, br = '320kmp3') {
  if (!rid) return null
  await bodianUnlock()
  const signed = bodianSign(`http://bd-api.kuwo.cn/api/play/music/v2/audioUrl?&br=${br}&musicId=${rid}`)
  try {
    const r = await fetch(signed, { headers: { ...BODIAN_HEAD, 'X-Forwarded-For': '1.0.1.114' }, signal: AbortSignal.timeout(9000) })
    const j = await r.json()
    if (!j || j.code !== 200 || !j.data) return null
    const url = String(j.data.audioUrl || '')
    if (!/^https?:/i.test(url)) return null
    return { url, durationMs: (Number(j.data.duration) || 0) * 1000, bitrate: Number(j.data.bitrate) || 0 }
  } catch { return null }
}
// 同时要 320k 与 128k 两条：CDN 慢/挂的时候客户端能立刻换那条播，
// 不用整首判死（「首次说无法播放、再点一次又能播」多半就是首包太慢）。
async function bodianDual(rid) {
  const [hi, lo] = await Promise.all([
    bodianAudioUrl(rid, '320kmp3'),
    bodianAudioUrl(rid, '128kmp3').catch(() => null),
  ])
  if (!hi && !lo) return null
  const main = hi || lo
  const alt = hi && lo && lo.url !== hi.url ? lo.url : ''
  return {
    url: main.url.split('http://').join('https://'),
    altUrl: alt ? alt.split('http://').join('https://') : '',
    durationMs: main.durationMs, bitrate: main.bitrate,
  }
}
// 严格选曲：歌名要对得上（单字歌名必须完全一致），歌手必须包含目标歌手，
// 两边都有时长时差不超过 15 秒 —— 否则宁可返回 null，也不播别人的版本。
async function bodianResolve(title, artist, album, durationMs) {
  if (!title) return null
  const target = norm(title)
  const want = Number(durationMs) || 0
  const rows = await kwComprehensive(`${title} ${artist}`.trim(), 15).catch(() => [])
  const ok = rows.filter((x) => {
    const t = norm(x.title)
    if (!t) return false
    if (t.length <= 2 || target.length <= 2) { if (t !== target) return false }
    else if (!(t.includes(target) || target.includes(t))) return false
    if (!sameArtist(x.artist, artist)) return false
    if (want > 0 && x.durationMs > 0 && Math.abs(x.durationMs - want) > 15000) return false
    return true
  }).sort((a, b) => (norm(b.title) === target ? 1 : 0) - (norm(a.title) === target ? 1 : 0))
  for (const c of ok.slice(0, 3)) {
    const got = await bodianDual(c.id)
    if (!got?.url) continue
    return {
      // 波点给的是 http 直链，线上页面是 https（混合内容会被拦），这里统一升级
      url: got.url,
      altUrl: got.altUrl || '',
      source: 'bodian', id: c.id,
      title: c.title, artist: c.artist, album: c.album || album || '',
      durationMs: got.durationMs || c.durationMs || want,
    }
  }
  return null
}

// GD 公开镜像（music-api.gdstudio.xyz）：按歌名+歌手搜网易云 → 取 320k 直链。
// 比 music.163.com/song/media/outer/url 覆盖更全（含下架/付费曲），两次请求约 3 秒；
// 关键是它能把「原版」排在 Live/DJ/伴奏版前面 —— 播放音频版本对了，歌词才可能对得上。
async function gdResolve(title, artist) {
  if (!title) return null
  const target = norm(title)
  const wantArt = norm(artist)
  const BAD = /(伴奏|纯音乐|ktv|片段|dj|remix|铃声|试听|翻唱|cover|live|\(live\)|（live）)/i
  const clean = (n) => !(BAD.test(String(n || '')) && !BAD.test(title))
  try {
    const r = await req(`https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${encodeURIComponent(`${title} ${artist}`.trim())}&count=6&pages=1`, { timeout: 6000 })
    const rows = await r.json()
    if (!Array.isArray(rows)) return null
    const scored = rows.map((x) => {
      const rawA = Array.isArray(x?.artist) ? x.artist.join('/') : String(x?.artist || '')
      const n = norm(String(x?.name || ''))
      if (!n || !(n.includes(target) || target.includes(n))) return null
      if (!sameArtist(rawA, artist)) return null   // 歌手对不上 → 别人的翻唱/同名歌，丢弃
      let score = n === target ? 3 : 0
      if (wantArt && norm(rawA).includes(wantArt)) score += 5
      if (!clean(x?.name)) score -= 6
      return { x, score, clean: clean(x?.name) }
    }).filter(Boolean).sort((p, q) => (Number(q.clean) - Number(p.clean)) || (q.score - p.score))
    for (const c of scored.slice(0, 3)) {
      const id = String(c.x.id || c.x.url_id || '')
      if (!id) continue
      const rr = await req(`https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${encodeURIComponent(id)}&br=320`, { timeout: 6000 })
      const j = await rr.json()
      const u = String(j?.url || '')
      if (/^https?:/i.test(u)) {
        return { url: u.split('http://').join('https://'), source: 'gd', id, title: String(c.x.name || title), artist, durationMs: 0 }
      }
    }
  } catch { /* 镜像抖动，交给后面的两源通道 */ }
  return null
}

// 并行竞速：谁先给出「合法结果」就用谁；全都没命中等全部结束再返回 null。
// 之前是「GD 先、波点后」串行：GD 在境外，经常要等满 6 秒超时，波点再花 1~2 秒，
// 一首歌 4~8 秒才出声。Windows 端之所以快，是因为它在本机直接跑波点、不走这条串行链。
function raceResolvers(tasks) {
  return new Promise((resolve) => {
    const list = (tasks || []).filter(Boolean)
    if (!list.length) return resolve(null)
    let left = list.length
    let done = false
    const finish = (v) => { if (done) return; done = true; resolve(v) }
    for (const run of list) {
      Promise.resolve().then(run).then((r) => {
        if (r && r.url) return finish(r)
        if (--left === 0) finish(null)
      }).catch(() => { if (--left === 0) finish(null) })
    }
  })
}

async function resolveByText(title, artist, fresh = false) {
  const key = `u:${norm(title)}|${norm(artist)}`
  const hit = fresh ? null : cget(key)
  if (hit) return hit
  // ① 波点优先 + GD 并行兜底（对齐 Windows 桌面端的取链顺序）：
  //    波点按「歌名+歌手」直接拿 320k 完整原版（含付费曲），GD 镜像覆盖网易云侧，
  //    两路同时发，谁先给出通过校验的结果就用谁 —— 通常 1~2 秒出链。
  const raced = await raceResolvers([
    () => bodianResolve(title, artist, '', 0),
    () => gdResolve(title, artist),
  ])
  if (raced) return cset(key, { ...raced, reason: '' }, 20 * 60 * 1000)
  const q = `${title} ${artist}`.trim()
  const [kw, wy] = await Promise.all([
    kwSearch(q, 10).catch(() => []),
    wySearch(q, 10).catch(() => []),
  ])
  const target = norm(title)
  const wantArt = norm(artist)
  let cands = [...kw, ...wy].filter((x) => {
    const t = norm(x.title)
    if (!(t && (t.includes(target) || target.includes(t)))) return false
    return sameArtist(x.artist, artist)   // 歌手必须对上，绝不拿同名 / 翻唱顶替
  })
  const BAD = /(伴奏|纯音乐|ktv|片段|dj|remix|铃声|试听|翻唱|cover)/i
  const score = (x) => {
    const t = norm(x.title)
    let n = 0
    if (wantArt && norm(x.artist).includes(wantArt)) n += 5
    if (t === target) n += 3
    else if (t.startsWith(target)) n += 1
    if (x.source === 'kw') n += 2
    if (BAD.test(x.title) || BAD.test(x.artist)) n -= 4
    return n
  }
  cands = cands.sort((a, b) => score(b) - score(a))
  for (const c of cands.slice(0, 8)) {
    const got = await resolveOne(c)
    if (!got) continue
    // 只对「歌名完全一致 或 歌手对得上」的结果长缓存；
    // 弱命中（如「起风了」配到「起风了小提琴」）只留 60 秒，避免把错误结果缓存 6 分钟。
    const t = norm(c.title)
    const strong = (t === target) || (wantArt && norm(c.artist).includes(wantArt))
    return cset(key, got, strong ? 6 * 60 * 1000 : 60 * 1000)
  }
  // ③ 酷狗兜底：原版只在酷狗的情况（如冯提莫《哼》，酷我/网易云只剩翻唱）。严格歌名 + 歌手。
  const kgRows = await kgSearch(q, 12).catch(() => [])
  const kgOk = kgRows.filter((x) => {
    const t = norm(x.title)
    if (!(t && (t.includes(target) || target.includes(t)))) return false
    return sameArtist(x.artist, artist)
  })
  for (const c of kgOk.slice(0, 6)) {
    const u = await kgUrl(c.id)
    if (u) return cset(key, { url: u.split('http://').join('https://'), source: 'kg', id: c.id, title: c.title, artist: c.artist, durationMs: c.durationMs }, 6 * 60 * 1000)
  }
  return cset(key, { url: '', reason: 'no-source' }, 90 * 1000)
}

// ── 榜单 ─────────────────────────────────────────
const CHARTS = {
  hot: { id: 3778678, name: '热歌榜' },
  rise: { id: 19723756, name: '飙升榜' },
  new: { id: 3779629, name: '新歌榜' },
  original: { id: 2884035, name: '原创榜' },
}

// ── QQ 音乐榜单（巅峰榜）：topid 26=热歌 4=流行指数 27=新歌 ──
async function qqToplist(topid, limit = 30) {
  const u = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topid}&format=json&page=detail&type=top&song_begin=0&song_num=${limit}`
  const r = await req(u, { headers: { Referer: 'https://y.qq.com/' } })
  const j = await r.json()
  return (j?.songlist || []).map((s) => {
    const d = s.data || {}
    const mid = d.albummid || ''
    return {
      source: 'tx',
      id: String(d.songmid || d.songid || ''),
      title: String(d.songname || ''),
      artist: (d.singer || []).map((a) => a.name).filter(Boolean).join('/'),
      album: String(d.albumname || ''),
      cover: mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : '',
      durationMs: Number(d.interval || 0) * 1000,
    }
  }).filter((x) => x.title && x.artist)
}

// 多平台混排：按平台轮流取，同名同歌手去重，保证首屏不会一屏都是同一个平台。
function mixTracks(lists = [], limit = 60) {
  const seen = new Set()
  const out = []
  const key = (x) => `${norm(x.title)}|${norm(x.artist).slice(0, 6)}`
  const rounds = Math.max(...lists.map((l) => l.length), 0)
  for (let i = 0; i < rounds && out.length < limit; i++) {
    for (const l of lists) {
      const x = l[i]
      if (!x) continue
      const k = key(x)
      if (!x.title || seen.has(k)) continue
      seen.add(k)
      out.push(x)
      if (out.length >= limit) break
    }
  }
  return out
}

// 洗牌抽样：每次请求都不同，但不会重复同一首
function shuffleTake(list = [], n = 6) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.max(1, n))
}

// 网易云「推荐新音乐」：带封面，是真正的个性化新歌位
async function wyNewsong(limit = 30) {
  const r = await req('https://music.163.com/api/personalized/newsong', {
    headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
  })
  const j = await r.json()
  return (j?.result || []).map((x) => {
    const s = x.song || x
    return {
      source: 'wy',
      id: String(x.id || s.id || ''),
      title: s.name || x.name || '',
      artist: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join('/'),
      album: s.album?.name || s.al?.name || '',
      cover: String(x.picUrl || s.album?.picUrl || s.al?.picUrl || '').split('http://').join('https://'),
      durationMs: Number(s.duration || s.dt || 0),
    }
  }).filter((x) => x.title).slice(0, limit)
}

// 个性化歌单 → 真实曲目。取前 n 张，每张前 10 首，避免一次拉太多。
async function playlistTracks(n = 3) {
  const r = await req('https://music.163.com/api/personalized/playlist?limit=8', {
    headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
  })
  const j = await r.json()
  const ids = (j?.result || []).map((x) => x.id).filter(Boolean).slice(0, n)
  const lists = await Promise.all(ids.map((id) => req(`https://music.163.com/api/playlist/detail?id=${id}`, {
    headers: { Referer: 'https://music.163.com/' }, timeout: 9000,
  }).then((x) => x.json()).catch(() => null)))
  const out = []
  for (const d of lists) {
    const tracks = d?.result?.tracks || []
    for (const s of tracks.slice(0, 12)) {
      out.push({
        source: 'wy',
        id: String(s.id || ''),
        title: s.name || '',
        artist: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join('/'),
        album: s.album?.name || s.al?.name || '',
        cover: String(s.album?.picUrl || s.al?.picUrl || '').split('http://').join('https://'),
        durationMs: Number(s.duration || s.dt || 0),
      })
    }
  }
  return out.filter((x) => x.title && x.artist)
}
async function chart(type) {
  const c = CHARTS[type] || CHARTS.hot
  const key = `c:${c.id}`
  const hit = cget(key)
  if (hit) return hit
  const r = await req(`https://music.163.com/api/playlist/detail?id=${c.id}`, {
    headers: { Referer: 'https://music.163.com/' },
  })
  const j = await r.json()
  const tracks = (j?.result?.tracks || []).slice(0, 60).map((s) => ({
    source: 'wy',
    id: String(s.id),
    title: s.name || '',
    artist: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join('/'),
    album: s.album?.name || s.al?.name || '',
    cover: String(s.album?.picUrl || s.al?.picUrl || '').split('http://').join('https://'),
    durationMs: Number(s.duration || s.dt || 0),
  })).filter((x) => x.title)
  if (!tracks.length) return cset(key, { id: CHARTS[type] ? type : 'hot', name: c.name, tracks }, 60 * 1000)
  return cset(key, { id: CHARTS[type] ? type : 'hot', name: c.name, tracks }, 15 * 60 * 1000)
}

// ── 歌词：/api/lyric?title=&artist=&id=&source= ──────
// iOS 端所有第三方歌词接口都被 CORS 拦住，统一由服务端代取；结果按歌名+歌手缓存 24 小时。
const LRC_RE = /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/
// 网易云/GD 的 LRC 头部普遍带「[00:00.000] 作词 : xx」，这些不是唱词。
// 旧版把它们当成 0~4 秒的歌词行，播放页只显示一行时整段前奏都在显示「作词：xx」。
// 元数据 / 制作信息行（「作词 : 赵雷」「和声、弦乐编写 : 丁培峰」「制作出品 : 中英音乐」
// 「音乐发行 : 智慧大狗x天才联盟」等）不是唱词。统一规则：去掉时间标签后，
// 形如「若干中文/标点（最长 14 字）＋冒号」的短行即判为元数据。
// 只认中文前缀，避免把英文歌词（如 "by the way : ..."）误判成制作信息；
// 单个 LRC 头标签（al/ar/ti/au/offset/length/re/ve/by）也保留。
const META_LINE = /^(?:[\u4e00-\u9fa5·、×&－-]{1,14}|lrc|lyric|lyrics|by|offset|al|ar|ti|au|length|re|ve)\s*[：:]/
function cleanLrc(raw) {
  return String(raw || '').split(/\r?\n/).filter((line) => {
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    return !text || !META_LINE.test(text)
  }).join('\n')
}
async function wyLyricById(id) {
  const r = await req(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`, {
    headers: { Referer: 'https://music.163.com/' }, timeout: 7000,
  })
  const j = await r.json()
  const t = cleanLrc(j?.lrc?.lyric)
  const tr = cleanLrc(j?.tlyric?.lyric)
  return { lyric: LRC_RE.test(t) ? t : '', tlyric: LRC_RE.test(tr) ? tr : '' }
}
// QQ 音乐歌词：nobase64=1 拿明文，老接口返回 base64 时再解一次 UTF-8。
async function qqLyricById(id) {
  const r = await req(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(id)}&format=json&nobase64=1&g_tk=5381`, {
    headers: { Referer: 'https://y.qq.com/' }, timeout: 7000,
  })
  const j = await r.json()
  let t = String(j?.lyric || '')
  if (t && !t.includes('[')) {
    try { t = Buffer.from(t, 'base64').toString('utf8') } catch { /* 本来就是纯文本 */ }
  }
  t = cleanLrc(t)
  return { lyric: LRC_RE.test(t) ? t : '', tlyric: '' }
}
// 酷我歌词：返回 lrclist 数组，自己拼成 LRC。
async function kwLyricById(id) {
  const r = await req(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(id)}`, {
    headers: { Referer: 'https://m.kuwo.cn/' }, timeout: 7000,
  })
  const j = await r.json()
  const t = (j?.data?.lrclist || []).map((row) => {
    const sec = Number(row.time) || 0
    const mm = String(Math.floor(sec / 60)).padStart(2, '0')
    const ss = String(Math.floor(sec % 60)).padStart(2, '0')
    const cs = String(Math.round((sec % 1) * 100)).padStart(2, '0')
    return `[${mm}:${ss}.${cs}]${String(row.lineLyric || '').trim()}`
  }).join('\n')
  const clean = cleanLrc(t)
  return { lyric: LRC_RE.test(clean) ? clean : '', tlyric: '' }
}
async function lyricResolve(title, artist, id, source, fresh = false) {
  const ck = `ly:${norm(title)}|${norm(artist)}|${id || ''}|${norm(source)}`
  if (!fresh) {
    const hit = cget(ck)
    if (hit !== null) return hit
  }
  const tg = norm(title)
  const wantArt = norm(artist)
  const titleOk = (n) => { const t = norm(n); return !!(t && (t.includes(tg) || tg.includes(t))) }
  // 更严格：去掉 (伴奏 / Live / Remix / 电影主题曲…) 等括号后缀、以及「- feat. / – xxx」后再比歌名。
  // 单字歌名（如「哼」「画」）必须完全一致 —— 否则「冯提莫-哼 (Remix)」会被当成「哼」串词。
  const stripVer = (s) => String(s || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, ' ')
    .replace(/[\s\-–—_·]+.*$/, '')
    .replace(/\s+/g, '').trim()
  const strictTitleOk = (n) => {
    const s = stripVer(n)
    if (!s) return false
    if (s === tg) return true
    return tg.length >= 2 && (s.includes(tg) || tg.includes(s))
  }
  // 歌手校验：同名不同歌手（翻唱 / 不同版本）绝不能串词，这是「歌词和歌曲不同步」的主因之一。
  const artistOk = (a) => {
    if (!wantArt) return true
    const n = norm(a)
    return !n || n.includes(wantArt) || wantArt.includes(n)
      || n.split(/[\/&,、\s]+/).some((p) => p && wantArt.includes(p))
  }
  // 同名 DJ / 伴奏 / Live / 翻唱版的时间轴和原曲完全不同，配上就是「歌词和歌曲不同步」。
  // 除非用户点的本来就是这种版本，否则一律跳过。
  const BAD_VER = /(DJ|dj|Remix|remix|伴奏|纯音乐|铃声|试听|片段|Live|live|翻唱|cover)/
  const clean = (n) => !(BAD_VER.test(String(n || '')) && !BAD_VER.test(title))
  // 最可信的一条：曲目自带平台 ID 时直接取该平台的歌词，时间轴与音频同一版本。
  // 旧版只在 source 为空 / netease 时才启用，而 iOS 传的 source 是 wy/tx/kw，
  // 等于这条通道从未生效，全靠按名搜索 → 同名翻唱串词、时间轴对不上。
  const byId = async () => {
    if (!id) return null
    const sc = String(source || '').toLowerCase()
    if (/^(tx|qq|qzone|tencent)$/.test(sc)) return qqLyricById(id).catch(() => null)
    if (/^(kw|kuwo)$/.test(sc)) return kwLyricById(id).catch(() => null)
    return wyLyricById(id).catch(() => null)
  }
  const bySearch = async () => {
    if (!title) return null
    const q = `${title} ${artist}`.trim()
    // 多平台并行搜索：单一 netease 遇到限流(405) 就会整首无词；酷我补上显著提高命中率。
    const [wyRows, kwRows] = await Promise.all([
      wySearch(q, 20).catch(() => []),
      kwSearch(q, 20).catch(() => []),
    ])
    const pick = (rows) => (rows || [])
      .filter((x) => strictTitleOk(x.title) && artistOk(x.artist) && clean(x.title))
      .sort((a, b) => Number(clean(b.title)) - Number(clean(a.title)))
    const plan = [
      ...pick(wyRows).slice(0, 3).map((x) => ({ p: 'wy', id: x.id })),
      ...pick(kwRows).slice(0, 3).map((x) => ({ p: 'kw', id: x.id })),
    ]
    for (const c of plan) {
      const got = c.p === 'kw' ? await kwLyricById(c.id).catch(() => null) : await wyLyricById(c.id).catch(() => null)
      if (got?.lyric) return got
    }
    return null
  }
  const byGd = async () => {
    if (!title) return null
    try {
      const q = encodeURIComponent(`${title} ${artist}`.trim())
      const r = await req(`https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${q}&count=8&pages=1`, { timeout: 6000 })
      const arr = await r.json()
      const rows = (Array.isArray(arr) ? arr : []).slice(0, 8).filter((row) => {
        if (!row?.id || !strictTitleOk(row.name)) return false
        const a = Array.isArray(row.artist) ? row.artist.join('/') : String(row.artist || '')
        return artistOk(a)
      }).sort((x, y) => Number(clean(y.name)) - Number(clean(x.name)))
      for (const row of rows.slice(0, 3)) {
        const rr = await req(`https://music-api.gdstudio.xyz/api.php?types=lyric&source=netease&id=${encodeURIComponent(row.id)}`, { timeout: 6000 })
        const j = await rr.json()
        const ly = cleanLrc(j?.lyric)
        if (LRC_RE.test(ly)) return { lyric: ly, tlyric: '' }
      }
    } catch { /* 镜像抖动 */ }
    return null
  }
  // 三条通道并行，但「按 ID 直取」有 1.4 秒独占窗口：
  // 它的歌词与音频是同一版本，时间轴最准；按名搜索虽快，却常先抢答到同名翻唱版，
  // 旧版正是这样造成「部分歌曲歌词和歌不同步」。窗口过后才放行兜底通道一起竞速。
  const valid = (r) => (r?.lyric && LRC_RE.test(r.lyric) ? r : null)
  const tasks = [byId().catch(() => null), bySearch().catch(() => null), byGd().catch(() => null)]
  const early = await Promise.race([
    tasks[0],
    new Promise((r) => setTimeout(() => r(null), 1400)),
  ]).catch(() => null)
  let got = valid(early)
  if (!got) {
    got = await new Promise((resolve) => {
      let done = false
      let left = tasks.length
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, 8000)
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
      for (const p of tasks) {
        p.then((r) => { const v = valid(r); if (v) finish(v) })
          .catch(() => {})
          .finally(() => { left -= 1; if (left === 0) finish(null) })
      }
    })
  }
  const out = got?.lyric || ''
  const tlyric = got?.tlyric || ''
  return cset(ck, { lyric: out, tlyric }, out ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)
}

// 封面兜底：/api/cover?title=&artist= ─────────────
// 浏览器直连 iTunes 会被 CORS 拦，GD 又常抖，所以统一由服务端代查。
// 命中规则与前端一致：歌名必须对得上，宁可不给封面也不给错的。
async function itunesCover(title, artist) {
  const term = `${title || ''} ${artist || ''}`.trim()
  if (!term) return ''
  const t = norm(title)
  if (!t) return ''
  // country=cn 的 Apple Music 曲库查不到华语歌（实测 resultCount 恒为 0），
  // 台湾区覆盖最好，再退香港区。
  for (const cc of ['tw', 'hk']) {
    try {
      const r = await req(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8&country=${cc}`, { timeout: 7000 })
      const j = await r.json()
      const rows = (Array.isArray(j?.results) ? j.results : []).filter((x) => x?.artworkUrl100)
      const hit = rows.find((x) => {
        const n = norm(x.trackName)
        return n && (n.includes(t) || t.includes(n))
      })
      if (hit) return String(hit.artworkUrl100).replace(/\/\d+x\d+bb\./, '/300x300bb/')
    } catch { /* 换下一个区 */ }
  }
  return ''
}

async function resolveCover(title, artist, album) {
  const ck = `cv:${norm(title)}|${norm(artist)}`
  const hit = cget(ck)
  if (hit !== null) return hit
  let url = await itunesCover(title, artist).catch(() => '')
  if (!url) {
    // 第二档：网易云按「歌名 歌手」搜一次，命中后取 song/detail 的 picUrl
    const rows = await wySearch(`${title} ${artist}`.trim(), 3).catch(() => [])
    const t = norm(title)
    const cand = rows.find((x) => {
      const n = norm(x.title)
      return n && (n === t || n.includes(t) || t.includes(n))
    })
    if (cand) {
      const filled = await wyFillCovers([{ ...cand, cover: '' }]).catch(() => [])
      url = filled[0]?.cover || ''
    }
  }
  return cset(ck, url || '', url ? 6 * 60 * 60 * 1000 : 60 * 1000)
}

// ── 通用代理：浏览器直连会被 CORS 拦的平台接口，统一从服务端转发 ──
// 只放行音乐平台域名，避免被当成开放代理。
const PROXY_HOSTS = [
  'music.163.com', 'interface.music.163.com', 'music.126.net',
  'c.y.qq.com', 'u.y.qq.com', 'y.qq.com', 'i.y.qq.com', 'c6.y.qq.com', 'szc.y.qq.com',
  'search.kuwo.cn', 'www.kuwo.cn', 'mobi.kuwo.cn', 'bd-api.kuwo.cn', 'antiserver.kuwo.cn', 'm.kuwo.cn',
  'mobiles.kugou.com', 'mobilecdn.kugou.com', 'm.kugou.com', 'www.kugou.com', 'songsearch.kugou.com',
  // 封面查询通道：iTunes（带 ACAO 但国内常连不上）与 GD 聚合接口，由服务端代发更稳
  'itunes.apple.com', 'music-api.gdstudio.xyz',
]
function proxyAllowed(target) {
  try {
    const u = new URL(target)
    if (!/^https?:$/.test(u.protocol)) return false
    return PROXY_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
  } catch { return false }
}
async function proxyGet(target, referer) {
  const u = new URL(target)
  const r = await req(target, {
    timeout: 12000,
    headers: { Referer: referer || `https://${u.hostname}/`, Accept: '*/*' },
  })
  const bodyRaw = await r.text()
  return {
    status: r.status,
    ok: r.ok,
    bodyRaw,
    contentType: r.headers.get('content-type') || '',
  }
}

// ── 静态资源 ─────────────────────────────────────
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.normalize(path.join(WWW, rel))
  if (!file.startsWith(WWW)) return false
  let st
  try { st = fs.statSync(file) } catch { return false }
  if (st.isDirectory()) return serveStatic(req, res, rel.replace(/\/?$/, '/') + 'index.html')
  const ext = path.extname(file).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  // 代码/页面一律 no-cache（改版后刷新即生效）；图片字体才长缓存
  const immutable = ['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.svg'].includes(ext)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache, must-revalidate',
    'Accept-Ranges': 'bytes',
  })
  fs.createReadStream(file).pipe(res)
  return true
}

const json = (res, code, data) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

const server = http.createServer(async (r, res) => {
  const url = new URL(r.url, `http://${r.headers.host || 'localhost'}`)
  const p = url.pathname
  if (r.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' })
    return res.end()
  }
  if (!p.startsWith('/api/') && p !== '/health') {
    if (serveStatic(r, res, p)) return
    // 静态没命中：PWA 里未知路径回首页，避免刷新子路由 404
    if (serveStatic(r, res, '/index.html')) return
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not found')
  }
  try {
    if (p === '/health') {
      let indexSize = -1, appSize = -1, appHasNewUi = false
      try { indexSize = fs.statSync(path.join(WWW, 'index.html')).size } catch { /* ignore */ }
      try {
        const buf = fs.readFileSync(path.join(WWW, 'ui', 'app.js'))
        appSize = buf.length
        appHasNewUi = buf.includes('mc-listen')
      } catch { /* ignore */ }
      return json(res, 200, {
        ok: true, cache: cache.size, uptime: Math.round(process.uptime()),
        diag: { wwwIsRoot: WWW === ROOT, indexSize, appSize, appHasNewUi },
      })
    }

    if (p === '/api/search') {
      const q = String(url.searchParams.get('q') || '').trim()
      const limit = Math.min(40, Number(url.searchParams.get('limit')) || 20)
      if (!q) return json(res, 400, { error: 'missing q' })
      const key = `s:${q}|${limit}`
      const hit = cget(key)
      if (hit) return json(res, 200, { q, list: hit, cached: true })
      const [wy, kw] = await Promise.all([
        wySearch(q, limit).catch(() => []),
        kwSearch(q, limit).catch(() => []),
      ])
      await wyFillCovers(wy)
      const seen = new Set()
      const list = []
      const maxLen = Math.max(wy.length, kw.length)
      for (let i = 0; i < maxLen; i++) {
        for (const arr of [kw, wy]) {
          const x = arr[i]
          if (!x) continue
          const k = `${x.source}:${x.id}`
          if (seen.has(k)) continue
          seen.add(k)
          list.push(x)
        }
      }
      return json(res, 200, { q, list: cset(key, list, 5 * 60 * 1000) })
    }

    if (p === '/api/url') {
      const id = String(url.searchParams.get('id') || '').trim()
      const source = String(url.searchParams.get('source') || '').trim()
      const title = String(url.searchParams.get('title') || '').trim()
      const artist = String(url.searchParams.get('artist') || '').trim()
      if (id && source) {
        // QQ / 酷狗等平台的 ID 不能拿去网易云取链（旧实现把 songmid 当网易云 id，
        // 必然 302 到 HTML →「歌单里大部分歌播不了」）。这类曲目统一按歌名+歌手多源解析。
        if (/^(wy|netease|kw|kuwo)$/i.test(source)) {
          const got = await resolveOne({ source, id, title, artist })
          if (got) return json(res, 200, got)
        }
        if (!title) return json(res, 200, { url: '', reason: 'no-source' })
        return json(res, 200, await resolveByText(title, artist, url.searchParams.has('fresh')))
      }
      if (!title) return json(res, 400, { error: 'missing title' })
      return json(res, 200, await resolveByText(title, artist, url.searchParams.has('fresh')))
    }


    if (p === '/api/local' || p.startsWith('/api/local/')) {
      if (!getLocalApi()) {
        return json(res, 200, {
          statusCode: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          bodyRaw: JSON.stringify({ code: 503, data: null, msg: '内置引擎未安装：' + localApiErr }),
        })
      }
      const sub = (p.slice('/api/local'.length) || '/') + (url.search || '')
      const out = await getLocalApi().handle(new URL('localapi://' + (sub.startsWith('/') ? sub : '/' + sub)))
      return json(res, 200, out)
    }

    if (p === '/api/proxy') {
      const target = String(url.searchParams.get('url') || '').trim()
      const referer = String(url.searchParams.get('referer') || '').trim()
      if (!target) return json(res, 400, { error: 'missing url' })
      if (!proxyAllowed(target)) return json(res, 403, { error: 'host not allowed' })
      const key = `p:${target}`
      const hit = cget(key)
      if (hit) return json(res, 200, hit)
      const got = await proxyGet(target, referer)
      // 只缓存成功的 JSON/文本，失败重试
      if (got.ok) cset(key, got, 3 * 60 * 1000)
      return json(res, 200, got)
    }

    if (p === '/api/charts') {
      const type = String(url.searchParams.get('type') || 'hot')
      return json(res, 200, await chart(type))
    }

    // 搜索歌单：/api/search/playlist?q=
    // 只返回「歌单」实体（id/名称/封面/曲目数），不会和单曲结果混在一起。
    if (p === '/api/search/playlist') {
      const q = String(url.searchParams.get('q') || '').trim()
      const limit = Math.min(30, Number(url.searchParams.get('limit')) || 20)
      if (!q) return json(res, 400, { error: 'missing q' })
      const ck = `sp:${q}|${limit}`
      const hit = cget(ck)
      if (hit) return json(res, 200, { q, list: hit, cached: true })
      const fetchList = async () => {
        const r = await req(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(q)}&type=1000&offset=0&total=true&limit=${limit}`, {
          headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }, timeout: 9000,
        })
        const j = await r.json()
        if (j?.code === 405 || j?.msg === '操作频繁，请稍候再试') throw new Error('rate-limit')
        return (j?.result?.playlists || []).map((x) => ({
          id: String(x.id || ''),
          name: String(x.name || '').trim(),
          cover: String(x.coverImgUrl || x.picUrl || '').replace('http://', 'https://'),
          count: Number(x.trackCount || 0),
          creator: String(x.creator?.nickname || ''),
        })).filter((x) => x.id && x.name)
      }
      // 网易云偶发 405（操作频繁）：重试两次再放弃，避免把空结果缓存 10 分钟
      let list = []
      for (let i = 0; i < 3 && !list.length; i++) {
        try { list = await fetchList() } catch { await new Promise((r) => setTimeout(r, 350 * (i + 1))) }
      }
      // 网易云搜索接口常驻 405「操作频繁」：此时不能让 41 个乐库分类全部空白。
      // 用「个性化歌单池」按分类名哈希取 3 张真实歌单（封面/ID 都可点开），
      // 优先挑名字里含分类词的；等搜索接口恢复，刷新页面就会换成分类相关的真歌单。
      if (!list.length) {
        try {
          const poolKey = 'plpool:100'
          let pool = cget(poolKey)
          if (!pool?.length) {
            const pr = await req('https://music.163.com/api/personalized/playlist?limit=100', {
              headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }, timeout: 9000,
            })
            const pj = await pr.json()
            pool = (pj?.result || []).map((x) => ({
              id: String(x.id || ''), name: String(x.name || '').trim(),
              cover: String(x.picUrl || '').replace('http://', 'https://'),
              count: Number(x.trackCount || 0), creator: '',
            })).filter((x) => x.id && x.name && x.cover)
            if (pool.length) cset(poolKey, pool, 20 * 60 * 1000)
          }
          if (pool?.length) {
            let h = 0
            for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) >>> 0
            const hit = pool.filter((x) => x.name.includes(q))
            const base = [...hit, ...pool.filter((x) => !hit.includes(x))]
            const seen = new Set()
            for (let i = 0; i < limit * 3 && list.length < limit && base.length; i++) {
              const p = base[(h + i * 7) % base.length]
              if (!seen.has(p.id)) { seen.add(p.id); list.push(p) }
            }
          }
        } catch { /* 兜底也失败就返回空，下次进入会重试 */ }
      }
      if (!list.length) return json(res, 200, { q, list: [], retry: true })
      return json(res, 200, { q, list: cset(ck, list, 10 * 60 * 1000) })
    }

    // 私荐歌单：列表 + 单张歌单的曲目（Music 页「你的私荐歌单」用）
    if (p === '/api/playlists' || p === '/api/playlist') {
      if (p === '/api/playlist') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) return json(res, 400, { error: 'missing id' })
        const ck = `pl:${id}`
        const hit = cget(ck)
        if (hit) return json(res, 200, { ...hit, cached: true })
        const r = await req(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, {
          headers: { Referer: 'https://music.163.com/' }, timeout: 9000,
        })
        const j = await r.json()
        const rr = j?.result || {}
        const tracks = (rr.tracks || []).slice(0, 100).map((s) => ({
          source: 'wy',
          id: String(s.id || ''),
          title: s.name || '',
          artist: (s.artists || s.ar || []).map((a) => a.name).filter(Boolean).join('/'),
          album: s.album?.name || s.al?.name || '',
          cover: String(s.album?.picUrl || s.al?.picUrl || '').split('http://').join('https://'),
          durationMs: Number(s.duration || s.dt || 0),
        })).filter((x) => x.title)
        const payload = { id, name: rr.name || '', cover: String(rr.coverImgUrl || '').replace('http://', 'https://'), tracks }
        return json(res, 200, cset(ck, payload, 30 * 60 * 1000))
      }
      const n = Math.min(12, Number(url.searchParams.get('n')) || 6)
      const fresh = url.searchParams.has('fresh')
      const ck = `pls:${n}`
      const hit = fresh ? null : cget(ck)
      if (hit) return json(res, 200, { list: hit, cached: true })
      const r = await req(`https://music.163.com/api/personalized/playlist?limit=${Math.max(8, n + 2)}`, {
        headers: { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }, timeout: 9000,
      })
      const j = await r.json()
      const list = (j?.result || []).slice(0, n).map((x) => ({
        id: String(x.id || ''),
        name: String(x.name || ''),
        cover: String(x.picUrl || '').replace('http://', 'https://'),
        count: Number(x.trackCount || 0),
        play: Number(x.playCount || 0),
      })).filter((x) => x.id && x.name)
      return json(res, 200, { list: cset(ck, list, 20 * 60 * 1000) })
    }

    // 歌词（iOS 端第三方接口全被 CORS 拦，统一走这里）
    if (p === '/api/lyric') {
      const title = String(url.searchParams.get('title') || '').trim()
      const artist = String(url.searchParams.get('artist') || '').trim()
      const id = String(url.searchParams.get('id') || '').trim()
      const source = String(url.searchParams.get('source') || '').trim()
      if (!title && !id) return json(res, 400, { error: 'missing title' })
      const got = await lyricResolve(title, artist, id, source, url.searchParams.has('fresh'))
      return json(res, 200, { lyric: (got && got.lyric) || '', tlyric: (got && got.tlyric) || '' })
    }

    // 封面兜底（前端 covers.js 在 iOS 上直接打这个接口）
    if (p === '/api/cover') {
      const title = String(url.searchParams.get('title') || '').trim()
      const artist = String(url.searchParams.get('artist') || '').trim()
      const album = String(url.searchParams.get('album') || '').trim()
      if (!title) return json(res, 400, { error: 'missing title' })
      const u = await resolveCover(title, artist, album)
      return json(res, 200, { url: u || '' })
    }

    // 三个聚合入口：新鲜探索 / 热歌熟悉 / 私人推荐
    // 全部「多平台混排 + 同名同歌手去重」，一屏里既有 QQ 也有网易云。
    if (p === '/api/new' || p === '/api/rank' || p === '/api/recommend') {
      const want = Math.min(60, Number(url.searchParams.get('n')) || 0)
      // 私人推荐：每次进入都要换一批（用户要求）。池子缓存 10 分钟保证打开速度，
      // 每次请求从池子里随机抽 want 首，顺序也打乱 —— 同一个池子能出很多不同的组合。
      const poolKey = `${p}:pool`
      if (p === '/api/recommend') {
        const wantN = want || 6
        // 续杯去重：前端把已听过的规范化歌名用 || 拼过来，这里从池子里剔除，
        // 保证「全新的 6 首」不会换回刚听过的歌。
        const excl = new Set(String(url.searchParams.get('exclude') || '')
          .split('||').map(norm).filter(Boolean))
        const fit = (tracks) => tracks.filter((x) => !excl.has(norm(x.title)))
        const buildPool = async () => {
          const [lists, qqHot] = await Promise.all([
            playlistTracks(4).catch(() => []),
            qqToplist(26, 30).catch(() => []),
          ])
          const wyHot = await chart('hot').then((c) => c.tracks.slice(0, 30)).catch(() => [])
          const pool = { name: '私人推荐', tracks: mixTracks([lists, wyHot, qqHot], 120) }
          cset(poolKey, pool, 10 * 60 * 1000)
          return pool
        }
        let pool = cget(poolKey)
        if (!pool?.tracks?.length) pool = await buildPool()
        let cand = fit(pool.tracks)
        // 池子被听空（连听十几批后）→ 重建一次，重新拉一批歌单/榜单曲目
        if (cand.length < wantN) {
          pool = await buildPool()
          cand = fit(pool.tracks)
        }
        // 极端情况下仍不足：放宽去重，但不给少于 1 首的空列表
        const poolForPick = cand.length >= 1 ? cand : pool.tracks
        const tracks = shuffleTake(poolForPick, wantN)
        return json(res, 200, { name: '私人推荐', tracks, count: tracks.length })
      }
      const hit = cget(p)
      if (hit) return json(res, 200, { ...hit, cached: true })
      let payload
      if (p === '/api/new') {
        const [wyNew, qqNew, wyChart] = await Promise.all([
          wyNewsong(30).catch(() => []),
          qqToplist(27, 30).catch(() => []),
          chart('new').then((c) => c.tracks.slice(0, 20)).catch(() => []),
        ])
        payload = { name: '新鲜探索', tracks: mixTracks([wyNew, qqNew, wyChart], want || 60) }
      } else {
        const [qqHot, qqRise, wyHot] = await Promise.all([
          qqToplist(26, 30).catch(() => []),
          qqToplist(4, 30).catch(() => []),
          chart('hot').then((c) => c.tracks.slice(0, 30)).catch(() => []),
        ])
        payload = { name: '热歌熟悉', tracks: mixTracks([qqHot, wyHot, qqRise], want || 60) }
      }
      if (!payload.tracks.length) payload.reason = 'no-source'
      return json(res, 200, cset(p, payload, payload.tracks.length ? 20 * 60 * 1000 : 60 * 1000))
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`orange-music-api + pwa listening on ${PORT}`)
  // 启动即预热：榜单 / 新歌 / 巅峰榜先填进缓存，用户第一次点开就是秒出。
  // 放在 listen 之后异步跑，不阻塞首屏；失败也只是少一层缓存。
  setTimeout(() => {
    Promise.allSettled([
      chart('hot'), chart('rise'), chart('new'),
      qqToplist(26, 30).catch(() => []),
      qqToplist(4, 30).catch(() => []),
      qqToplist(27, 30).catch(() => []),
    ]).then(() => console.log('[warm] 榜单预热完成'))
  }, 800)
})
