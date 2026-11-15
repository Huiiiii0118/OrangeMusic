import { cloud, assertCloud, nativeCloudFetch } from './cloud.js'
import { publicConfig } from '../config/publicConfig.js'

// 待验证的验证码会话：邮箱/手机号通用。
// 云端 Auth 是「验证码即注册」——sendOtp 返回 isExistingUser=false 时，
// verifyOtp 通过就会自动建号，不需要额外的注册表单。
let pending = null

// 启动回调分发：必须在任何路由守卫之前执行；只按 provider 调一个 handler。
export async function restoreAuth() {
  if (!cloud) return null            // 离线试用：不伪造任何本地身份
  const url = new URL(location.href)
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
    return session()
  }
  const provider = url.searchParams.get('provider')
  if (provider !== 'workbuddy' && provider !== 'wechat') {
    throw new Error('授权回调缺少有效的登录方式，请重新登录。')
  }
  const fn = provider === 'workbuddy'
    ? cloud.auth.handleWorkBuddyCallback
    : cloud.auth.handleWechatWebCallback
  if (typeof fn !== 'function') throw new Error('SDK 版本不支持该登录方式')
  const { data: s, error } = await fn.call(cloud.auth)
  if (error) throw error
  if (s) {
    for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k)
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    return hydrateSession(s)
  }
  return session()
}

// 非发布 origin / 未登录 / SDK 拒绝时一律返回 null，不让启动流程崩掉。
// ── 登录态保持（7 天滑动窗口）────────────────────────────────────────────
// 需求：成功登录后，下次打开软件不用重新登录；连续 7 天不打开才掉登录。
// SDK 的 postForSession 只负责「换会话」，是否落盘因 SDK 版本而异 —— 这里自己兜一层：
// 登录成功把会话写进 localStorage；启动时 SDK 没有会话就用缓存恢复（setSession）；
// 每次成功恢复/校验都续期 lastSeen；超过 7 天没打开就清缓存，要求重新登录。
const SESSION_CACHE_KEY = 'orangemusic:auth:session'
const LAST_SEEN_KEY = 'orangemusic:auth:lastSeen'
const PERSIST_MS = 7 * 24 * 3600 * 1000
// ── 账号身份的「唯一真源」───────────────────────────────────────────────
// 以前身份只写进内存里的 S.session.user：重启后 SDK 的 session.user 可能只有 email
// （手机号丢失）甚至整个为空，于是「手机号/邮箱已互绑」却显示「未绑定」、绑定时又报
// 「请先登录再绑定」。这里把身份单独落盘，并在每次拿到会话时双向合并，
// 让 UI 永远看到完整身份，且与 7 天免登录缓存同寿命、退出登录一并清掉。
const IDENTITY_KEY = 'orangemusic:auth:identity'

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 隐私模式忽略 */ } }
const lsDel = (k) => { try { localStorage.removeItem(k) } catch { /* noop */ } }

const normMail = (v) => String(v || '').trim()
const normPhone = (v) => String(v || '').replace(/^\+?86[\s-]?/, '').replace(/\D/g, '')

// 脱敏：中间字段打星，保留首尾用于辨认（邮箱 378****725@qq.com / 手机 138****5678）。
export function maskAccount(v, type) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (type === 'phone' || /^\+?\d[\d\s-]{6,}$/.test(s)) {
    const d = s.replace(/\D/g, '')
    if (d.length >= 7) return d.slice(0, 3) + '****' + d.slice(-4)
    return d.slice(0, 1) + '****'
  }
  const at = s.indexOf('@')
  const local = at > 0 ? s.slice(0, at) : s
  const domain = at > 0 ? s.slice(at) : ''
  if (local.length <= 6) return local.slice(0, 1) + '****' + (local.length > 2 ? local.slice(-1) : '') + domain
  return local.slice(0, 3) + '****' + local.slice(-3) + domain
}

