// 波点取链适配器（渲染端）：通过 localapi:///bodian 让主进程调用 UNM 的 bodian 提供者。
// 优势：按「歌名 + 歌手」直接取完整音频链，不依赖任何平台 ID，能覆盖网易云没有的付费曲。
// Windows 由 Electron 主进程内嵌 UNM 承接；iOS 由同源 /api/local 承接（服务端跑同一份 local-api.cjs）。
// 两端因此走完全相同的音源逻辑，命中率一致。
const BUILTIN_BASE = 'localapi://'

const isEngineHost = () => {
  if (typeof document === 'undefined') return false
  const plat = document.documentElement.dataset.platform
  if (plat === 'ios') return true          // iOS：localapi:// 由 bridge 转成 /api/local
  if (plat !== 'windows') return false
  return typeof location === 'undefined' || /^(app|file):/.test(location.protocol)
}

/**
 * 按歌名+歌手取链。
 * @param {{title?:string, artist?:string, durationMs?:number}} track
 * @param {Function} request —— 注入的统一请求器（返回 { statusCode, bodyText/bodyRaw }）
 * @returns {Promise<{url,name,artist,album,duration}|null>} 直链 + 实际命中的曲目元数据；严格匹配不到返回 null
 */
export async function bodianResolve(track, request) {
  if (!isEngineHost() || !request) return null
  const title = String(track?.title || '').trim()
  const artist = String(track?.artist || '').trim()
  if (!title) return null
  const keyword = `${title} ${artist}`.trim()
  const dur = Number(track?.durationMs) > 0 ? String(Math.round(Number(track.durationMs))) : '0'
  const url = `${BUILTIN_BASE}/bodian?keyword=${encodeURIComponent(keyword)}&duration=${dur}`
    + `&name=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
    + `&album=${encodeURIComponent(String(track?.album || ''))}`
  try {
    const r = await request(url, { method: 'GET', timeout: 30000 })
    const text = String(r?.bodyText ?? r?.bodyRaw ?? '')
    if (!text) return null
    const j = JSON.parse(text)
    const d = j && j.data
    const u = d && d.url
    if (typeof u !== 'string' || !/^https?:/i.test(u)) return null
    // 带回归宿实际命中的曲目：渲染端会再校验一次歌名 / 歌手，防止「点 A 播 B」
    return {
      url: u,
      name: String(d.name || ''),
      artist: String(d.artist || ''),
      album: String(d.album || ''),
      duration: Number(d.duration) || 0,
    }
  } catch {
    return null
  }
}

export default { bodianResolve }
