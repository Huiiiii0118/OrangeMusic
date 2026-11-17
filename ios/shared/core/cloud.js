import { publicConfig } from '../config/publicConfig.js'

// CloudBase（腾讯云开发）SDK 单例。
// CDN 全量脚本 https://static.cloudbase.net/cloudbase-js-sdk/3.11.1/cloudbase.full.js
// 暴露全局变量 cloudbase；v3.11.1 兼容 supabase 风格 API（app.rdb / app.auth.getSession）。
// 离线试用（SDK 未加载 / init 失败）时降级为 null，repo.js 自动改读写 localStorage，
// 绝不伪造云端身份或数据。

const sdk = (typeof globalThis !== 'undefined' && globalThis.cloudbase)
  || (typeof window !== 'undefined' && window.cloudbase)
  || null
export const isCloudReady = !!(sdk && typeof sdk.init === 'function')

let app = null
if (isCloudReady) {
  try {
    app = sdk.init({
      env: publicConfig.env,
      region: publicConfig.region || 'ap-shanghai',
      accessKey: publicConfig.publishableKey,
      auth: { detectSessionInUrl: true },
    })
  } catch { app = null }
}

// ── 兼容层：把 CloudBase 的 app.auth / app.rdb() 包装成旧代码熟悉的形态 ──
// repo.js 只用 cloud.database.from(...)，auth.js 只用 cloud.auth.<method>，
// 因此这里做薄封装，业务代码改动最小。
const realAuth = app ? (typeof app.auth === 'function' ? app.auth() : app.auth) : null

const authAdapter = realAuth ? {
  getSession: (...a) => realAuth.getSession?.(...a),
  setSession: (...a) => realAuth.setSession?.(...a),
  signOut: (...a) => realAuth.signOut?.(...a),
  onAuthStateChange: (...a) => realAuth.onAuthStateChange?.(...a),
  getUser: (...a) => realAuth.getUser?.(...a),
  updateUser: (...a) => realAuth.updateUser?.(...a),
  // 手机号验证码：两种 SDK 形态都转发，auth.js 里做能力探测
  signInWithOtp: (...a) => realAuth.signInWithOtp?.(...a),
  getVerification: (...a) => realAuth.getVerification?.(...a),
  signInWithSms: (...a) => realAuth.signInWithSms?.(...a),
  _raw: realAuth,
} : null

const dbAdapter = app && typeof app.rdb === 'function' ? app.rdb() : null

// 统一云对象；database 直接就是 rdb 客户端（PostgREST 风格 .from().select().eq()）。
export const cloud = app ? {
  auth: authAdapter,
  database: dbAdapter,
  storage: app.storage,
  _app: app,
} : null
export const isCloudOnline = !!app
export const isPg = !!(app && typeof app.rdb === 'function')

// 数据层模式：SDK 缺失，或已加载但当前未登录 → 一律只读写本机 localStorage。
// 由 app.js 在拿到 session 后显式设定。
let localOnly = !app
export const setLocalOnly = (v) => { localOnly = !!v || !app }
export const isLocalOnly = () => localOnly

export const unwrap = ({ data, error }) => {
  if (error) throw error
  return data
}

export const assertCloud = () => {
  if (!cloud) throw new Error('云 SDK 未加载：当前为离线试用模式，数据仅保存在本机')
}
