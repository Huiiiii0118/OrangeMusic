import { publicConfig } from '../config/publicConfig.js'

// 单例：Auth / Database / Storage / LLM 共用这一处初始化。
// 离线试用（本地静态站点 / 未发布域名 / CDN 不可达）时降级为 null，
// repo.js 自动改读写 localStorage；绝不伪造云端身份或数据。

const isAppScheme = typeof location !== 'undefined' && location.protocol === 'app:'

// 云服务只接受「已发布 HTTPS 域名」的 Origin。桌面端页面跑在 app://orangemusic 上，
// 浏览器会以跨域为由直接失败（TypeError: Failed to fetch），登录和歌单同步就全废了。
// 这里给云 SDK 注入一个「走主进程代发」的 fetch：由 Node 侧发请求，不存在 CORS，
// 主进程再顺手把 Origin 改写成发布域名（见 main.cjs 的 patchCloudCors）。
export async function nativeCloudFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  if (!/^https?:/i.test(url)) return fetch(input, init)
  const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
  const headers = {}
  const raw = init.headers || (input && input.headers)
  if (raw) {
    if (typeof raw.forEach === 'function' && typeof raw.get === 'function') raw.forEach((v, k) => { headers[k] = v })
    else for (const [k, v] of Object.entries(raw)) headers[k] = String(v)
  }
  let body
  if (init.body != null) {
    body = typeof init.body === 'string' ? init.body
      : (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) ? init.body.toString()
        : JSON.stringify(init.body)
  }
  const headers2 = { ...headers }
  // 云端以 Origin 识别客户端（真机实测：带 Origin 的裸请求 4 次全部成功，不带则偶发
  // 「session is invalid / issued for another client」）。代发请求经主进程出去，浏览器不会
  // 自动补 Origin，这里显式补上，与发布域名的直连请求完全同形。
  //
  // 同时补上客户端凭据：所有云端请求都必须带 x-wb-webapp-access-key（即 publicConfig.publishableKey），
  // 缺它服务端直接 401 报「the client credential is invalid or revoked」。SDK 自带的 fetch 包装会注入
  // 该头，但我们为桌面端 app:// 注入了自定义 nativeCloudFetch 接管所有请求，SDK 的注入被绕过，
  // 因此这里统一兜底（已带则不覆盖，避免重复）。auth.js 的裸通道 authRaw 也走这里，一并获得凭据。
  try {
    const u = new URL(url, location?.href || 'https://quiet-music.app.workbuddy.host')
    if (u.origin === publicConfig.endpoint || u.hostname.endsWith('.workbuddy.host')) {
      if (!headers2.Origin) headers2.Origin = publicConfig.endpoint
      if (!headers2['x-wb-webapp-access-key']) headers2['x-wb-webapp-access-key'] = publicConfig.publishableKey
    }
  } catch { /* 非 http(s) 跳过 */ }
  const payload = JSON.stringify({ url, options: { method, headers: headers2, body }, timeout: 25000 })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let lastErr = null
  // 主进程代发偶发 502（连接超时 / 网络抖动）：重试 2 次再降级。
  // 注意只对「代发层」失败重试，云端返回的 4xx/5xx 是正常 HTTP 响应，会原样交给 SDK 处理。
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('/api/net', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      if (!res.ok) throw new TypeError(`云端请求被拒绝（${res.status}）`)
      const j = await res.json()
      if (j && j.error) throw new TypeError(j.error)
      const h = new Headers()
      for (const [k, v] of Object.entries(j.headers || {})) {
        try { h.set(k, v) } catch { /* 非法头跳过 */ }
      }
      let status = Number(j.statusCode) || 200
      if ([204, 205, 304].includes(status)) status = 200  // Response 不允许这些状态带 body
      return new Response(j.bodyRaw || '', { status, headers: h })
    } catch (e) {
      lastErr = e
      if (i < 2) await sleep(400 * (i + 1))
    }
  }
  // 代发通道连不上：主进程已用 patchCloudCors 放开 CORS，再试一次浏览器直连。
  try { return await fetch(input, init) } catch { /* 两者都失败，抛可读错误 */ }
  throw new TypeError(`连接云服务失败：${lastErr?.message || '网络不可达'}，请检查网络后重试`)
}

const factory = window.WorkBuddyCloud?.createWorkBuddyCloud
export const isCloudReady = typeof factory === 'function'

let instance = null
if (isCloudReady) {
  try {
    instance = factory({
      endpoint: publicConfig.endpoint,
      oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
      publishableKey: publicConfig.publishableKey,
      // 只有 app:// 桌面端需要代发（网页版/HTTPS 部署时原生 fetch 就正常）
      ...(isAppScheme ? { fetch: nativeCloudFetch } : {}),
    })
  } catch { instance = null }   // 非发布 origin 被 SDK 拒绝时自动转离线试用
}
export const cloud = instance
export const isCloudOnline = !!instance

// 数据层模式：SDK 缺失，或已加载但当前未登录 → 一律只读写本机 localStorage。
// 由 app.js 在拿到 session 后显式设定，避免 repo.js 每次调用都去问云 SDK。
let localOnly = !instance
export const setLocalOnly = (v) => { localOnly = !!v || !instance }
export const isLocalOnly = () => localOnly

export const unwrap = ({ data, error }) => {
  if (error) throw error
  return data
}

export const assertCloud = () => {
  if (!cloud) throw new Error('云 SDK 未加载：当前为离线试用模式，数据仅保存在本机')
}