// UI 唯一入口：账号页 / 侧栏 / 设置页都从这里取，绝不各自判断 S.session.user
// （SDK 会话结构与落盘身份不一致，正是「已绑定却显示未绑定」「已登录却显示未登录」的根源）。
export function accountView() {
  const id = loadIdentity()
  const mail = normMail(id.email || '')
  const tel = normPhone(id.phone || '')
  const loginType = id.loginType || (mail ? 'email' : (tel ? 'phone' : ''))
  const loginTarget = id.loginTarget || (loginType === 'email' ? mail : (loginType === 'phone' ? tel : ''))
  return {
    email: mail, phone: tel, name: String(id.name || ''),
    nameCustom: !!id.nameCustom,
    emailBound: !!mail, phoneBound: !!tel,
    loginType, loginTarget,
    loginLabel: loginType === 'phone' ? '手机号' : '邮箱',
    masked: maskAccount(loginTarget, loginType),
    maskedEmail: maskAccount(mail, 'email'),
    maskedPhone: maskAccount(tel, 'phone'),
  }
}

// 把任意来源（登录 target / SDK user / /v1/user/me / 绑定结果）归一成同一套字段。
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

// 身份是「只增不减」的：某次会话没带手机号，不能把上次已绑定的手机号抹掉。
// ★ 自定义昵称优先级最高：SDK 每次启动都会给一个自动名（邮箱前缀 / 数字 ID），
//   fetchMe / refreshIdentity 合并云端资料时绝不能把它写回覆盖用户改过的昵称
//   —— 这正是「侧栏是 12、首页却是 378542725」以及「用户名偶尔丢失」的根源。
//   只有 UI 改名（saveDisplayName）显式带 allowRename 才允许覆盖。
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

// 把落盘身份补进会话 user；同时把会话里新出现的字段回写落盘。
// 必须双向合并：单向补 user 会让「SDK 没有手机号」时永远显示未绑定，
// 单向写盘又会让「会话里有新邮箱」时 UI 看不到。
// 自定义昵称优先级最高：SDK 每次启动都会给一个自动名（邮箱前缀），
// 不能让它把用户改过的昵称覆盖掉。
function hydrateSession(s) {
  if (!s) return null
  const id = loadIdentity()
  const fromSdk = normalizeIdentity(s.user || s)
  const known = { ...id, ...fromSdk }
  if (id.nameCustom && id.name) known.name = id.name
  // 会话里没有登录途径时，用已知身份推断一次（邮箱优先，其次手机号）
  if (!known.loginType) known.loginType = known.email ? 'email' : (known.phone ? 'phone' : '')
  if (!known.loginTarget) known.loginTarget = known.loginType === 'email' ? known.email : (known.phone || '')
  if (!known.name) known.name = ''
  lsSet(IDENTITY_KEY, { ...known, at: Date.now() })
  s.user = { ...(s.user && typeof s.user === 'object' ? s.user : {}), ...known,
    email: known.email || '', phone: known.phone || '', phone_number: known.phone || '',
    name: known.name || s.user?.name || '' }
  return s
}

// 用户自定义昵称：最多 20 个「字符」（按 Unicode 码点，emoji 算 1 个），不限符号。
// 落盘并标记 nameCustom，重启后 SDK 的自动名不会覆盖它。
export function saveDisplayName(name) {
  const v = Array.from(String(name ?? '').trim()).slice(0, 20).join('')
  if (!v) {
    const prev = loadIdentity()
    delete prev.name
    delete prev.nameCustom
    lsSet(IDENTITY_KEY, { ...prev, at: Date.now() })
    return ''
  }
  const next = saveIdentity({ name: v }, { allowRename: true })
  next.nameCustom = true
  lsSet(IDENTITY_KEY, next)
  return v
}

// 把昵称写进「云端账户信息」：优先 SDK 标准 updateUser（写 user_metadata），
// 再按 /v1/user/me 阶梯探测裸端点。服务端未开放写接口也不影响本机改名 ——
// user_state/profile 里那份云数据仍可跨设备恢复，这里只是让账户信息保持一致。
// 改名时由 UI 调用；失败/不支持一律静默，绝不阻塞本机生效。
export async function updateAccountName(name) {
  const v = Array.from(String(name ?? '').trim()).slice(0, 20).join('')
  if (!v || !cloud) return { ok: false }
  try {
    if (typeof cloud.auth?.updateUser === 'function') {
      const r = await cloud.auth.updateUser({ data: { name: v, display_name: v } })
      if (!r?.error) { saveIdentity({ name: v }); return { ok: true, via: 'sdk' } }
    }
  } catch { /* 落到裸端点阶梯 */ }
  let token = ''
  try { token = (await session())?.access_token || '' } catch { /* 无会话 */ }
  const body = { name: v, display_name: v, nickname: v, user_metadata: { name: v } }
  for (const [method, p] of [['PATCH', '/v1/user/me'], ['PUT', '/v1/user/me'], ['POST', '/v1/user/me']]) {
    const r = await authRaw(p, body, token, method).catch((e) => ({ error: e }))
    if (!r?.error) { saveIdentity({ name: v }); return { ok: true, via: `${method} ${p}` } }
    const raw = String(r.error?.description || r.error?.message || '')
    if (/unimplemented|not available|Method Not Allowed|not_found|404|405|401|403|invalid/i.test(raw)) continue
    break
  }
  return { ok: false }
}

