/**
 * 内置音乐 API（零部署）——把 api-enhanced 的主进程函数直接接进网络层。
 *
 * 设计：渲染端 musicapi.js 照常发「HTTP 请求」到 localapi:// 这个伪 scheme，
 * 主进程 handleNet 拦截后交给本模块：解析 path/query → 调用 api-enhanced 函数 →
 * 返回 { statusCode, bodyRaw }，对外表现和一个真实音乐 API 服务完全一样。
 *
 * 因此：用户什么都不用填、不用装、不用部署；Windows exe 开箱即有搜索/取链/歌词/解灰。
 * iOS 网页端没有这个 scheme，仍走用户填的「音乐 API 地址」或边缘函数，行为不变。
 */
'use strict'
const path = require('node:path')
const { proxyNet } = require('./net.cjs')

// api-enhanced 依赖随 asar 打包；用 createRequire 兼容 CJS。
const API_DIR = path.join(__dirname, 'node_modules', '@neteasecloudmusicapienhanced', 'api')
let _api = null
let _initErr = null
function getApi() {
  if (_api) return _api
  if (_initErr) throw _initErr
  try {
    // 解灰 / 随机国内 IP 等环境变量，对齐官方推荐配置
    process.env.ENABLE_GENERAL_UNBLOCK = process.env.ENABLE_GENERAL_UNBLOCK || 'true'
    process.env.ENABLE_FLAC = process.env.ENABLE_FLAC || 'true'
    process.env.ENABLE_RANDOM_CN_IP = process.env.ENABLE_RANDOM_CN_IP || 'true'
    process.env.CORS_ALLOW_ORIGIN = '*'
    _api = require(path.join(API_DIR, 'main.js'))
    return _api
  } catch (e) {
    _initErr = new Error('内置音乐引擎加载失败：' + (e && e.message))
    throw _initErr
  }
}

// api-enhanced 的函数返回 { status, body, cookie }；统一取 body。
async function invoke(fn, args = {}) {
  const api = getApi()
  if (typeof api[fn] !== 'function') throw new Error('内置引擎无此接口：' + fn)
  const r = await api[fn](args)
  // 部分接口直接返回 body，部分返回 {status,body}
  return r && typeof r === 'object' && 'body' in r ? r.body : r
}

const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d }

// ── 主力取链源：UNM 的 bodian 提供者（酷我搜索 + 波点音频接口）──
// 关键优势：它接受「歌名 + 歌手」关键词直接搜索取链，**不依赖网易云 ID**，
// 因此网易云没有版权的付费曲（周杰伦等）也能拿到完整音频。
//
// ★ 但 UNM 自带的 provider/select.js 只在前 5 条里按时长挑，**完全不校验歌名/歌手**，
//   没有时长匹配就 `return list[0]` —— 这就是「列表写《一分一寸 - 阿YueYue》，
//   播出来却是《沈园外》男声」的根因。这里不再用 b.check()，改成自己搜索 + 严格匹配，
//   只把匹配到的那个 id 交给 b.track() 取链，并把匹配到的元数据回传渲染端再校验一次。
const UNM_DIR = path.join(__dirname, 'node_modules', '@unblockneteasemusic', 'server')
let _bodian = null
let _bodianErr = null
function getBodian() {
  if (_bodian) return _bodian
  if (_bodianErr) throw _bodianErr
  try {
    process.env.DISABLE_FLAC = 'false'
    _bodian = require(path.join(UNM_DIR, 'src', 'provider', 'bodian'))
    return _bodian
  } catch (e) {
    _bodianErr = new Error('波点取链模块加载失败：' + (e && e.message))
    throw _bodianErr
  }
}

const normText = (s) => String(s || '').toLowerCase()
  .replace(/[\s\u3000]/g, '')
  .replace(/[()（）[\]【】<>《》"'`·,，、&+!！?？.。:：;；\-—_~｜|]/g, '')
const stripTags = (s) => String(s || '').replace(/[（(【[][^)）\]】]*[)）\]】]/g, '').trim()
const artistParts = (s) => normText(s).split(/[、,，&/|]+/).filter((x) => x.length >= 2)

function bodianMatchOk(want, got) {
  const a = normText(stripTags(want.title))
  const b = normText(stripTags(got.name))
  if (!a || !b) return false
  // 歌名：完全一致，或短名被长名包含（允许 "(Live)" / "(DJ版)" 这类副标题），长度差不能太大
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  const titleOk = a === b || (short.length >= 3 && long.length - short.length <= 6 && long.includes(short))
  if (!titleOk) return false
  // 歌手：完整串相等 / 互相包含，或任一别名分词命中
  const wa = normText(want.artist)
  const ga = normText(got.artist)
  if (wa && ga) {
    const wp = artistParts(want.artist)
    const gp = artistParts(got.artist)
    const hit = wa === ga || wa.includes(ga) || ga.includes(wa)
      || wp.some((x) => gp.some((y) => x === y || x.includes(y) || y.includes(x)))
    if (!hit) return false
  } else if (wa && !ga) return false
  // 时长：两边都有时差 15 秒内
  const d1 = Number(want.durationMs) || 0
  const d2 = Number(got.duration) || 0
  if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > 15000) return false
  return true
}

