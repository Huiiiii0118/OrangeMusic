// 音乐 API 后端适配器：兼容 NeteaseCloudMusicApi / NeteaseCloudMusicApiEnhanced（内置 UNM 解灰）
// 与 UnblockNeteaseMusic 系服务。服务端完成签名 / 加密 / 取链（含灰歌解灰），前端只发普通 HTTP 请求，
// 稳定得多，iOS / Windows 通用（这些服务大多自带 CORS）。
//
// 仅作「个人使用」的中转：不缓存音频、不转码、不存储任何音频内容，只透传元数据与直链。
//
// 兼容端点（不同版本路径 / 字段有差异，适配器按候选顺序容错解析）：
//   搜索  GET {base}/search?keywords=K&type=1&limit=N           → {result:{songs:[...]}} 或 {songs:[...]}
//   取链  GET {base}/song/url/v1?id=ID&level=exhigh              → {data:[{url,br,...}]}（api-enhanced 主推）
//         备选 {base}/song/url?id=ID&br=320000 / {base}/song/enhance/url?id=ID / {base}/match?id=ID（UNM 解灰）
//   歌词  GET {base}/lyric?id=ID                                 → {lrc:{lyric},tlyric:{lyric}}

const asStr = (v) => (typeof v === 'string' ? v : '')

function brToQuality(br) {
  const b = Number(br) || 0
  if (b >= 700000) return 'lossless'
  if (b >= 320000) return 'exhigh'
  if (b >= 192000) return 'higher'
  return 'standard'
}

// 部分公共实例部署在海外，网易会按来源 IP 限流 / 拒链；realIP 让服务端带上一个国内 IP 去请求网易。
// 这里每次随机给一个国内 IP（仅作请求标识，不涉及真实用户 IP），显著提高取链成功率。
const CN_IP_POOL = [
  '116.25.146.177', '202.96.134.133', '222.73.29.42', '111.206.221.110',
  '123.125.71.38', '219.141.136.10', '180.101.49.12', '59.37.96.130',
  '113.116.48.20', '221.179.44.66',
]
const realIpParam = () => '&realIP=' + CN_IP_POOL[(Math.random() * CN_IP_POOL.length) | 0]

// 容错取数组 / 对象
function pickList(j, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), j)
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') return [v]
  }
  return []
}

function normalizeSong(s) {
  if (!s) return null
  const artists = s.artists || s.ar || []
  const album = s.album || s.al || {}
  return {
    platform: 'netease',
    id: String(s.id),
    title: s.name || s.title || '',
    artist: (Array.isArray(artists) ? artists : []).map((a) => a && a.name).filter(Boolean).join('/') || (s.artist || '未知'),
    album: album.name || album.title || '',
    duration: Math.round((Number(s.duration || s.dt) || 0) / 1000),
    cover: album.picUrl || album.cover || s.cover || '',
    qualities: ['standard', 'higher', 'exhigh', 'lossless'],
    pending: true,
  }
}