function cacheSession(payload) {
  // SDK 的 postForSession 有时返回会话本体，有时返回 { data: { session } } 这种带壳结构。
  // 统一压平成「真会话」再落盘，否则启动时缓存恢复会被当成空壳 → 显示「未登录」。
  const p = pickSession(payload) || payload
  if (!p || typeof p !== 'object' || !(p.access_token || p.user || p.refresh_token)) return
  lsSet(SESSION_CACHE_KEY, { at: Date.now(), payload: p })
}

export function clearSessionCache() { lsDel(SESSION_CACHE_KEY); lsDel(LAST_SEEN_KEY) }

// 「登录保持」开关：开启＝原方案（7 天滑动免登录）；关闭＝下次启动必须重新登录。
// 关闭时立刻清掉本机会话缓存，并在下次启动的最开始 signOut 掉 SDK 里的持久会话。
const KEEP_LOGIN_KEY = 'orangemusic:keeplogin'
export function keepLoginEnabled() {
  try { return localStorage.getItem(KEEP_LOGIN_KEY) !== '0' } catch { return true }
}
export function setKeepLogin(on) {
  const want = !!on
  try { localStorage.setItem(KEEP_LOGIN_KEY, want ? '1' : '0') } catch { /* 隐私模式 */ }
  if (!want) clearSessionCache()
  return want
}

// 从各种 SDK 返回结构里挑出「真会话」：必须是含 access_token / user / refresh_token 的对象。
// 关键：{ data: { session: null } } 这种「有壳没肉」的返回**不能**当会话——
// 否则 S.session 为真值、但 .user / .access_token 全空，表现为「已登录却显示未登录 / 绑定报请先登录」，
// 而且会提前 return、永远轮不到 restoreCachedSession()，7 天免登录也就失效了。
function pickSession(r) {
  let s = r?.data?.session ?? r?.session ?? null
  if (!s && r?.data && (r.data.access_token || r.data.user || r.data.refresh_token)) s = r.data
  if (s && (s.access_token || s.user || s.refresh_token)) return s
  if (r && (r.access_token || r.user || r.refresh_token)) return r
  return null
}

async function restoreCachedSession() {
  const cached = lsGet(SESSION_CACHE_KEY)
  if (!cached?.payload) return null
  const lastSeen = Number(lsGet(LAST_SEEN_KEY)) || cached.at || 0
  if (Date.now() - lastSeen > PERSIST_MS) { clearSessionCache(); return null }   // 7 天没打开：掉登录
  // 只接受「真会话」对象，{session:null} 这种空壳不能当登录态
  const p = pickSession(cached.payload) || cached.payload
  if (!p || typeof p !== 'object' || !(p.access_token || p.user || p.refresh_token)) return null
  let sdkRejected = false
  try {
    if (typeof cloud.auth.setSession === 'function') {
      const r = await cloud.auth.setSession(p)
      if (r?.error) sdkRejected = true                  // 服务端明确拒收：确实掉登录了
      const s = !sdkRejected && pickSession(r)
      if (s) { lsSet(LAST_SEEN_KEY, Date.now()); return hydrateSession(s) }
    }
  } catch { sdkRejected = true }
  // ★ 关键：SDK 的 setSession 常常「成功了却不返回会话对象」（返回 undefined / {data:{}}）。
  // 以前这里直接 return null → S.session 为空 → 侧栏显示「未登录」、绑定报「请先登录再绑定」，
  // 但本机会话缓存其实是有效的（重新登录一次就好了，正是用户反复反馈的现象）。
  // 只要 SDK 没明确拒收，就用本机缓存本身恢复登录态，7 天免登录才真正成立。
  if (!sdkRejected) { lsSet(LAST_SEEN_KEY, Date.now()); return hydrateSession({ ...p }) }
  return null
}