async function bodianStrict(b, info) {
  const keyword = String(info.keyword || '').replace(' - ', ' ').trim()
  if (!keyword) return null
  const url = 'http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8'
    + '&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' + encodeURIComponent(keyword)
  const r = await proxyNet(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', Referer: 'http://www.kuwo.cn/' },
  }, 9000)
  let j
  try { j = JSON.parse(String(r.bodyRaw || '')) } catch { return null }
  const list = j?.content?.[1]?.musicpage?.abslist || []
  const rows = list.map((s) => ({
    id: String(s.MUSICRID || '').split('_').pop(),
    name: String(s.SONGNAME || ''),
    artist: String(s.ARTIST || ''),
    album: String(s.ALBUM || ''),
    duration: (Number(s.DURATION) || 0) * 1000,
  })).filter((x) => x.id && x.name)
  const want = { title: info.name || '', artist: info.artist || '', durationMs: info.duration || 0 }
  // ★ 绝不 fallback 到 list[0]：宁可换源/提示，也不能播错歌
  const matched = rows.find((x) => bodianMatchOk(want, x))
  if (!matched) return null
  const audioUrl = await Promise.race([
    Promise.resolve(b.track(matched.id)),
    new Promise((res) => setTimeout(() => res(''), 12000)),
  ]).catch(() => '')
  if (!audioUrl || !/^https?:/i.test(String(audioUrl))) return null
  return {
    url: String(audioUrl).replace(/^http:/i, 'https:'),
    name: matched.name, artist: matched.artist, album: matched.album,
    duration: matched.duration, id: matched.id,
  }
}

/**
 * 处理一个 localapi:// 伪请求。
 * @param {URL} u —— localapi:///search?keywords=... 形式（host 为空，pathname 是端点）
 * @returns {Promise<{statusCode:number, headers:object, bodyRaw:string}>}
 */
async function handle(u) {
  const ep = decodeURIComponent(u.pathname || '/').replace(/\/+$/, '') || '/'
  const q = u.searchParams
  const json = (code, obj) => ({
    statusCode: code,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyRaw: JSON.stringify(obj),
  })
  try {
    let body
    switch (ep) {
      case '/inner/version':
        return json(200, { code: 200, data: { version: 'builtin' } })

      // 主力取链：按「歌名 + 歌手」直接取完整音频链（酷我搜索 + 波点接口，不依赖网易云 ID）。
      case '/bodian': {
        const keyword = q.get('keyword') || q.get('kw') || ''
        if (!keyword) return json(400, { code: 400, data: null, msg: '缺少 keyword' })
        const b = getBodian()
        const info = {
          keyword,
          name: q.get('name') || '',
          artist: q.get('artist') || '',
          album: q.get('album') || '',
          duration: n(q.get('duration'), 0),   // 毫秒
        }
        const out = await Promise.race([
          bodianStrict(b, info),
          new Promise((r) => setTimeout(() => r(null), 25000)),
        ]).catch(() => null)
        if (!out?.url) return json(200, { code: 404, data: null, msg: '未找到歌名与歌手都匹配的曲目（不播放无关结果）' })
        return json(200, { code: 200, data: out })
      }

      case '/search': {
        body = await invoke('search', {
          keywords: q.get('keywords') || q.get('s') || '',
          type: n(q.get('type'), 1),
          limit: n(q.get('limit'), 30),
          offset: n(q.get('offset'), 0),
        })
        return json(200, body || { result: { songs: [] } })
      }

      case '/song/url': {
        const id = q.get('id')
        if (!id) return json(400, { code: 400, data: [] })
        body = await invoke('song_url', { id, br: n(q.get('br'), 320000) })
        return json(200, body || { data: [] })
      }

      case '/song/url/v1': {
        const id = q.get('id')
        if (!id) return json(400, { code: 400, data: [] })
        body = await invoke('song_url_v1', { id, level: q.get('level') || 'exhigh' })
        return json(200, body || { data: [] })
      }

      // 显式解灰：api-enhanced v4.41 的 /song/url/match，返回 {code:200, data:"url字符串"}
      case '/song/url/match':
      case '/match': {
        const id = q.get('id')
        if (!id) return json(400, { code: 400, data: [] })
        const source = q.get('source') || undefined
        body = await invoke('song_url_match', source ? { id, source } : { id })
        return json(200, body || { code: 500, data: [] })
      }

      case '/song/enhance/url': {
        const id = q.get('id')
        if (!id) return json(400, { code: 400, data: [] })
        body = await invoke('song_url', { id, br: 320000 })
        return json(200, body || { data: [] })
      }

      case '/lyric': {
        const id = q.get('id')
        if (!id) return json(400, { code: 200, lrc: { lyric: '' }, tlyric: { lyric: '' } })
        body = await invoke('lyric', { id })
        return json(200, body || { lrc: { lyric: '' }, tlyric: { lyric: '' } })
      }

      default:
        return json(404, { code: 404, msg: '内置引擎无此端点：' + ep })
    }
  } catch (e) {
    return json(200, { code: 500, data: [], msg: (e && e.message) || '内置引擎错误' })
  }
}

module.exports = { handle, getApi, bodianMatchOk, bodianStrict, getBodian }
