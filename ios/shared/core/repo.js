import { cloud, isLocalOnly } from './cloud.js'
import { requireSession } from './auth.js'

// 云库只保留两张表：user_state（KV + JSONB，存歌单/收藏/播放态/推荐缓存/音源配置）
// 与 play_events（追加型行为流，喂实时推荐）。两端读写同一份 = 随时切换设备。
// 离线试用：cloud 为 null 时读写同源 localStorage，接口完全一致，登录后自动切回云端。
const db = () => cloud.database
const K = Object.freeze({
  playlist: (id) => `playlist:${id}`,
  favorites: 'favorites',
  recent: 'recent',
  playback: 'playback',            // 双端续播
  recommend: 'recommend',          // 推荐结果缓存（跨端共享）
  sources: 'sources',              // 用户自配置合规音源端点
  profile: 'profile',
})
export const keys = K

const LS = 'orangemusic:v1:'
const lsGet = (k, fallback = null) => {
  try { const v = localStorage.getItem(LS + k); return v == null ? fallback : JSON.parse(v) } catch { return fallback }
}
const lsSet = (k, v) => localStorage.setItem(LS + k, JSON.stringify(v))
const stateKey = (key) => `state:${key}`

async function ownerName() {
  const s = await requireSession()
  return s.user.name ?? null
}

// 本地镜像：歌单/收藏等始终在本机保留一份，退出登录、云端停服都不丢。
// 登录后以云端为准做差异同步（见 mergeLocalOnLogin），本机只是镜像 + 离线缓存。
export const mirrorSet = (key, value) => { try { lsSet(stateKey(key), value) } catch { /* noop */ } }
export const mirrorGet = (key) => lsGet(stateKey(key))
export const mirrorKeys = () => {
  const out = [], prefix = LS + 'state:'
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length))
    }
  } catch { /* noop */ }
  return out
}

export async function getState(key) {
  if (isLocalOnly()) return lsGet(stateKey(key))
  await requireSession()
  // CloudBase app.rdb() 是 PostgREST 风格；用 limit(1) 兼容所有版本（不依赖 maybeSingle）
  const { data, error } = await db().from('user_state').select('value').eq('key', key).limit(1)
  if (error) throw error
  const value = (Array.isArray(data) ? data[0] : null)?.value ?? null
  // 云端读到就刷新本地镜像；云端暂时没这条也不删本地（离线可继续用）
  if (value != null) mirrorSet(key, value)
  return value
}

// 不用 upsert：客户端绝不发送 owner_id，由 DB 的 DEFAULT auth.uid() 填充。
export async function setState(key, value) {
  if (isLocalOnly()) { lsSet(stateKey(key), value); return { key, value, offline: true } }
  mirrorSet(key, value)   // 先写本地镜像：即使云端失败，本机也不丢
  const name = await ownerName()
  const { data: foundRows, error: readErr } = await db().from('user_state').select('id').eq('key', key).limit(1)
  if (readErr) throw readErr
  const found = Array.isArray(foundRows) ? foundRows[0] : null
  const q = found
    ? db().from('user_state').update({ value }).eq('id', found.id).select()
    : db().from('user_state').insert({ key, value, owner_name: name }).select()
  const { data, error } = await q
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) throw new Error('保存失败：可能未登录或该记录不属于当前账号')
  return rows[0]
}

// 登录后差异同步：
//  - 云端有、本地也有 → 以云端为准覆盖本地（跨设备最新）
//  - 云端有、本地没有 → 存进本地镜像
//  - 本地有、云端没有 → 上传云端（离线期间新增的歌单不丢）
// 只有真正不同的 key 才做增删，绝不整体清空本地。
export async function mergeLocalOnLogin() {
  if (isLocalOnly()) return { uploaded: 0, downloaded: 0 }
  await requireSession()
  let uploaded = 0, downloaded = 0
  const keys = [...new Set(mirrorKeys())]
  for (const key of keys) {
    try {
      const { data, error } = await db().from('user_state').select('value').eq('key', key).limit(1)
      if (error) continue
      const cloudVal = Array.isArray(data) ? (data[0]?.value ?? null) : null
      const localVal = mirrorGet(key)
      if (cloudVal == null && localVal != null) {
        await setState(key, localVal)   // 本地独有 → 上传
        uploaded++
      } else if (cloudVal != null && JSON.stringify(cloudVal) !== JSON.stringify(localVal)) {
        mirrorSet(key, cloudVal)        // 云端更新 → 覆盖本地
        downloaded++
      }
    } catch { /* 单条失败不影响整体 */ }
  }
  return { uploaded, downloaded }
}

export async function listState(prefix) {
  if (isLocalOnly()) {
    const head = LS + 'state:' + prefix
    return Object.keys(localStorage).filter((k) => k.startsWith(head))
      .map((k) => ({ key: k.slice((LS + 'state:').length), value: lsGet(k.slice(LS.length)), updated_at: new Date().toISOString() }))
  }
  await requireSession()
  const { data, error } = await db().from('user_state').select('key, value, updated_at').like('key', `${prefix}%`)
  if (error) throw error
  return data ?? []
}

export async function delState(key) {
  if (isLocalOnly()) { localStorage.removeItem(LS + stateKey(key)); return }
  await requireSession()
  const { data, error } = await db().from('user_state').delete().eq('key', key).select()
  if (error) throw error
  if (!(data ?? []).length) throw new Error('删除失败：记录不存在或不属于当前账号')
}

export async function addEvent(kind, trackKey, tags = [], weight = 1) {
  if (isLocalOnly()) {
    const list = lsGet('events', [])
    list.unshift({ kind, track_key: trackKey, tags, weight, created_at: new Date().toISOString() })
    lsSet('events', list.slice(0, 500))
    return
  }
  const name = await ownerName()
  const { error } = await db().from('play_events').insert({
    kind, track_key: trackKey, tags, weight, owner_name: name,
  })
  if (error) throw error
}

export async function recentEvents(limit = 60) {
  if (isLocalOnly()) return lsGet('events', []).slice(0, limit)
  await requireSession()
  const { data, error } = await db().from('play_events')
    .select('kind, track_key, tags, weight, created_at')
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data ?? []
}

// 用户自持音频（已获授权或本人作品）存到私有路径，仅本人可读写。
export async function uploadOwnAudio(file) {
  if (isLocalOnly()) throw new Error('离线试用模式不支持云曲库上传，请用「我的 → 本地音频」')
  const s = await requireSession()
  const path = cloud.storage.userPath(s.user.id, `audio/${Date.now()}-${file.name}`)
  const { error } = await cloud.storage.upload(path, file, { contentType: file.type || 'audio/mpeg', upsert: false })
  if (error) throw error
  return path
}

export async function signedAudioUrl(path, ttl = 1800) {
  if (isLocalOnly()) {
    // 离线时允许 blob:/https: 直链（用户刚选的本地文件、自配置授权端点）。
    return /^(blob:|https?:)/i.test(path || '') ? path : null
  }
  await requireSession()
  const { data, error } = await cloud.storage.createSignedUrl(path, ttl)
  if (error) throw error
  return data
}