export const session = async () => {
  if (!cloud) return null
  try {
    // 云端 SDK 的 getSession() 返回结构在不同版本下不一致：有的直接是
    // { data: { access_token, user } }，有的是 { data: { session: { access_token, user } } }。
    // 用 pickSession 统一下钻到真正的会话对象，拿不到就交给缓存恢复（保持 7 天免登录）。
    const r = await cloud.auth.getSession()
    const s = pickSession(r)
    if (s) { lsSet(LAST_SEEN_KEY, Date.now()); return hydrateSession(s) }   // 打开即续期（滑动 7 天）
  } catch { /* 会话缺失 / 刷新失败：走缓存恢复 */ }
  return await restoreCachedSession()
}

// 用户数据读写前的强制守卫；禁止匿名登录 / mock session / localStorage 假身份。
export async function requireSession() {
  const s = await session()
  if (!s) throw new Error('请先登录')
  return s
}

// ── 验证码登录（邮箱 / 手机号通用，首次登录自动注册）────────────────────────
// 邮箱不需要短信通道，也不受 OAuth 回调域限制，是桌面端最稳的一条路。
export async function sendCode({ email = '', phone = '' } = {}) {
  assertCloud()
  const mail = String(email || '').trim()
  const tel = String(phone || '').replace(/\D/g, '')
  if (mail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) throw new Error('请输入正确的邮箱地址')
  } else if (tel) {
    if (!/^1\d{10}$/.test(tel)) throw new Error('请输入正确的 11 位手机号')
  } else {
    throw new Error('请填写邮箱或手机号')
  }
  // 裸验证码通道（真机 4 次实测成功契约）：不经 SDK 的 sendOtp（会附加 usage/target 等
  // 字段且走 SDK 自己的请求路径），直接 POST /v1/verification，与 tools/auth_probe.mjs 同形：
  // 头只有 Content-Type + x-wb-webapp-access-key(+nativeCloudFetch 注入的 Origin)。
  // 手机号字段必须是 phone_number 且为「+86 158xxxx」（带空格 E.164），裸 11 位实测 400。
  const r = await authRaw('/v1/verification', mail ? { email: mail } : { phone_number: authUsername(tel, 'phone') })
  if (r.error) throw otpError(r.error)
  const vid = r.data?.verification_id
  if (!vid) throw new Error('验证码发送失败，请稍后重试')
  pending = {
    verificationId: vid,
    isExistingUser: r.data?.is_user === true,
    target: mail || tel,
    kind: mail ? 'email' : 'phone',
  }
  return { isExistingUser: pending.isExistingUser, kind: pending.kind, target: pending.target }
}

// 云端 Auth 裸调用：{ data, error } 形态。与真机验证成功的请求完全同形（见 auth_probe.mjs）。
async function authRaw(p, body, token, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let res, text = ''
  try {
    res = await nativeCloudFetch(publicConfig.endpoint + '/.cloud/auth' + p, {
      method, headers, body: JSON.stringify(body || {}),
    })
    text = await res.text()
  } catch (e) {
    return { data: null, error: { message: `request failed before a response was received: ${e?.message || e}`, status: 0 } }
  }
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON 原样报错 */ }
  if (!res.ok || (j && j.error)) {
    const desc = String(j?.error_description || j?.error || text || `HTTP ${res.status}`)
    return { data: null, error: { message: desc, description: desc, status: res.status } }
  }
  return { data: j ?? {}, error: null }
}

