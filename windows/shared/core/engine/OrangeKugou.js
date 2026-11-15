// 酷狗音乐适配器（匿名公开接口，无需签名/cookie/会员）。
// 搜索：songsearch.kugou.com/song_search_v2（覆盖率高，实测 97.5%）
// 取链：m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=（实测无需签名即返回完整直链）
// 歌词：krcs 搜索 + 下载
// 说明：付费曲（Privilege=10）该接口返回空 url，属平台版权限制，非代码问题；调用方应继续尝试其他源。

const KG_HEADERS = {
  Referer: 'https://www.kugou.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
}
const KG_MOBILE_UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' }

const httpsify = (u) => String(u || '').replace(/^http:/i, 'https:')

export function createKugou(request) {
  async function getJson(url, headers = KG_HEADERS, timeout = 12000) {
    const r = await request(url, { method: 'GET', headers, timeout })
    if (!r || r.statusCode < 200 || r.statusCode >= 400) throw new Error('酷狗请求失败 ' + (r && r.statusCode))
    const text = String(r.bodyText ?? r.bodyRaw ?? '')
    if (!text) throw new Error('酷狗空响应')
    try { return JSON.parse(text) } catch { throw new Error('酷狗响应解析失败') }
  }

  // 搜索：返回标准化 track（id 用 FileHash；albumAudioId/privilege 放进 extra 供取链优选）
  async function search(keyword, limit = 30, page = 1) {
    const url = 'https://songsearch.kugou.com/song_search_v2'
      + `?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${Math.min(limit, 30)}`
      + '&platform=WebFilter&userid=0&clientver=2000&iscorrection=1&privilege_filter=0&filter=10'
    const j = await getJson(url)
    const list = (j && j.data && j.data.lists) || []
    return list.map((s) => ({
      platform: 'kugou',
      id: String(s.FileHash || ''),
      title: String(s.SongName || '').replace(/<[^>]+>/g, ''),
      artist: String(s.SingerName || '').replace(/<[^>]+>/g, ''),
      album: String(s.AlbumName || ''),
      duration: Number(s.Duration) || 0,
      cover: '',   // 酷狗封面需要额外接口，交给上层封面模块补充
      privilege: Number(s.Privilege) || 0,
      albumAudioId: String(s.Audioid || ''),
      qualities: ['standard', 'higher'],
      pending: true,
    })).filter((t) => t.id && t.title)
  }

  // 取链：移动端接口直接返回完整直链（无需签名）。返回 { url, quality, trial:false }
  async function resolve(track) {
    const hash = track && track.id
    if (!hash) throw new Error('缺少酷狗 hash')
    const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`
    const j = await getJson(url, KG_MOBILE_UA, 12000)
    // url 可能是字符串；backup_url 可能是字符串/数组/对象，统一取第一个字符串
    const pick = (v) => {
      if (typeof v === 'string') return v
      if (Array.isArray(v)) { for (const x of v) { const s = pick(x); if (s) return s } return '' }
      if (v && typeof v === 'object') return pick(v.url || v.backup_url || '')
      return ''
    }
    const raw = pick(j && j.url) || pick(j && j.backup_url)
    if (!raw) {
      const priv = j && j.privilege
      throw new Error(priv === 10 ? '酷狗付费曲（版权限制，无会员不可取）' : '酷狗未返回直链')
    }
    return { url: httpsify(raw), quality: (Number(j.bitRate) || 128) >= 320 ? 'exhigh' : 'standard', trial: false }
  }

  // 歌词：搜索候选 → 取 krc/lrc（酷狗歌词是 krc 加密，公开接口可拿 base64 krc 或 lrc）
  async function lyric(track) {
    try {
      const kw = `${track.title || ''} ${track.artist || ''}`.trim()
      const s = await getJson('https://lyrics.kugou.com/search'
        + `?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(kw)}&duration=${Math.round((track.durationMs || 0) / 1000)}&hash=${encodeURIComponent(track.id || '')}`)
      const cand = (s && s.candidates && s.candidates[0]) || null
      if (!cand) return { lyric: '', trans: '' }
      const d = await getJson('https://lyrics.kugou.com/download'
        + `?ver=1&client=pc&id=${encodeURIComponent(cand.id)}&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8`)
      let text = String((d && d.content) || '')
      try { text = decodeURIComponent(escape(atob(text))) } catch { /* 有些直接是明文 */ }
      return { lyric: text || '', trans: '' }
    } catch {
      return { lyric: '', trans: '' }
    }
  }

  return { search, resolve, lyric }
}
