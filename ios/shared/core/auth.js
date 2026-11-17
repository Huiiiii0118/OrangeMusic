import { cloud, assertCloud } from './cloud.js'

// ── 橙子音乐 · CloudBase 认证层 ──────────────────────────────────────────
// 后端：腾讯云开发 CloudBase（Supabase 风格 Auth）。
// 唯一登录方式：手机号验证码（OTP）。邮箱 / WorkBuddy / 微信 OAuth 在当前云端未开通，
// 已按用户要求删除——保留导出函数签名只为兼容旧调用点，内部明确提示不支持。
//
// 会话真实性：一律以 SDK auth.getSession() 返回的 data.session 为准。
// 云端已停 / token 失效时 getSession 返回空 → 立即判为未登录，不再用本机缓存伪造
// 「已登录 · 云端同步」（这正是用户反馈的 bug）。

let pending = null            // 待验码会话：{ kind:'phone', target, otpCtx }
const SESSION_CACHE_KEY = 'orangemusic:auth:session'
const LAST_SEEN_KEY = 'orangemusic:auth:lastSeen'
const IDENTITY_KEY = 'orangemusic:auth:identity'
const KEEP_LOGIN_KEY = 'orangemusic:keeplogin'
const PERSIST_MS = 7 * 24 * 3600 * 1000

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 隐私模式 */ } }
const lsDel = (k) => { try { localStorage.removeItem(k) } catch { /* noop */ } }
const normPhone = (v) => String(v || '').replace(/^\+?86[\s-]?/, '').replace(/\D/g, '')
const normMail = (v) => String(v || '').trim()
const e164 = (v) => `+86 ${normPhone(v)}`

export function maskAccount(v, type) {
  const s = String(v || '')
  if (type === 'phone' || /^1\d{10}$/.test(s)) {
    const d = normPhone(s)
    return d.length === 11 ? `${d.slice(0, 3)}****${d.slice(7)}` : s
  }
  const at = s.indexOf('@')
  if (at > 2) return `${s.slice(0, 3)}****${s.slice(at - 3)}`
  return s
}

// ── 身份档案：落盘唯一真源 ──────────────────────────────────────────────
function normalizeIdentity(patch) {
  const o = patch && typeof patch === 'object' ? patch : {}
  const out = {}
  const mail = normMail(o.email || o.email_address || '')
  const tel = normPhone(o.phone_number || o.phone || '')
  const name = String(o.name || o.nickname || o.user_metadata?.name || o.display_name || '').trim()
  if (mail) out.email = mail
  if (tel) out.phone = tel
  if (name) out.name = name
  if (o.loginType === 'email' || o.loginType === 'phone') out.loginType = o.loginType
  if (o.loginTarget) out.loginTarget = String(o.loginTarget)
  return out
}

export function saveIdentity(patch, { allowRename = false } = {}) {
  const prev = loadIdentity()
  const norm = normalizeIdentity(patch)
  if (!allowRename && prev.nameCustom && prev.name && norm.name && norm.name !== prev.name) delete norm.name
  const next = { ...prev, ...norm, at: Date.now() }
  lsSet(IDENTITY_KEY, next)
  return next
}
export function loadIdentity() {
  const v = lsGet(IDENTITY_KEY)
  return v && typeof v === 'object' ? v : {}
}
export function clearIdentity() { lsDel(IDENTITY_KEY) }

function hydrateSession(s) {
  if (!s) return null
  const id = loadIdentity()
  const fromSdk = normalizeIdentity(s.user || s)
  const known = { ...id, ...fromSdk }
  if (id.nameCustom && id.name) known.name = id.name
  if (!known.loginType) known.loginType = known.phone ? 'phone' : (known.email ? 'email' : '')
  if (!known.loginTarget) known.loginTarget = known.loginType === 'phone' ? known.phone : (known.email || '')
  if (!known.name) known.name = normPhone(known.phone) || known.email || ''
  lsSet(IDENTITY_KEY, { ...known, at: Date.now() })
  s.user = { ...(s.user && typeof s.user === 'object' ? s.user : {}), ...known,
    email: known.email || '', phone: known.phone || '', phone_number: known.phone || '',
    name: known.name || s.user?.name || '' }
  return s
}