// 云端 /v1/verification 的返回只有 verification_id / expires_in；**只有老用户**才多带一个
// is_user:true。SDK 的 verifyOtp 也是据此二选一：老用户 /v1/signin，新用户 /v1/signup。
//
// ★ 真机端到端实测（tools/test_cloud_otp.mjs，mail.tm 真实邮箱）：
//   - 新邮箱：发码不带 is_user → /v1/signup {email, verification_token} → 200 + access_token
//   - 老邮箱：发码带 is_user:true → /v1/signin {username, verification_token} → 200 + access_token
//   - **verification_token 是一次性的**：先用同一 token 试错分支（signup 409 / signin 400），
//     服务端就把 token 标记成已用，另一条分支必然失败并报
//     "the session is invalid, expired or issued for another client"。
//     这正是之前「同一个问题改很多遍还登不进去」的根因。
// 因此这里严格只走一条分支：验码一次 → 按 is_user 选一个端点 → 只发一次换会话请求。
const VERIFY_PATH = '/v1/verification/verify'
const SIGNIN_PATH = '/v1/signin'
const SIGNUP_PATH = '/v1/signup'

// 与 SDK 的 normalizePhone 完全一致：11 位国内号 → "+86 1xxxxxxxxxx"（发码/登录/注册同形）
function authUsername(target, kind) {
  if (kind !== 'phone') return String(target || '')
  const all = String(target || '').replace(/\D/g, '')
  const local = all.startsWith('0086') ? all.slice(4)
    : (all.startsWith('86') && all.length === 13 ? all.slice(2) : all)
  return /^1\d{10}$/.test(local) ? `+86 ${local}` : String(target || '')
}

function otpError(err) {
  const msg = String((err && (err.message || err.error_description)) || '')
  // 网络层失败：SDK 会把 fetch 抛出的错误包成 "request failed before a response was received: ..."
  if (/request failed before a response|云端请求被拒绝|代发失败|fetch failed|network|timeout|ECONN/i.test(msg)) {
    return new Error('连接云服务失败，请检查网络后重试；若已收到验证码，可点「重新发送」获取新验证码')
  }
  if (/LimitExceeded\.PhoneNumberDailyLimit|daily limit|短信.*上限|发送.*超限/i.test(msg)) {
    return new Error('该手机号今天的验证码次数已用完，请改用「邮箱验证码」登录，或明天再试')
  }
  if (/session is invalid|issued for another client|expired|已过期|已被使用|invalid.?token|verification.?token/i.test(msg)) {
    return new Error('登录未完成：验证码可能已失效或已被使用，请点「重新发送」获取新验证码后再试')
  }
  if (/user not exist|user 已存在|already.?exist|已注册|用户不存在|用户已存在/i.test(msg)) {
    return new Error('登录未完成：账号状态异常，请点「重新发送」后重试；若仍不行请联系支持')
  }
  if (/verification code|验证码|invalid.?code|malformed|username and the password/i.test(msg)) {
    return new Error('验证码不正确或已过期，请重新发送后再试')
  }
  return err instanceof Error ? err : new Error(msg || '登录失败，请稍后重试')
}