export function createMusicApi(request, base) {
  const rawBase = String(base || '')
  // 内置引擎用 localapi:// 伪 scheme（主进程拦截后直接调函数）。它必须保留双斜杠：
  // 若按普通 http(s) base 剥掉尾部斜杠，localapi:// → localapi:，拼出 localapi:/search（单斜杠），
  // 与 bridge.js / main.cjs 的 localapi 识别不匹配 → 请求全灭、内置引擎形同虚设（v1.8.0 实测回归）。
  const IS_BUILTIN = /^localapi:\/\//i.test(rawBase)
  // localapi:// 原样保留（拼 ${B}/search → localapi:///search，三斜杠、空 host、pathname=/search）；
  // http(s) base 才去掉尾部斜杠。
  const B = IS_BUILTIN ? rawBase : rawBase.replace(/\/+$/, '')
  if (!B) throw new Error('音乐 API 地址为空')
  // localapi 是主进程内函数调用，不需要 realIP（那是给海外 http 实例绕过网易 IP 限流用的）。
  const rip = () => (IS_BUILTIN ? '' : realIpParam())

  async function getJson(url, timeout = 12000) {
    const r = await request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 OrangeMusic/1.0' },
      timeout,
    })
    if (!r || typeof r.statusCode !== 'number' || r.statusCode >= 400) {
      throw new Error('音乐 API 请求失败 ' + (r && r.statusCode))
    }
    try {
      let t = String(r.bodyText ?? r.bodyRaw ?? '{}').trim()
      if (!t) throw new Error('音乐 API 空响应')
      // 先按普通 JSON 解析；失败再尝试剥 JSONP 包裹（callback(...) 或 /**/(...)）。
      // 不能一上来就用正则剥：歌名里常带括号（如「晴天 (原唱 周杰伦)」），
      // 会被误判成 JSONP 把 JSON 切坏，导致搜索解析失败、静默返回空 → 界面无歌。
      try { return JSON.parse(t) } catch { /* 可能是 JSONP */ }
      const m = t.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\)\s*;?\s*$/)
        || t.match(/^\/\*[\s\S]*?\*\/\s*\(([\s\S]*)\)\s*;?\s*$/)
      if (m && m[1]) { try { return JSON.parse(m[1]) } catch { /* 仍失败 */ } }
      throw new Error('音乐 API 响应解析失败')
    } catch (e) {
      throw new Error('音乐 API 响应解析失败：' + (e && e.message))
    }
  }

  async function search(keyword, limit = 30) {
    try {
      const url = `${B}/search?keywords=${encodeURIComponent(keyword)}&type=1&limit=${limit}${rip()}`
      const j = await getJson(url)
      const songs = pickList(j, ['result.songs', 'songs', 'result.list'])
      return songs.map(normalizeSong).filter((n) => n && n.id && n.title)
    } catch { return [] }
  }

  // 解析各版本取链响应，并识别「试听片段」。
// 实测：未登录时 /song/url/v1 对 VIP 曲返回 45 秒片段，形如
//   { url, br:128008, size:720813, freeTrialInfo:{ start:0, end:45 } }
// 以前不看 freeTrialInfo，把片段当完整歌播 → 45 秒就断，用户感知「不能播 / 只有片段」。
function parseUrlPayload(j) {
  // 形态① 解灰端点 /song/url/match（api-enhanced v4.41+）：{ code:200, data:"http://....flac" }
  //   这是完整文件（第三方音源），是 VIP / 无版权曲能播的关键。
  if (j && typeof j.data === 'string' && /^https?:\/\//i.test(j.data)) {
    return { url: String(j.data).replace(/^http:/i, 'https:'), quality: 'lossless', br: 0, size: 0, trial: false, trialSeconds: 0 }
  }
  // 形态② UNM-Server /match：{ code:200, data:{ url:"..." } }
  if (j && j.data && typeof j.data === 'object' && typeof j.data.url === 'string' && /^https?:\/\//i.test(j.data.url)) {
    return { url: String(j.data.url).replace(/^http:/i, 'https:'), quality: 'lossless', br: Number(j.data.br) || 0, size: Number(j.data.size) || 0, trial: false, trialSeconds: 0 }
  }
  // 形态③ 标准 /song/url、/song/url/v1：{ data:[{url,br,size,freeTrialInfo,...}] }
  const list = pickList(j, ['data', 'data.songs', 'songs', 'songs.data'])
  const d = list[0]
    || (j && j.data && !Array.isArray(j.data) ? j.data : null)
    || (j && j.url ? j : null)
  if (!d) return null
  const u = d.url || (d.data && d.data.url)
  if (!u) return null
  const ft = d.freeTrialInfo || (d.data && d.data.freeTrialInfo) || null
  // 非试听时该字段恒为 null；一旦是对象就带 start/end，说明是限时试听片段（实测 45s）
  const trial = !!(ft && typeof ft === 'object')
  const size = Number(d.size) || 0
  const br = Number(d.br) || 0
  return {
    url: String(u).replace(/^http:/i, 'https:'),
    quality: brToQuality(br),
    br, size,
    trial,
    trialSeconds: trial ? Math.max(0, Number(ft.end || 0) - Number(ft.start || 0)) : 0,
  }
}