export function saveDisplayName(name) {
  const v = String(name || '').trim().slice(0, 20)
  if (!v) throw new Error('昵称不能为空')
  const prev = loadIdentity()
  const next = saveIdentity({ name: v }, { allowRename: true })
  next.nameCustom = true
  lsSet(IDENTITY_KEY, next)
  return v
}

// 会话缓存仅作「短暂网络抖动」兜底，不作为登录态来源。
function cacheSession(payload) {
  if (!payload || typeof payload !== 'object') return
  lsSet(SESSION_CACHE_KEY, { at: Date.now(), payload })
}
export function clearSessionCache() { lsDel(SESSION_CACHE_KEY); lsDel(LAST_SEEN_KEY) }

export function keepLoginEnabled() {
  try { return localStorage.getItem(KEEP_LOGIN_KEY) !== '0' } catch { return true }
}
export function setKeepLogin(on) {
  const want = !!on
  try { localStorage.setItem(KEEP_LOGIN_KEY, want ? '1' : '0') } catch { /* 隐私模式 */ }
  if (!want) clearSessionCache()
  return want
}

// 把 CloudBase 会话统一压平成 app.js 期望的 { user, access_token, ... } 结构。
function pickSession(r) {
  if (!r) return null
  if (r.error) return null
  const s = r?.data?.session ?? r?.session ?? (r?.data?.access_token ? r.data : null)
  if (!s) return null
  return {
    ...s,
    access_token: s.access_token || s.access_token_hash || '',
    user: s.user || null,
  }
}

// 真实登录态：只信 SDK 的 getSession()。缓存不作为「已登录」依据，彻底修掉
// 「云端已停仍显示已登录·云端同步」的问题。
export const session = async () => {
  if (!cloud) return null
  try {
    const r = await cloud.auth.getSession()
    const s = pickSession(r)
    if (!s) { clearSessionCache(); return null }
    lsSet(LAST_SEEN_KEY, Date.now())
    return hydrateSession(s)
  } catch {
    clearSessionCache()
    return null
  }
}