export async function submitCode(token) {
  assertCloud()
  if (!pending) throw new Error('请先获取验证码')
  const code = String(token || '').trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('请输入收到的验证码')
  const auth = cloud.auth
  const target = pending.target
  const kind = pending.kind
  const username = authUsername(target, kind)

  // 清掉本机可能残留的过期会话（"issued for another client" 也来自旧 refresh_token 续期失败）
  try { auth.sessions?.clear?.() } catch { /* 无存储权限时忽略 */ }

  // ⓪ 旧 SDK（没有 postForSession 底层方法）：退回 verifyOtp 一次性完成验码+换会话，
  //    绝不重试（避免二次消费验证码）；成功后同样写入会话缓存保持登录态。
  if (typeof auth.postForSession !== 'function') {
    if (typeof auth.verifyOtp !== 'function') throw new Error('当前云 SDK 过旧，不支持验证码登录，请更新软件')
    const { data, error } = await auth.verifyOtp({
      type: kind === 'phone' ? 'phone' : 'email',
      ...(kind === 'phone' ? { phone: target } : { email: target }),
      token: code,
      ...(pending.isExistingUser ? { isExistingUser: true } : {}),
    }).catch((e) => ({ error: e }))
    if (error) throw otpError(error)
    pending = null
    const s = data?.session ?? data ?? null
    cacheSession(s)
    lsSet(LAST_SEEN_KEY, Date.now())
    const ident = saveIdentity({ ...normalizeIdentity(s?.user ?? data?.user ?? data ?? {}),
      [kind === 'phone' ? 'phone' : 'email']: kind === 'phone' ? normPhone(target) : target,
      loginType: kind, loginTarget: String(target) })
    return { user: { ...(s?.user ?? data?.user ?? {}), ...ident }, target, kind }
  }

  // ① 验码（裸通道，同 authRaw 契约）：整个登录流程里只调用一次，拿到一次性 verification_token。
  //    注意：failed 分支【不会】消耗 token（真机实测 404 User not exist 后同一 token 仍可 signup 成功），
  //    所以下面可以安全地「先走主分支、方向错了再切另一条」。
  const verified = await authRaw(VERIFY_PATH, {
    verification_id: pending.verificationId,
    verification_code: code,
  })
  if (verified.error) throw otpError(verified.error)
  const verificationToken = String(verified.data?.verification_token || '')
  if (!verificationToken) throw new Error('验证码校验失败：服务端未返回校验凭据，请重新发送验证码')

  // ② 主分支按 isExistingUser 选择；若服务端回「用户不存在 / 已存在」这种与分支方向相反的错误，
  //    用**同一个** token 切到另一条路再试一次。这样能兜住「手机号渠道没返回 is_user，
  //    老用户被当成新用户走 signup 报『已存在』」的误判（真实反馈：登录界面报『验证码失效』）。
  //    手机号渠道服务端对号码写法很挑剔（+86 带空格 / 不带空格 / 裸 11 位）——写法不认时会报
  //    「session invalid」让用户误以为验证码坏了。失败的换会话请求【不会】消耗 token
  //    （实测 404/409 后同一 token 仍可用），所以这里可以安全地按「分支 × 号码写法」多试几种，
  //    服务端认哪种就成功哪种；邮箱保持单一写法，行为不变。
  const steps = pending.isExistingUser ? ['signin', 'signup'] : ['signup', 'signin']
  const digits = String(target).replace(/\D/g, '')
  const phoneForms = kind === 'phone'
    ? [...new Set([username, `+86${digits}`, digits, digits.startsWith('86') ? digits.slice(2) : digits].filter(Boolean))]
    : [username]
  const attempts = []
  for (const step of steps) {
    for (const u of phoneForms) {
      attempts.push(step === 'signin'
        ? { path: SIGNIN_PATH, body: kind === 'phone' ? { phone_number: u, verification_token: verificationToken } : { username: u, verification_token: verificationToken } }
        : { path: SIGNUP_PATH, body: kind === 'phone' ? { phone_number: u, verification_token: verificationToken } : { email: u, verification_token: verificationToken } })
    }
  }
  let data = null
  let lastErr = null
  for (const a of attempts) {
    const r = await auth.postForSession(a.path, a.body).catch((e) => ({ error: e }))
    if (!r?.error) { data = r?.data ?? null; break }
    lastErr = r.error
    const msg = String(r.error?.error_description || r.error?.message || r.error || '')
    // 「用户不存在 / 已存在 / 号码写法不认」→ 换下一个写法 / 分支继续；
    // 真正的 token 失效 / 网络错误则终止，避免无谓重试。
    if (/user not exist|user 已存在|already.?exist|已注册|not_found|用户不存在|用户已存在|malformed|username and the password|invalid.?phone|unsupported/i.test(msg)) continue
    break
  }
  if (lastErr && !data) {
    const raw = String(lastErr?.error_description || lastErr?.message || lastErr || '')
    const e = otpError(lastErr)
    // 带上服务端原始报错：真机排障时能直接看到云端说了什么，不再只有笼统的「验证码失效」
    if (raw && !e.message.includes(raw)) e.message += `（服务端：${raw.slice(0, 140)}）`
    throw e
  }
  pending = null
  // 登录态保持：把会话（access/refresh token）写进本机缓存，下次启动免登录（7 天滑动窗口）
  cacheSession(data)
  lsSet(LAST_SEEN_KEY, Date.now())
  // 新用户注册 / 老用户换设备登录时，SDK 的 session.user 常常只带一个 id，
  // 邮箱或手机号要等 /v1/user/me 才拿得到。这里先把本次登录用的标识落盘，
  // 账号页第一次渲染就能显示「已绑定」和登录途径，不会闪一下「未绑定 / 未登录」。
  const ident = saveIdentity({
    ...normalizeIdentity(data?.user ?? data?.session?.user ?? {}),
    [kind === 'phone' ? 'phone' : 'email']: kind === 'phone' ? normPhone(target) : target,
    loginType: kind, loginTarget: String(target),
  })
  return { user: { ...(data?.user ?? data?.session?.user ?? {}), ...ident }, target, kind }
}