// 并发取链：拿到「完整链」立即返回；超时则返回已收到的最好结果（片段也保留并标记）。
function raceParse(urls, budgetMs, timeoutMs) {
  const hits = []
  let pending = urls.length
  return new Promise((resolve, reject) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!hits.length) { reject(new Error('无直链')); return }
      hits.sort((a, b) => (Number(a.trial) - Number(b.trial)) || (a.priority - b.priority))
      resolve(hits[0])
    }
    const timer = setTimeout(finish, budgetMs)
    urls.forEach((url, i) => {
      getJson(url, timeoutMs)
        .then((j) => {
          try {
            const p = parseUrlPayload(j)
            if (p && p.url) {
              hits.push({ ...p, priority: i })
              if (!p.trial) { finish(); return }   // 完整链，立即返回
            }
          } catch { /* 单候选解析失败跳过 */ }
          if (--pending === 0) finish()
        })
        .catch(() => { if (--pending === 0) finish() })
    })
  })
}

async function resolve(track) {
  const id = track.id
  if (!id) throw new Error('缺少 id')
  const eid = encodeURIComponent(id)

  // 阶段①：普通取链端点（快，通常 0.3~1s）。免费歌拿完整链立即返回，不等解灰。
  const normal = [
    `${B}/song/url?id=${eid}&br=320000${rip()}`,
    `${B}/song/url/v1?id=${eid}&level=exhigh${rip()}`,
    `${B}/song/url?id=${eid}&br=128000${rip()}`,
    `${B}/song/url/v1?id=${eid}&level=standard${rip()}`,
    `${B}/song/enhance/url?id=${eid}${rip()}`,
  ]
  let first
  try { first = await raceParse(normal, 7000, 6500) } catch { /* 继续解灰 */ }
  if (first && !first.trial) return first   // 免费歌：完整链，直接给

  // 阶段②：只有片段（或全空）→ 显式解灰。api-enhanced v4.41+ 端点是 /song/url/match，
  //   返回 {code:200, data:"http://...flac"}（完整第三方文件）；老服务无此端点会 404，忽略即可。
  //   UNM-Server 系则是 /match?id=（返回 {data:{url}}），一并兼容。
  let unblocked
  try {
    unblocked = await raceParse([
      `${B}/song/url/match?id=${eid}`,
      `${B}/match?id=${eid}`,
    ], 16000, 15000)
  } catch { /* 该服务不支持解灰 */ }
  if (unblocked && !unblocked.trial) return { ...unblocked, unblocked: true }

  // 解灰也拿不到：退回片段（带 trial 标记，上层会提示/换源），或抛出
  if (first) return first
  if (unblocked) return unblocked
  throw new Error('音乐 API 未返回直链（可能无版权/灰歌）')
}

  async function lyric(track) {
    try {
      const url = `${B}/lyric?id=${encodeURIComponent(track.id)}${rip()}`
      const j = await getJson(url, 10000)
      const lrc = j && j.lrc && typeof j.lrc === 'object' ? j.lrc.lyric : (j && j.lrc)
      const tly = j && j.tlyric && typeof j.tlyric === 'object' ? j.tlyric.lyric : (j && j.tlyric)
      return {
        lyric: asStr(lrc) || asStr(j && j.lyric) || asStr(j && j.data && j.data.lyric),
        trans: asStr(tly) || asStr(j && j.data && j.data.tlyric),
      }
    } catch {
      return { lyric: '', trans: '' }
    }
  }

  return { search, resolve, lyric }
}

export { brToQuality, normalizeSong }