export async function restoreAuth() {
  if (!cloud) return null
  // CloudBase 无 WorkBuddy/微信 OAuth 回调（已删除），任何 code 参数都忽略。
  try {
    const url = new URL(location.href)
    if (url.searchParams.has('code') || url.searchParams.has('error')) {
      for (const k of ['code', 'state', 'provider', 'error']) url.searchParams.delete(k)
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  } catch { /* ignore */ }
  return session()
}

export async function requireSession() {
  const s = await session()
  if (!s) throw new Error('请先登录')
  return s
}

// ── 手机号验证码登录（唯一支持的方式）────────────────────────────────────
export async function sendCode({ email = '', phone = '' } = {}) {
  assertCloud()
  if (email) throw new Error('当前云端不支持邮箱登录，请使用手机号验证码')
  const tel = normPhone(phone)
  if (!/^1\d{10}$/.test(tel)) throw new Error('请输入正确的 11 位手机号')
  const a = cloud.auth
  const target = e164(tel)
  // 形态 A：Supabase 风格 signInWithOtp（返回 data.verifyOtp 回调）
  if (typeof a.signInWithOtp === 'function') {
    const r = await a.signInWithOtp({ phone: target }).catch((e) => ({ error: e }))
    if (r?.error) throw new Error(r.error.message || '验证码发送失败，请重试')
    pending = { kind: 'phone', target: tel, mode: 'otp', otpCtx: r?.data }
    return { isExistingUser: true, kind: 'phone', target: tel }
  }
  // 形态 B：CloudBase Auth v3 getVerification + signInWithSms
  if (typeof a.getVerification === 'function') {
    const r = await a.getVerification({ phone_number: target }).catch((e) => ({ error: e }))
    if (r?.error) throw new Error(r.error.message || '验证码发送失败，请重试')
    pending = { kind: 'phone', target: tel, mode: 'sms', otpCtx: r?.data }
    return { isExistingUser: true, kind: 'phone', target: tel }
  }
  throw new Error('当前云 SDK 不支持验证码登录，请更新软件')
}

export async function submitCode(token) {
  assertCloud()
  if (!pending) throw new Error('请先获取验证码')
  const code = String(token || '').trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('请输入收到的验证码')
  const a = cloud.auth
  let s = null
  if (pending.mode === 'otp' && pending.otpCtx && typeof pending.otpCtx.verifyOtp === 'function') {
    const r = await pending.otpCtx.verifyOtp({ token: code }).catch((e) => ({ error: e }))
    if (r?.error) throw new Error(r.error.message || '验证码不正确或已过期')
    s = pickSession(r) || (r?.data ? hydrateSession(r.data) : null)
  } else if (pending.mode === 'sms' && typeof a.signInWithSms === 'function') {
    const r = await a.signInWithSms({
      verificationInfo: pending.otpCtx, verificationCode: code,
      phoneNum: pending.target,
    }).catch((e) => ({ error: e }))
    if (r?.error) throw new Error(r.error.message || '验证码不正确或已过期')
    s = pickSession(r)
  } else {
    throw new Error('当前云 SDK 不支持验证码登录，请更新软件')
  }
  const target = pending?.target || ''
  pending = null
  if (!s) throw new Error('登录失败：未获取到会话，请重试')
  cacheSession(s)
  lsSet(LAST_SEEN_KEY, Date.now())
  const ident = saveIdentity({
    ...normalizeIdentity(s.user || {}),
    phone: normPhone(target || s.user?.phone || ''),
    loginType: 'phone', loginTarget: normPhone(target),
  })
  return { user: { ...(s.user || {}), ...ident }, target: ident.loginTarget, kind: 'phone' }
}

// 兼容旧调用点（登录 UI 只传 phone）
export const sendPhoneCode = (phone) => sendCode({ phone })
export const submitPhoneCode = (_phone, token) => submitCode(token)

// ── 已删除的能力：当前云端未开通，调用给出明确提示 ───────────────────────
const UNSUPPORTED = '当前云端不支持此方式，请使用手机号验证码登录'
export async function fetchMe() {
  if (!cloud) return loadIdentity()
  try {
    const { data } = await cloud.auth.getUser()
    const raw = data?.user || data
    if (raw) return { ...raw, ...saveIdentity(raw) }
  } catch { /* ignore */ }
  return loadIdentity()
}
export async function refreshIdentity() { return fetchMe() }
export const bindPendingInfo = () => null
export async function bindSend() { throw new Error(UNSUPPORTED) }
export async function bindConfirm() { throw new Error(UNSUPPORTED) }
export async function signInWithWorkBuddy() { throw new Error(UNSUPPORTED) }
export async function signInWithWechat() { throw new Error(UNSUPPORTED) }
export async function updateAccountName(name) {
  const v = saveDisplayName(name)
  try { await cloud?.auth?.updateUser?.({ data: { name: v, display_name: v } }) } catch { /* 本地为准 */ }
  return v
}

export const signOut = async () => {
  clearSessionCache()
  clearIdentity()
  if (cloud?.auth?.signOut) { try { await cloud.auth.signOut() } catch { /* ignore */ } }
}

// 关闭「登录保持」：下次启动踢掉会话，但保留昵称档案。
export async function dropSessionKeepProfile() {
  clearSessionCache()
  if (cloud?.auth?.signOut) { try { await cloud.auth.signOut() } catch { /* ignore */ } }
}

export const onAuthChange = (cb) => {
  if (!cloud?.auth?.onAuthStateChange) return () => {}
  const sub = cloud.auth.onAuthStateChange((event, s) => cb(event, s))
  return sub?.data?.subscription?.unsubscribe ? () => sub.data.subscription.unsubscribe() : () => {}
}

export async function updateAccountNameLegacy() { throw new Error(UNSUPPORTED) }