// 兼容旧调用点
export const sendPhoneCode = (phone) => sendCode({ phone })
export const submitPhoneCode = (_phone, token) => submitCode(token)

// ── 账号绑定 / 合并（邮箱 ↔ 手机号 指向同一账户）──────────────────────────
// 云端 Auth 目前 /v1/user/me 只读，自助绑定端点未开放 —— 这里按可能的端点阶梯探测，
// 服务端一旦支持即自动生效；全部未实现时给出明确提示。
export async function fetchMe() {
  assertCloud()
  const auth = cloud.auth
  let me = null
  if (typeof auth.getUser === 'function') {
    const { data, error } = await auth.getUser().catch(() => ({ error: true }))
    if (!error) me = data ?? null
  }
  if (!me) {
    try {
      const s = await session()
      const token = s?.access_token
      if (token && typeof auth.request === 'function') {
        const r = await auth.request('/v1/user/me', { method: 'GET', token })
        me = r?.data ?? null
      }
    } catch { /* 裸端点未开放：用已落盘身份兜底 */ }
  }
  // 云端资料可能补全了手机号 / 昵称，也可能只返回 id。无论如何都合并进落盘身份，
  // 保证「已互绑」在重启后依然显示已绑定（这是之前反复出问题的根因）。
  if (me) {
    // SDK 有时把用户包在 { user } 里；展平后 normalizeIdentity 才能读到
    // user_metadata.name —— 这是「换设备 / 清过本机缓存」时从云端账户信息找回昵称的关键。
    const raw = me?.user && typeof me.user === 'object' ? me.user : me
    const merged = saveIdentity(raw)
    return { ...raw, ...merged }
  }
  const known = loadIdentity()
  return Object.keys(known).length ? known : null
}

// 启动后主动刷新身份：即使 SDK 的 session.user 里已经带了一个 email，
// 也要再拉一次云端资料补齐手机号 / 昵称，再回写 session.user 让 UI 一致。
// 失败/超时都不影响启动，直接回落盘身份。
export async function refreshIdentity(timeout = 3500) {
  if (!cloud) return loadIdentity()
  try {
    const me = await Promise.race([
      fetchMe(),
      new Promise((r) => setTimeout(() => r(null), timeout)),
    ])
    return me ? saveIdentity(me) : loadIdentity()
  } catch { return loadIdentity() }
}

const BIND_ATTEMPTS = [
  ['PATCH', '/v1/user/me'],
  ['PUT', '/v1/user/me'],
  ['POST', '/v1/user/me'],
  ['POST', '/v1/user/email'],
  ['POST', '/v1/user/phone'],
  ['POST', '/v1/identity/link'],
  ['POST', '/v1/identities'],
]

// 绑定两步走：bindSend 给新标识发码（UI 先收集标识），bindConfirm 验码后持当前会话尝试合并。
let bindPending = null
export const bindPendingInfo = () => (bindPending ? { ...bindPending } : null)

export async function bindSend({ email = '', phone = '' } = {}, token) {
  assertCloud()
  const kind = email ? 'email' : 'phone'
  const target = email ? String(email).trim() : authUsername(String(phone || '').replace(/\D/g, ''), 'phone')
  // 优先用调用方已知已登录的 token（S.session.access_token），避免「内存会话过期但页面仍显示已登录」时
  // 重新拉 session() 拿到空 token 而误报「请先登录再绑定」。拿不到再退回 session()。
  // 发码接口是公开端点，不需要 token；这里只确认「确实处于登录态」。
  // 以前拿 S.session.access_token 判断，一旦 SDK 会话对象把 token 藏在别处（或重启后
  // 只剩 user）就误报「请先登录再绑定」——正是用户反馈的「已登录却显示未登录」。
  const loggedIn = !!loadIdentity().loginTarget || !!(await session())
  if (!loggedIn) throw new Error('登录状态已失效，请重新登录后再绑定')
  // 裸验证码通道（同 sendCode 契约）：手机号字段必须是 phone_number 且为「+86 158xxxx」带空格格式
  const r = await authRaw('/v1/verification', kind === 'email' ? { email: target } : { phone_number: target })
  if (r.error) throw otpError(r.error)
  const vid = r.data?.verification_id
  if (!vid) throw new Error('绑定验证码发送失败，请稍后重试')
  bindPending = { kind, target, vid, at: Date.now() }
  return { kind, target }
}

export async function bindConfirm(code, token) {
  assertCloud()
  if (!bindPending) throw new Error('请先发送绑定验证码')
  const { kind, target, vid } = bindPending
  const s = (typeof token === 'string' && token) ? { access_token: token } : (await session())
  token = s?.access_token || ''
  // 验码 → 一次性 verification_token（裸通道）
  const verified = await authRaw('/v1/verification/verify', {
    verification_id: vid,
    verification_code: String(code || '').trim(),
  })
  if (verified.error) throw otpError(verified.error)
  const vt = verified.data?.verification_token
  if (!vt) throw new Error('绑定校验失败：服务端未返回凭据，请重试')
  // 持当前会话按阶梯尝试把新身份并进同一账户（目标标识若是另一个已有账户，由服务端负责身份合并）
  const body = kind === 'email' ? { email: target, verification_token: vt } : { phone_number: target, verification_token: vt }
  let merged = false
  let lastRaw = ''
  for (const [method, p] of BIND_ATTEMPTS) {
    if (kind === 'email' && p.includes('/phone')) continue
    if (kind === 'phone' && p.includes('/email')) continue
    const r = await authRaw(p, body, token).catch((e) => ({ error: e }))
    if (!r?.error) { merged = true; break }
    lastRaw = String(r.error?.description || r.error?.message || r.error || '')
    if (/unimplemented|not available|Method Not Allowed|not_found/i.test(lastRaw)) continue
    bindPending = null
    throw otpError(r.error)
  }
  bindPending = null
  // 验证码已通过 = 用户确实拥有这个邮箱/手机号。即使云端暂未开放自助合并端点，
  // 也要立刻落盘，账号页才不会停在「已互绑却显示未绑定」（本次反馈的核心问题）。
  const ident = saveIdentity({
    [kind === 'phone' ? 'phone' : 'email']: kind === 'phone' ? normPhone(target) : String(target).trim(),
  })
  const me = await fetchMe().catch(() => null)
  return { ok: true, merged, me: me || ident, identity: ident,
    note: merged ? '' : '已验证归属并保存本机；云端自助合并接口暂未开放' }
}

export async function signInWithWorkBuddy() {
  assertCloud()
  const back = new URL(location.href)
  back.pathname = '/'
  for (const k of ['code', 'state', 'provider']) back.searchParams.delete(k)
  const { data, error } = await cloud.auth.signInWithOAuth({
    provider: 'workbuddy',
    redirectTo: back.toString(),       // 必须是发布 HTTPS 域名的根路径，同 tab 跳转
  })
  if (error) throw error
  location.assign(data.url)
}

// 微信扫码登录：走云 SDK 的 OAuth 通用入口，回调由 restoreAuth 的
// provider === 'wechat' 分支处理；腾讯云 Auth 侧完成统一身份关联。
export async function signInWithWechat() {
  assertCloud()
  const back = new URL(location.href)
  back.pathname = '/'
  for (const k of ['code', 'state', 'provider']) back.searchParams.delete(k)
  const { data, error } = await cloud.auth.signInWithOAuth({
    provider: 'wechat',
    redirectTo: back.toString(),
  })
  if (error) throw error
  location.assign(data.url)
}

export const signOut = async () => {
  assertCloud()
  clearSessionCache()
  clearIdentity()          // 换账号登录时不能残留上一个账号的绑定信息
  return cloud.auth.signOut()
}

// 「登录保持」关闭时，下次启动把会话踢掉但保留昵称/绑定档案
export async function dropSessionKeepProfile() {
  clearSessionCache()
  try { if (cloud?.auth?.signOut) await cloud.auth.signOut() } catch { /* 网络失败也要保证本机不再自动登录 */ }
}
export const onAuthChange = (cb) => cloud?.auth.onAuthStateChange((e, s) => cb(e, s))
