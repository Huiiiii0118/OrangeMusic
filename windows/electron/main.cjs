/* 橙子音乐 · Windows 桌面版主进程（Electron）。
   与旧版最大的区别：
   1. **不再起本地 HTTP 服务 + 借系统 Edge 打开页面** —— Chromium 就在 exe 里，页面用自定义协议直接读内嵌资源；
   2. 全部依赖（Chromium / Node / 资源）随包，单文件分发，目标机器不需要装任何东西；
   3. 需要绕 CORS 的请求仍由主进程代发，但入口是 app://orangemusic/api/net，不占用任何端口。 */
'use strict'
const { app, BrowserWindow, protocol, shell, ipcMain, Menu, nativeTheme, dialog, Tray, nativeImage, screen, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { proxyNet, resolveMediaUrl, fetchImageBase64 } = require('./net.cjs')

const SCHEME = 'app'
const HOST = 'orangemusic'

// 品牌更名：userData 从「净听音乐」改为「橙子音乐」。
// 必须在 Chromium 创建 profile 之前 setPath；首次启动把旧 profile 整目录复制过来，
// 登录态 / 收藏 / 歌单 / localStorage 才不会丢。旧目录保留，方便回退。
const APP_DATA = app.getPath('appData')
// OM_USER_DATA 只用于自检：指向一个空目录时，会自动从旧 profile 完整复制一份再跑。
const USER_DATA = process.env.OM_USER_DATA ? path.resolve(process.env.OM_USER_DATA) : path.join(APP_DATA, '橙子音乐')
const OLD_USER_DATA = path.join(APP_DATA, '净听音乐')
const MIGRATE_FLAG = path.join(USER_DATA, 'orangemusic-migrated')
// 自己逐文件复制，不用 fs.cpSync：能精确控制「目标已有就不覆盖」，也避开不同 Node 版本的实现差异。
function copyProfile(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name)
    let st
    try { st = fs.statSync(s) } catch { continue }
    if (st.isDirectory()) copyProfile(s, d)
    else if (!fs.existsSync(d)) { try { fs.copyFileSync(s, d) } catch { /* 单个文件失败不影响整体 */ } }
  }
}
if (!fs.existsSync(MIGRATE_FLAG) && fs.existsSync(OLD_USER_DATA)) {
  try {
    // 新目录里还没有真正的 profile 数据才复制；已有数据说明用户跑过新版，不能覆盖。
    if (!fs.existsSync(path.join(USER_DATA, 'Local Storage'))) copyProfile(OLD_USER_DATA, USER_DATA)
    fs.mkdirSync(USER_DATA, { recursive: true })
    fs.writeFileSync(MIGRATE_FLAG, new Date().toISOString())
  } catch (e) { /* 迁移失败不阻塞启动，仍可用新目录 */ }
}
app.setPath('userData', USER_DATA)

// Windows 系统媒体面板（SMTC）与音量混合器靠 AppUserModelID 认应用。
// 免安装 exe 没有安装注册身份，只调用 setAppUserModelId 系统仍然显示「未知应用」，
// 必须在 HKCU\Software\Classes\AppUserModelId\<id> 下注册 DisplayName / IconUri，
// 系统才会把这条 AUMID 显示成「橙子音乐」。
// 根因：DisplayName 是中文。命令行把中文塞进 reg.exe / PowerShell 容易受系统代码页或
// 执行策略影响而写入失败/乱码 → 系统读不到正确名称 → 一直「未知应用」。
// 彻底解法：用 UTF-16LE(.reg) 文件导入（中文写在文件内容里，与代码页无关，100% 不乱码），
// PowerShell / reg add 仅作兜底；最后回读校验必须是真正的中文「橙子音乐」，否则视为失败自愈。
// ★ 一次性根治「未知应用」的真正根因 ★
// Windows 的媒体面板 / 音量混合器读的是 SMTC 会话的 SourceAppUserModelId，
// 再由「应用解析器」把这条 ID 反查成显示名。反查的唯一权威依据是
// 「开始菜单里 .lnk 的 System.AppUserModel.ID 属性 + 快捷方式的文件名」。
// 免安装 exe 从来没建过开始菜单快捷方式，所以无论注册表 DisplayName 怎么写，
// 系统都查不到名字 → 一直显示「未知应用」（QQ音乐等正常安装的软件都有这个 .lnk）。
// 另外：快捷方式 target 必须等于当前**正在运行**的 exe（NSIS 解压后的内层
// 橙子音乐.exe），指向外层安装包会让系统「无法把运行进程关联回快捷方式」。
// 解压目录带构建号，所以每次启动都要重写一遍，保证 target 永远是 process.execPath。
// 换成全新的 AUMID：旧的 OrangeMusic.Desktop 可能已被系统缓存成「未知应用」。
const AUMID = 'OrangeMusic.Desktop.Player'
function ensureAumidRegistry(id) {
  const icon = (() => {
    try {
      const ico = path.join(__dirname, 'build', 'icon.ico')
      return fs.existsSync(ico) ? ico : process.execPath
    } catch { return process.execPath }
  })()
  const keyPath = `HKCU\\Software\\Classes\\AppUserModelId\\${id}`
  const psPath = `HKCU:\\Software\\Classes\\AppUserModelId\\${id}`
  const displayName = '橙子音乐'
  // 主通道：写 UTF-16LE(.reg) 再 import，中文绝不依赖代码页 / PowerShell 执行策略
  const regFile = (() => {
    try {
      const dir = app.getPath('temp')
      const f = path.join(dir, `om-aumid-${id}.reg`)
      const body =
        'Windows Registry Editor Version 5.00\r\n\r\n' +
        `[${keyPath}]\r\n` +
        `"DisplayName"="${displayName}"\r\n` +
        `"IconUri"="${String(icon).replace(/\\/g, '\\\\')}"\r\n`
      const bom = Buffer.from([0xff, 0xfe])
      fs.writeFileSync(f, Buffer.concat([bom, Buffer.from(body, 'utf16le')]))
      return f
    } catch { return '' }
  })()
  const write = () => {
    if (regFile) {
      try {
        require('node:child_process').execFileSync('reg.exe', ['import', regFile], { windowsHide: true, timeout: 15000 })
        return true
      } catch { /* 落 PowerShell */ }
    }
    try {
      const ps = `New-Item -Path '${psPath}' -Force | Out-Null; ` +
        `Set-ItemProperty -Path '${psPath}' -Name 'DisplayName' -Value '${displayName}' -Type String -Force; ` +
        `Set-ItemProperty -Path '${psPath}' -Name 'IconUri' -Value '${String(icon).replace(/'/g, "''")}' -Type String -Force`
      require('node:child_process').execFileSync(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 15000 })
      return true
    } catch {
      try {
        const { execFileSync } = require('node:child_process')
        execFileSync('reg', ['add', keyPath, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f'], { windowsHide: true, timeout: 6000 })
        execFileSync('reg', ['add', keyPath, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f'], { windowsHide: true, timeout: 6000 })
        return true
      } catch { return false }
    }
  }
  if (!write()) return false
  // 回读验证：必须是真正的中文「橙子音乐」，否则视为失败（下次启动重试），避免乱码被当成成功
  try {
    const { execFileSync } = require('node:child_process')
    const out = String(execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-ItemProperty -Path '${psPath}').DisplayName`],
      { windowsHide: true, timeout: 12000, encoding: 'utf8' })).trim()
    return out === displayName
  } catch {
    try {
      const { execFileSync } = require('node:child_process')
      const out = String(execFileSync('reg', ['query', keyPath, '/v', 'DisplayName'], { windowsHide: true, timeout: 6000, encoding: 'utf8' }))
      return out.includes(displayName)
    } catch { return false }
  }
}

// 开始菜单快捷方式：系统媒体面板显示「橙子音乐」的关键。
// 每次启动都重写（免安装版解压目录随构建号变化），并回读校验 AUMID 确实写进 .lnk。
// 媒体面板诊断日志：普通启动也写（self-test 的 logLine 只在 --self-test 下写），
// 便于验证 AUMID / 开始菜单快捷方式是否真的就绪，不用开调试模式。
const smtcDiag = (msg) => {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true })
    fs.appendFileSync(path.join(USER_DATA, 'smtc-diag.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch { /* 目录只读就算了 */ }
}
function ensureStartMenuShortcut() {
  const say = (m) => { smtcDiag(m); try { logLine(m) } catch { /* 启动早期日志模块尚未就绪 */ } }
  if (process.platform !== 'win32') return false
  try {
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    fs.mkdirSync(programs, { recursive: true })
    const lnk = path.join(programs, '橙子音乐.lnk')
    // 快捷方式图标直接指向当前运行的 exe（始终在磁盘上、自带我们的图标），
    // 不走 asar 内的 icon.ico 路径（writeShortcutLink 读不了 asar 虚拟路径）。
    const details = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: '橙子音乐 · Orange Music',
      appUserModelId: AUMID,
      icon: process.execPath,
      iconIndex: 0,
    }
    // 先 create（文件已存在时部分 Electron 版本会返回 false），再 replace 兜住
    let ok = false
    try { ok = !!shell.writeShortcutLink(lnk, 'create', details) } catch { /* 落到 replace */ }
    if (!ok) ok = !!shell.writeShortcutLink(lnk, 'replace', details)
    let back = null
    try { back = shell.readShortcutLink(lnk) } catch { /* ignore */ }
    const valid = !!ok && back?.appUserModelId === AUMID && back?.target === process.execPath
    say(`[smtc] shortcut=${lnk} ok=${ok} aumid=${back?.appUserModelId || ''} valid=${valid}`)
    return valid
  } catch (e) {
    say('[smtc] shortcut failed: ' + (e?.message || e))
    return false
  }
}

// 注册表 DisplayName=橙子音乐 由 NSIS launcher 原生 WriteRegStr 写入（不依赖 reg.exe / powershell，
// 规避命令安全策略拦截外部进程导致的「未知应用」反复失败）。这里只负责进程级 AUMID 与开始菜单 .lnk。
let AUMID_REG_OK = true
if (process.platform === 'win32') {
  try { app.setName('橙子音乐') } catch { /* 部分平台不支持 */ }
  app.setAppUserModelId(AUMID)
}

// 自检时可以指向别的站点目录（例如 iPhone 版 ios/www）。OM_* 为现名，QM_* 兼容旧的调试脚本。
const WWW_ARG = process.env.OM_WWW || process.env.QM_WWW || ''
const WWW = WWW_ARG ? path.resolve(WWW_ARG) : path.join(__dirname, 'www')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

// ── 云 SDK 的跨域放行（关键）──────────────────────────────────────────────
// 云服务只接受「已发布 HTTPS 域名」的 Origin；桌面端页面跑在 app://orangemusic 上，
// 直接请求会被 CORS 挡成 TypeError: Failed to fetch，表现就是「联网登录/歌单同步全失效」。
// 做法：出站请求把 Origin 改写成发布域名（让服务端认可），
//      回包再把 Access-Control-Allow-Origin 改回页面的真实 origin（让浏览器认可）。
const RELEASE_ORIGIN = 'https://quiet-music.app.workbuddy.host'
const PAGE_ORIGIN = 'app://orangemusic'
function patchCloudCors() {
  try {
    const ses = session.defaultSession
    const filter = { urls: ['https://quiet-music.app.workbuddy.host/*', 'https://*.workbuddy.host/*', 'https://www.workbuddy.cn/*'] }
    ses.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
      const h = { ...(d.requestHeaders || {}) }
      h.Origin = RELEASE_ORIGIN
      if (!h.Referer) h.Referer = RELEASE_ORIGIN + '/'
      cb({ requestHeaders: h })
    })
    ses.webRequest.onHeadersReceived(filter, (d, cb) => {
      const h = { ...(d.responseHeaders || {}) }
      const set = (name, val) => {
        for (const k of Object.keys(h)) if (k.toLowerCase() === name) delete h[k]
        h[name] = val
      }
      set('access-control-allow-origin', [PAGE_ORIGIN])
      set('access-control-allow-credentials', ['true'])
      set('access-control-allow-headers', ['authorization, content-type, x-wb-publishable-key, x-wb-key, apikey, x-requested-with, accept, accept-language, origin, cache-control, pragma, range, if-none-match, x-client-info'])
      set('access-control-allow-methods', ['GET, POST, PUT, PATCH, DELETE, OPTIONS'])
      set('access-control-expose-headers', ['content-length, content-range, etag, x-request-id'])
      cb({ responseHeaders: h })
    })
    return true
  } catch { return false }
}

function resolveAsset(pathname) {
  let rel = decodeURIComponent(pathname || '/')
  rel = rel.replace(/^\/+/, '').replace(/\\/g, '/').replace(/\.\./g, '')
  if (!rel) rel = 'index.html'
  let p = path.join(WWW, rel)
  if (!p.startsWith(WWW)) return null
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html')
  return fs.existsSync(p) ? p : null
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function handleNet(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method !== 'POST') return jsonResponse({ error: '仅支持 POST' }, 405)
  let payload
  try { payload = JSON.parse(await request.text() || '{}') } catch { return jsonResponse({ error: '请求体不是 JSON' }, 400) }
  let builtinOk = false
  try {
    // 内置音乐引擎：渲染端用 localapi:// 伪 scheme 发请求（无需用户填地址/部署/起端口）。
    // 必须在 SSRF 检查前拦截——localapi 不是真实网络请求，由主进程直接调函数返回。
    // 兼容 localapi:/xxx、localapi:///xxx 等所有斜杠形态（渲染端拼接时可能被剥斜杠）。
    if (/^localapi:/i.test(String(payload.url || ''))) {
      try {
        const localApi = require('./local-api.cjs')
        const u = new URL(payload.url)
        const out = await localApi.handle(u)
        builtinOk = true
        return jsonResponse(out)
      } catch (le) {
        builtinOk = true
        return jsonResponse({ statusCode: 200, headers: { 'content-type': 'application/json' }, bodyRaw: JSON.stringify({ code: 500, data: [], msg: '内置引擎：' + (le && le.message) }) })
      }
    }
    // 解析音频直链：跟 302 拿 CDN 真实地址（http 重定向在 secure 页面会被拦，必须换成 https）
    if (payload.resolve) {
      const out = await resolveMediaUrl(payload.url, Math.min(Number(payload.timeout) || 8000, 15000))
      return jsonResponse(out)
    }
    const out = await proxyNet(payload.url, payload.options || {}, payload.timeout)
    return jsonResponse(out)
  } catch (e) {
    if (builtinOk) return jsonResponse({ error: `内置引擎失败：${e.message}` }, 502)
    return jsonResponse({ error: `代发失败：${e.message}` }, 502)
  }
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const u = new URL(request.url)
    if (u.pathname === '/api/net') return handleNet(request)
    const file = resolveAsset(u.pathname)
    if (!file) return new Response('404 Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    try {
      const buf = await fs.promises.readFile(file)
      return new Response(buf, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      })
    } catch (e) {
      return new Response(String(e.message), { status: 500 })
    }
  })
}

let win = null
// 托盘 + 关闭询问：点关闭时问「最小化到托盘还是退出」，托盘常驻保证最小化后还能放歌
let tray = null
let isQuitting = false
let closeAsking = false
// 关闭按钮行为：ask 询问 / tray 最小化到托盘 / quit 直接退出（设置页可改，存在 userData/close-action.json）
let closeAction = 'ask'
// 外层壳（NSIS 启动器）路径：壳 Exec 内层时通过 --om-launcher= 传入（带引号所以是完整 argv 项）。
// 应用内「一键自更新」用它定位并替换壳文件；开发模式 / 直接跑内层时为空，更新退化为手动下载。
const launcherPath = (() => {
  const arg = process.argv.find((a) => a.startsWith('--om-launcher='))
  const p = arg ? arg.slice('--om-launcher='.length).trim().replace(/^"|"$/g, '') : ''
  return p && fs.existsSync(p) ? p : ''
})()
const SELF_TEST = process.argv.includes('--self-test')
const PROBE = process.argv.includes('--probe')   // 只跑音源实测（快，用来验收能不能真的出声）
const SELF_TEST_MUTATE = process.argv.includes('--mutate')
// UI 走查：只截新界面（三模块外壳 / 音乐库 / 播放页 / 精简模式 / 深色），不跑旧断言
const UI_SHOT = process.argv.includes('--ui-shot')
const LOG_DIR = process.env.OM_SHOT_DIR || process.env.QM_SHOT_DIR || (app.isPackaged ? process.cwd() : __dirname)
// GUI 进程在 Windows 上没有 stdout，自检结果同时落盘，便于脚本化排查。
const SHOT_DIR = process.env.OM_SHOT_DIR || process.env.QM_SHOT_DIR || (app.isPackaged ? process.cwd() : __dirname)
const logLine = (msg) => {
  if (!SELF_TEST) return
  try { fs.appendFileSync(path.join(LOG_DIR, '_selftest.log'), msg + '\n') } catch { /* 只读目录就算了 */ }
}
if (SELF_TEST) {
  app.disableHardwareAcceleration()
  try { fs.writeFileSync(path.join(LOG_DIR, '_selftest.log'), '') } catch { /* ignore */ }
  setTimeout(() => { logLine('[self-test] 超时退出'); app.exit(2) }, 420000)
}

// ---- 托盘：关闭窗口后仍可放歌；右键弹出自定义菜单（参考 QQ 音乐托盘样式） ----
let trayMenuWin = null
let trayBalloonShown = false
let trayState = { title: '', artist: '', playing: false, liked: false, volume: 100, mode: 'list' }

function trayIcon() {
  // 注意：main.cjs 跑在 app.asar 内，nativeImage.createFromPath() 无法读取 asar 虚拟路径
  // （它走操作系统文件 API）。必须用 fs.readFileSync（asar 感知）+ createFromBuffer。
  const candidates = [
    path.join(__dirname, 'build', 'icon-tray.png'),
    path.join(app.getAppPath(), 'build', 'icon-tray.png'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
  ]
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p)
      if (!buf || buf.length === 0) continue
      const img = nativeImage.createFromBuffer(buf)
      if (img && !img.isEmpty()) {
        // 托盘图标用小尺寸最稳；大于 64 就缩到 32，避免大图解析/性能问题
        const sz = img.getSize()
        if (sz.width > 64 || sz.height > 64) {
          const r = img.resize({ width: 32, height: 32 })
          if (!r.isEmpty()) return r
        }
        return img
      }
    } catch { /* 换下一个候选 */ }
  }
  return null
}
// 窗口 / 任务栏图标：同在 asar 内，必须用 fs 读 + createFromBuffer（asar 感知），
// 否则 nativeImage.createFromPath 读不了虚拟路径 → 窗口 / 任务栏回退成 Electron 默认图标（地球）。
function appIcon() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon-tray.png'),
    path.join(app.getAppPath(), 'build', 'icon-tray.png'),
  ]
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p)
      if (!buf || buf.length === 0) continue
      const img = nativeImage.createFromBuffer(buf)
      if (img && !img.isEmpty()) return img
    } catch { /* 换下一个候选 */ }
  }
  return undefined
}
function showWindow() {
  if (!win) { createWindow(); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// 托盘右键菜单（自绘弹窗）：上一首/播放/下一首 圆钮 · 爱心+歌名+播放列表 · 音量 · TME Studio · 设置 · 切换账号 · 退出
function trayMenuHtml() {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;font-family:"Microsoft YaHei UI",system-ui,sans-serif;user-select:none;overflow:hidden}
  /* 整体宽度约为旧版的 2/3（296px → 194px）：按钮、字号、行高、内边距同步收紧 */
  .tm{box-sizing:border-box;width:214px;margin:7px;padding:11px 0 9px;border-radius:11px;background:#f7f7f8;border:1px solid rgba(0,0,0,.09);box-shadow:0 14px 32px rgba(0,0,0,.22)}
  /* 三个控制钮：去掉外圈描边，改成纯图标 + 悬停浅底；播放键用品牌橙强调。
     高度由内容撑开（不再靠固定圆径），整个模块随字号/行高自然适配。 */
  .tm-controls{display:flex;align-items:center;justify-content:center;gap:22px;padding:1px 0 9px}
  .tm-cbtn{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#3c3c3c;display:grid;place-items:center;cursor:pointer;flex:none;padding:0;transition:background .14s,color .14s}
  .tm-cbtn:hover{background:#e8e8e8;color:#141414}
  .tm-cbtn.big{width:34px;height:34px;color:#ff7a1a}
  .tm-cbtn.big:hover{background:#ffe9d6;color:#f2660a}
  .tm-now{display:flex;align-items:center;gap:5px;padding:0 8px 10px}
  .tm-ico{width:26px;height:26px;border:0;background:transparent;color:#3c3c3c;display:grid;place-items:center;cursor:pointer;border-radius:5px;flex:none;padding:0}
  .tm-ico:hover{background:#e2e2e2}
  .tm-ico.on{color:#ff4d5e}
  /* 菜单宽度仍保持 194px（上一轮的 2/3），只把字号从 11.5/12px 调回清晰易读的 13/13.5px */
  .tm-title{flex:1;min-width:0;font-size:14px;line-height:22px;color:#232323;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
  .tm-vol{display:flex;align-items:center;gap:8px;padding:0 11px 11px;color:#5a5a5a}
  /* 之前 input 只有 3px 高：滑块被裁掉、鼠标命中区错位，向右拖反而变小。改成 18px 可拖区 + 自绘轨道。 */
  .tm-vol input{flex:1;min-width:0;height:18px;margin:0;padding:0;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}
  .tm-vol input::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:#c9c9c9}
  .tm-vol input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:15px;height:15px;margin-top:-6px;border:0;border-radius:50%;background:#7a7a7a;box-shadow:0 1px 3px rgba(0,0,0,.22)}
  .tm-vol input:hover::-webkit-slider-thumb{background:#5a5a5a}
  .tm-sep{height:1px;background:rgba(0,0,0,.08);margin:2px 6px}
  /* 所有菜单项同一行高、同一图标占位：文本符号（♪ ⚙ ◎ ⊘）宽度不一会看着歪，统一换成 16px SVG。 */
  .tm-item{display:flex;align-items:center;gap:8px;width:100%;height:38px;box-sizing:border-box;border:0;background:transparent;padding:0 13px;font-size:15px;line-height:22px;color:#232323;cursor:pointer;text-align:left}
  .tm-item:hover{background:#e8e8e8}
  .tm-item.danger{color:#e04a3f}
  .tm-item .mi{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;color:#6b6b6b}
  .tm-item .mi svg{display:block}
  .tm-item.danger .mi{color:#e04a3f}
  .tm-item .ml{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tm-item .ma{flex:none;color:#9a9a9a;font-size:12px}
  /* 播放模式选择：就地展开的三行（顺序/单曲/随机），缩进对齐主项文本 */
  .tm-modes{padding:2px 0 4px}
  .tm-mode{display:flex;align-items:center;gap:8px;width:100%;height:32px;box-sizing:border-box;border:0;background:transparent;padding:0 13px 0 39px;font-size:14px;line-height:20px;color:#444;cursor:pointer;text-align:left}
  .tm-mode:hover{background:#e8e8e8}
  .tm-mode.on{color:#e8730d;font-weight:600}
  .tm-mode.on svg{color:#e8730d}
  .tm-mode svg{color:#6b6b6b;flex:none}
  .tm-mode span{white-space:nowrap}
  .tm-queue-title{padding:2px 13px 4px;font-size:12px;color:#9a9a9a}
  .tm-queue{display:flex;flex-direction:column;max-height:186px;overflow:auto}
  .tm-qitem{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;border:0;background:transparent;padding:6px 13px;cursor:pointer;text-align:left}
  .tm-qitem:hover{background:#e8e8e8}
  .tm-qtitle{font-size:13px;line-height:18px;color:#232323;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tm-qartist{font-size:11px;line-height:15px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tm-qempty{padding:6px 13px 8px;font-size:12px;color:#9a9a9a}
  </style></head><body><div class="tm">
    <div class="tm-controls">
      <button class="tm-cbtn" data-act="prev" title="上一首"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19.4 6.2v11.6L9.8 12z"/></svg></button>
      <button class="tm-cbtn big" data-act="play" id="tmPlay" title="播放 / 暂停"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="tm-cbtn" data-act="next" title="下一首"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM4.6 6.2 14.2 12 4.6 17.8z"/></svg></button>
    </div>
    <div class="tm-now">
      <button class="tm-ico" data-act="fav" id="tmFav" title="收藏到我喜欢"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg></button>
      <div class="tm-title" id="tmTitle" title="">未在播放</div>
      <button class="tm-ico" data-act="togglequeue" id="tmQueueBtn" title="播放队列"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h9"/><path d="m16.4 15.4 2.4 1.6-2.4 1.6"/></svg></button>
    </div>
    <div class="tm-sep"></div>
    <div class="tm-vol">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 9.2v5.6h3.6L12.6 19V5l-5 4.2H4z"/></svg>
      <input type="range" id="tmVol" min="0" max="100" value="100" aria-label="音量">
    </div>
    <div class="tm-sep"></div>
    <button class="tm-item" data-act="cyclemode" id="tmCycleMode"><span class="mi" id="tmCycleIco"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h9"/><path d="m16.4 15.4 2.4 1.6-2.4 1.6"/></svg></span><span class="ml" id="tmCycleLbl">顺序播放</span></button>
    <div class="tm-sep"></div>
    <button class="tm-item" data-act="settings"><span class="mi"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06-2.02 2.02-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V20h-2.86v-.06a1.6 1.6 0 0 0-1-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06-2.02-2.02.06-.06A1.6 1.6 0 0 0 7.6 15a1.6 1.6 0 0 0-1.47-1H6v-2.86h.06a1.6 1.6 0 0 0 1.47-1 1.6 1.6 0 0 0-.32-1.77l-.06-.06 2.02-2.02.06.06A1.6 1.6 0 0 0 11 6.6a1.6 1.6 0 0 0 1-1.47V5h2.86v.06a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06 2.02 2.02-.06.06A1.6 1.6 0 0 0 19.4 10a1.6 1.6 0 0 0 1.47 1H21v2.86h-.06a1.6 1.6 0 0 0-1.47 1z"/></svg></span><span class="ml">设置</span></button>
    <div class="tm-sep"></div>
    <button class="tm-item" data-act="about"><span class="mi"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5.2"/><path d="M12 7.6h.01"/></svg></span><span class="ml">关于</span></button>
    <button class="tm-item danger" data-act="quit"><span class="mi"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m6.5 6.5 11 11"/></svg></span><span class="ml">退出橙子音乐</span></button>
  </div>
  <script>
  (function () {
    const { ipcRenderer } = require('electron')
    const $ = (id) => document.getElementById(id)
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const PLAY_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    const PAUSE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>'
    const HEART_SVG = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>'
    const HEART_ON_SVG = '<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>'
    // 播放模式图标：随机 / 顺序 / 单曲循环 / 列表循环
    const MODES = {
      shuffle: { label: '随机播放', svg: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h3.4l9.2 11H20"/><path d="M4 17.5h3.4l2.6-3.1"/><path d="M17.4 3.9 20 6.5l-2.6 2.6"/><path d="M17.4 14.9 20 17.5l-2.6 2.6"/></svg>' },
      order: { label: '顺序播放', svg: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h9"/><path d="m16.4 15.4 2.4 1.6-2.4 1.6"/></svg>' },
      single: { label: '单曲循环', svg: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-2.4-2.4"/><path d="M20 8v3.2"/><path d="M20 16H7l2.4 2.4"/><path d="M4 16v-3.2"/><text x="12" y="15" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>' },
      list: { label: '列表循环', svg: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-2.4-2.4"/><path d="M20 8v3.2"/><path d="M20 16H7l2.4 2.4"/><path d="M4 16v-3.2"/></svg>' },
    }
    // 托盘里「播放模式选择」整条直接点选循环：顺序 → 单曲 → 随机 → 顺序
    const MODE_CYCLE = ['order', 'single', 'shuffle']
    let curMode = 'order'
    // 用户拖动音量条期间（含松手后 4 秒）不许状态回写覆盖滑块，否则一拖回去就「越来越小」
    let volDraggingUntil = 0
    const clampVol = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100 }
    function apply(s) {
      if (!s) return
      const t = $('tmTitle')
      t.textContent = s.title ? (s.artist ? s.title + ' - ' + s.artist : s.title) : '未在播放'
      t.title = t.textContent
      $('tmFav').innerHTML = s.liked ? HEART_ON_SVG : HEART_SVG
      $('tmFav').classList.toggle('on', !!s.liked)
      $('tmPlay').innerHTML = s.playing ? PAUSE_SVG : PLAY_SVG
      // 「播放模式选择」整条：显示当前模式图标 + 文案，点击即切到下一模式（不展开子菜单）
      curMode = MODE_CYCLE.includes(s.mode) ? s.mode : 'order'
      const cm = $('tmCycleMode')
      if (cm) {
        const cmi = $('tmCycleIco'); const cml = $('tmCycleLbl')
        if (cmi) cmi.innerHTML = (MODES[curMode] || MODES.order).svg
        if (cml) cml.textContent = (MODES[curMode] || MODES.order).label
        cm.title = '播放模式：' + (MODES[curMode] || MODES.order).label + '（点击切换）'
      }
      if (Date.now() > volDraggingUntil) $('tmVol').value = clampVol(s.volume ?? 100)
      const q = $('tmQueue')
      if (q) {
        const items = (s.queue || []).slice(0, 5)
        // 注意：整段 script 是 trayMenuHtml() 外层模板字符串里的「文本」，里面出现插值语法会被外层当成插值而失控。
        // 因此这里用普通字符串拼接，避免插值语法触发外层模板插值。
        q.innerHTML = items.length
          ? items.map((it, i) => '<button class="tm-qitem" data-qi="' + (base + i) + '"><span class="tm-qtitle">' + esc(it.title || '未知曲目') + '</span><span class="tm-qartist">' + esc(it.artist || '') + '</span></button>').join('')
          : '<div class="tm-qempty">队列为空</div>'
      }
    }
    apply(ipcRenderer.sendSync('tray:getState'))
    ipcRenderer.on('tray:state', (_e, s) => apply(s))
    // 队列按钮的高亮由主进程根据「独立队列窗是否打开」回推
    ipcRenderer.on('tray:queueState', (_e, on) => { const b = document.getElementById('tmQueueBtn'); if (b) b.classList.toggle('on', !!on) })
    document.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act
        // 播放队列按钮：在菜单右侧弹出「独立的小队列窗」（不撑高、不遮挡菜单），点一下开/关
        if (act === 'togglequeue') {
          ipcRenderer.send('tray:queue')
          return
        }
        // 播放模式选择：整条点击循环切换（顺序 → 单曲 → 随机），不再展开子菜单
        if (act === 'cyclemode') {
          const cur = MODE_CYCLE.includes(curMode) ? curMode : 'order'
          const next = MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length]
          curMode = next
          ipcRenderer.send('tray:menu', 'setmode:' + next)
          return
        }
        ipcRenderer.send('tray:menu', act)
        if (['settings', 'about', 'account', 'quit'].includes(act)) window.close()
      })
    })
    const tmq = $('tmQueue')
    if (tmq) tmq.addEventListener('click', (e) => {
      const b = e.target.closest('.tm-qitem')
      if (b) ipcRenderer.send('tray:menu', 'jump:' + b.dataset.qi)
    })
    const vol = $('tmVol')
    vol.addEventListener('pointerdown', () => { volDraggingUntil = Date.now() + 4000 })
    vol.addEventListener('input', () => {
      const v = clampVol(vol.value)
      volDraggingUntil = Date.now() + 4000
      ipcRenderer.send('tray:menu', 'volume', v)
    })
    window.addEventListener('blur', () => ipcRenderer.send('tray:menu', 'dismiss'))
  })()
  </script></body></html>`
}

// 退出：托盘菜单、原生兜底菜单、快捷键都走这里，确保 isQuitting 先置位（否则会被 close 拦截重新隐藏）
function quitApp() {
  isQuitting = true
  try { trayQueueWin?.destroy() } catch { /* ignore */ }
  try { trayMenuWin?.destroy() } catch { /* ignore */ }
  try { if (tray) { tray.destroy(); tray = null } } catch { /* ignore */ }
  try { app.quit() } catch { /* ignore */ }
  // 极端情况下 app.quit 被窗口拦下来：2 秒后强杀
  setTimeout(() => { try { app.exit(0) } catch { /* ignore */ } }, 2000)
}

// ── 关闭按钮行为：ask 询问 / tray 最小化到托盘 / quit 退出 ──
const closePrefPath = () => path.join(app.getPath('userData'), 'close-action.json')
function loadCloseAction() {
  try {
    const j = JSON.parse(fs.readFileSync(closePrefPath(), 'utf8'))
    if (['ask', 'tray', 'quit'].includes(j?.action)) closeAction = j.action
  } catch { /* 首次运行没有这个文件 */ }
}
function saveCloseAction(a) {
  if (!['ask', 'tray', 'quit'].includes(a)) return closeAction
  closeAction = a
  try {
    fs.mkdirSync(path.dirname(closePrefPath()), { recursive: true })
    fs.writeFileSync(closePrefPath(), JSON.stringify({ action: a }))
  } catch { /* 只读目录就算了，本次会话内仍然生效 */ }
  return closeAction
}

function hideToTray() {
  if (!tray) createTray()
  if (!tray) {
    // 托盘图标不可用（极端情况）：降级为最小化到任务栏，绝不直接退出软件
    try { win?.minimize() } catch { try { win?.hide() } catch { /* ignore */ } }
    return
  }
  try { win?.hide() } catch { /* ignore */ }
  if (!trayBalloonShown) {
    trayBalloonShown = true
    try { tray.displayBalloon({ title: '橙子音乐', content: '已最小化到托盘，音乐继续播放。右键托盘图标可退出。', iconType: 'info' }) } catch { /* 部分系统不支持气泡 */ }
  }
}

// 首次关闭：问一次「最小化到托盘 / 退出软件」，勾了「记住」就写进配置
// 关闭确认：用应用内的自绘弹窗（和删除确认同一套视觉），不再弹系统灰框。
// 渲染进程收到 app:askClose 后 showCloseDialog()，用户选完回传 app:closeAnswer。
let closeAskTimer = 0
function askCloseAction() {
  if (closeAsking) return
  closeAsking = true
  try {
    if (!win || win.webContents.isLoading()) throw new Error('页面未就绪')
    win.webContents.send('app:askClose')
    win.show(); win.focus()
  } catch {
    // 页面还没准备好才退回系统对话框（属于极少数情况）
    closeAsking = false
    const r0 = dialog.showMessageBoxSync(win || undefined, {
      type: 'question', title: '橙子音乐', message: '关闭橙子音乐时要怎么做？',
      buttons: ['最小化到托盘', '退出软件', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    })
    if (r0 === 0) hideToTray()
    else if (r0 === 1) quitApp()
    return
  }
  clearTimeout(closeAskTimer)
  closeAskTimer = setTimeout(() => { closeAsking = false }, 45000)
}

ipcMain.on('app:closeAnswer', (_e, payload = {}) => {
  const { action, remember } = payload || {}
  closeAsking = false
  clearTimeout(closeAskTimer)
  if (action === 'tray') { if (remember) saveCloseAction('tray'); hideToTray(); return }
  if (action === 'quit') { if (remember) saveCloseAction('quit'); quitApp() }
})

// 原生兜底菜单：自绘窗口弹不出来（透明窗口 + 某些显卡 / 远程桌面）时至少还能控制与退出
function trayFallbackMenu() {
  const act = (a) => { try { win?.webContents.send('tray:cmd', a) } catch { /* ignore */ } }
  return Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { type: 'separator' },
    { label: trayState.playing ? '暂停' : '播放', click: () => act('play') },
    { label: '上一首', click: () => act('prev') },
    { label: '下一首', click: () => act('next') },
    { type: 'separator' },
    { label: '设置…', click: () => { showWindow(); act('settings') } },
    { type: 'separator' },
    { label: '退出橙子音乐', click: () => quitApp() },
  ])
}

let trayMenuShownAt = 0

// 卡片 194px + 四周 6px 阴影留白 = 206px；实际尺寸由 doShow 里量 .tm 后覆盖
let trayMenuSize = { w: 206, h: 360 }

function placeTrayMenu() {
  const mw = trayMenuSize.w, mh = trayMenuSize.h
  let tb = null
  try { tb = tray?.getBounds?.() || null } catch { /* 托盘不支持 getBounds */ }
  const cur = screen.getCursorScreenPoint()
  // 右下角紧贴托盘图标：菜单右边缘对齐图标右边缘，底边压在图标上沿（+2px 视觉缝隙）
  const anchorPt = tb && tb.width ? { x: tb.x + tb.width, y: tb.y } : cur
  const disp = screen.getDisplayNearestPoint(anchorPt) || screen.getPrimaryDisplay()
  const wa = disp.workArea
  // 窗口比卡片大 6px（四周留给阴影），所以定位时按「卡片」的边缘算，再补回 6px 边距
  const cardW = mw - 12, cardH = mh - 12
  let x = Math.round(anchorPt.x - cardW - 6)
  let y = Math.round((tb && tb.width ? anchorPt.y : wa.y + wa.height) - cardH - 6 - 1)
  if (y < wa.y + 2) y = wa.y + 2
  if (x < wa.x + 2) x = wa.x + 2
  if (x + mw > wa.x + wa.width - 2) x = wa.x + wa.width - mw - 2
  const b = trayMenuWin.getBounds()
  if (b.width !== mw || b.height !== mh) trayMenuWin.setBounds({ x, y, width: mw, height: mh })
  else trayMenuWin.setPosition(x, y, false)
}

// 重新量出内容真实尺寸并重新定位：展开 / 收起播放队列后面板高度变了，必须重新量、重新贴边。
async function relayoutTrayMenu() {
  try {
    const r = await trayMenuWin.webContents.executeJavaScript(
      '(() => { const el = document.querySelector(".tm"); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.ceil(b.width) + 12, h: Math.ceil(b.height) + 12 } })()'
    )
    if (r && r.w > 80 && r.h > 80) trayMenuSize = r
  } catch { /* 量不到就用默认值 */ }
  try { placeTrayMenu() } catch { /* ignore */ }
}

function ensureTrayMenuWin() {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) return trayMenuWin
  trayMenuWin = new BrowserWindow({
    width: trayMenuSize.w, height: trayMenuSize.h, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, maximizable: false, minimizable: false,
    transparent: true, hasShadow: false, backgroundColor: '#00000000', acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  })
  trayMenuWin.setMenuBarVisibility(false)
  try { trayMenuWin.setAlwaysOnTop(true, 'pop-up-menu') } catch { /* 旧版本没有 level 参数 */ }
  try {
    const htmlPath = path.join(app.getPath('temp'), 'orangemusic-tray-menu.html')
    fs.writeFileSync(htmlPath, trayMenuHtml(), 'utf8')
    trayMenuWin.loadFile(htmlPath)
  } catch {
    try { trayMenuWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayMenuHtml())) } catch { /* ignore */ }
  }
  // 关键：Windows 从托盘唤起窗口时常先给一次「失焦」，直接 hide 会让菜单刚出就消失（= 点了没反应）
  trayMenuWin.on('blur', () => {
    if (Date.now() - trayMenuShownAt < 320) return
    try { trayMenuWin?.hide() } catch { /* ignore */ }
    hideTrayQueue()
  })
  trayMenuWin.on('closed', () => { trayMenuWin = null })
  return trayMenuWin
}

// ── 独立「播放队列」小窗：紧贴托盘菜单右侧弹出、顶部对齐「正在播放」那一行（用户圈的红框位置），
//    不撑高也不遮挡菜单，距离贴得很近。focusable:false 保证点它不会让菜单失焦收起。
let trayQueueWin = null
function trayQueueHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;font-family:"Microsoft YaHei UI",system-ui,sans-serif;user-select:none;overflow:hidden}
  .tq{box-sizing:border-box;margin:6px;border-radius:11px;background:#f7f7f8;border:1px solid rgba(0,0,0,.09);box-shadow:0 14px 32px rgba(0,0,0,.22);padding:8px 0 6px;overflow:hidden}
  .tq-title{padding:2px 13px 6px;font-size:12px;color:#9a9a9a}
  .tq-list{display:flex;flex-direction:column;overflow:auto}
  .tm-qitem{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;border:0;background:transparent;padding:6px 13px;cursor:pointer;text-align:left}
  .tm-qitem:hover{background:#e8e8e8}
  .tm-qtitle{font-size:13px;line-height:18px;color:#232323;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tm-qartist{font-size:11px;line-height:15px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tm-qempty{padding:8px 13px 10px;font-size:12px;color:#9a9a9a}
  </style></head><body><div class="tq"><div class="tq-title">播放队列</div><div class="tq-list" id="tqList"></div></div>
  <script>
  (function () {
    const { ipcRenderer } = require('electron')
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const list = document.getElementById('tqList')
    function apply(s) {
      if (!s) return
      const all = s.queue || []
      const cur = Number.isFinite(s.index) ? s.index : -1
      // 只列「即将播放」的 3 首（当前曲之后），点一下就换过去
      const base = cur >= 0 ? cur + 1 : 0
      const items = all.slice(base, base + 3)
      list.innerHTML = items.length
        ? items.map((it, i) => '<button class="tm-qitem" data-qi="' + i + '"><span class="tm-qtitle">' + esc(it.title || '未知曲目') + '</span><span class="tm-qartist">' + esc(it.artist || '') + '</span></button>').join('')
        : '<div class="tm-qempty">队列为空</div>'
    }
    apply(ipcRenderer.sendSync('tray:getState'))
    ipcRenderer.on('tray:state', (_e, s) => apply(s))
    list.addEventListener('click', (e) => { const b = e.target.closest('.tm-qitem'); if (b) ipcRenderer.send('tray:menu', 'jump:' + b.dataset.qi) })
  })()
  </script></body></html>`
}
function ensureTrayQueueWin() {
  if (trayQueueWin && !trayQueueWin.isDestroyed()) return trayQueueWin
  trayQueueWin = new BrowserWindow({
    width: 210, height: 220, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, maximizable: false, minimizable: false,
    transparent: true, hasShadow: false, backgroundColor: '#00000000', acceptFirstMouse: true, focusable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  })
  trayQueueWin.setMenuBarVisibility(false)
  try { trayQueueWin.setAlwaysOnTop(true, 'pop-up-menu') } catch { /* 旧版本没有 level 参数 */ }
  try {
    const p = path.join(app.getPath('temp'), 'orangemusic-tray-queue.html')
    fs.writeFileSync(p, trayQueueHtml(), 'utf8')
    trayQueueWin.loadFile(p)
  } catch {
    try { trayQueueWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayQueueHtml())) } catch { /* ignore */ }
  }
  trayQueueWin.on('closed', () => { trayQueueWin = null })
  return trayQueueWin
}
function hideTrayQueue() {
  try { trayQueueWin?.hide() } catch { /* ignore */ }
  try { trayMenuWin && !trayMenuWin.isDestroyed() && trayMenuWin.webContents.send('tray:queueState', false) } catch { /* ignore */ }
}
async function showTrayQueue() {
  try {
    if (!trayMenuWin || trayMenuWin.isDestroyed() || !trayMenuWin.isVisible()) return
    const w = ensureTrayQueueWin()
    // 量「正在播放」行的 Y 位置，让队列窗顶部对齐到那一行（即用户圈出的红框位置）
    let nowTop = 62
    try {
      const t = await trayMenuWin.webContents.executeJavaScript('(() => { const e = document.querySelector(".tm-now"); if (!e) return 0; return Math.round(e.getBoundingClientRect().top) })()')
      if (typeof t === 'number' && t > 0) nowTop = t
    } catch { /* 量不到用默认 */ }
    const mb = trayMenuWin.getBounds()
    const disp = screen.getDisplayNearestPoint({ x: mb.x + Math.floor(mb.width / 2), y: mb.y + Math.floor(mb.height / 2) }) || screen.getPrimaryDisplay()
    const wa = disp.workArea
    const qw = 210
    const total = (trayState.queue || []).length
    const cur = Number.isFinite(trayState.index) ? trayState.index : -1
    const n = Math.max(1, Math.min(3, cur >= 0 ? total - cur - 1 : total))
    const qh = Math.min(320, 46 + n * 45)
    // 菜单卡片右边缘（窗口四周有 6~7px 阴影留白）紧贴队列左边缘，距离很近又不遮挡
    const cardRight = mb.x + mb.width - 7
    let x = cardRight + 4
    if (x + qw > wa.x + wa.width - 2) x = mb.x + 6 - qw - 4   // 右侧放不下 → 放到菜单左边
    if (x < wa.x + 2) x = wa.x + 2
    let y = mb.y + nowTop
    if (y + qh > wa.y + wa.height - 4) y = wa.y + wa.height - qh - 4
    if (y < wa.y + 2) y = wa.y + 2
    w.setBounds({ x, y, width: qw, height: qh })
    w.showInactive()   // 不抢焦，避免菜单因失焦收起
    try { trayMenuWin.webContents.send('tray:queueState', true) } catch { /* ignore */ }
  } catch (e) { logLine('[tray] 队列弹窗失败：' + e.message) }
}
function toggleTrayQueue() {
  if (trayQueueWin && !trayQueueWin.isDestroyed() && trayQueueWin.isVisible()) { hideTrayQueue(); return }
  showTrayQueue()
}

function showTrayMenu() {
  try {
    const w = ensureTrayMenuWin()
    // 再点一次收起（避免用户以为菜单卡住）
    if (w.isVisible()) { trayMenuShownAt = 0; w.hide(); hideTrayQueue(); return }
    let shown = false
    const doShow = async () => {
      if (shown || !trayMenuWin || trayMenuWin.isDestroyed()) return
      shown = true
      hideTrayQueue()   // 每次重新打开菜单，队列小窗默认收起
      // 先量出内容真实尺寸：写死高度会让菜单底部和卡片对不上，看着「离图标很远」
      await relayoutTrayMenu()
      try { win?.webContents.send('tray:cmd', 'sync') } catch { /* 窗口不在就算了 */ }
      trayMenuShownAt = Date.now()
      w.show()
      w.focus()
    }
    // 页面还没加载完就 show() 会得到一个「透明空窗」——看着就是菜单没弹出来。
    // 所以等 did-finish-load；超过 800ms 还没显示就退化成原生菜单，保证永远能退出。
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', doShow)
    } else {
      doShow()
    }
    setTimeout(() => {
      if (shown) return
      logLine('[tray] 自绘菜单加载超时，改用原生菜单')
      try { tray?.popUpContextMenu(trayFallbackMenu()) } catch { /* ignore */ }
    }, 800)
  } catch (e) {
    logLine('[tray] 菜单弹窗失败：' + e.message)
    try { tray?.popUpContextMenu(trayFallbackMenu()) } catch { /* ignore */ }
  }
}

function createTray() {
  if (tray) return
  const icon = trayIcon()
  if (!icon) { logLine('[tray] 找不到图标，跳过托盘'); return }
  try {
    tray = new Tray(icon)
    tray.setToolTip('橙子音乐 · Orange Music')
    tray.setIgnoreDoubleClickEvents(false)
    tray.on('click', () => showWindow())
    tray.on('double-click', () => showWindow())
    tray.on('right-click', () => showTrayMenu())
    // 部分 Windows 环境右键不触发 right-click（例如某些触控板驱动），中键也给一条路
    tray.on('middle-click', () => showTrayMenu())
  } catch (e) { logLine('[tray] 创建失败：' + e.message) }
}

// 托盘 ↔ 渲染进程状态 / 指令
ipcMain.on('tray:getState', (e) => { e.returnValue = trayState })
ipcMain.on('tray:state', (_e, s) => {
  trayState = { ...trayState, ...(s || {}) }
  try { trayMenuWin && !trayMenuWin.isDestroyed() && trayMenuWin.webContents.send('tray:state', trayState) } catch { /* ignore */ }
  try { trayQueueWin && !trayQueueWin.isDestroyed() && trayQueueWin.webContents.send('tray:state', trayState) } catch { /* ignore */ }
})
// 托盘菜单里点「播放队列」按钮：切换独立队列小窗
ipcMain.on('tray:queue', () => toggleTrayQueue())
// 托盘菜单内展开 / 收起播放队列后面板高度变化，重新量尺寸并贴边
ipcMain.on('tray:resize', async () => {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) { try { await relayoutTrayMenu() } catch { /* ignore */ } }
})
ipcMain.on('tray:menu', (_e, act, val) => {
  if (act === 'quit') { quitApp(); return }
  if (act === 'dismiss') { try { trayMenuWin?.hide() } catch { /* ignore */ }; hideTrayQueue(); return }
  if (act.startsWith('jump:')) {
    const i = Number(act.slice(5))
    if (Number.isFinite(i)) { try { win?.webContents.send('tray:cmd', 'jump', i) } catch { /* ignore */ } }
    return
  }
  if (act === 'volume') {
    const v = Math.max(0, Math.min(100, Number(val) || 0))
    trayState = { ...trayState, volume: v }
    try { win?.webContents.send('tray:cmd', 'volume', v) } catch { /* ignore */ }
    return
  }
  if (act.startsWith('setmode:')) {
    const m = act.slice(8)
    if (['order', 'single', 'shuffle', 'list'].includes(m)) {
      try { trayState = { ...trayState, mode: m } } catch { /* ignore */ }
      try { win?.webContents.send('tray:cmd', 'setmode', m) } catch { /* ignore */ }
    }
    return
  }
  try { win?.webContents.send('tray:cmd', act) } catch { /* ignore */ }
  if (act === 'list' || act === 'settings' || act === 'about' || act === 'account') {
    showWindow()
    try { trayMenuWin?.hide() } catch { /* ignore */ }
    hideTrayQueue()
  }
})

function createWindow() {
  const [w0, h0] = (process.env.OM_SIZE || process.env.QM_SIZE || '').split('x').map(Number)
  win = new BrowserWindow({
    width: w0 > 200 ? w0 : 1320,
    height: h0 > 200 ? h0 : 880,
    minWidth: SELF_TEST ? 320 : 1000,
    minHeight: SELF_TEST ? 400 : 660,
    show: false,
    frame: false,
    // 透明窗口：精简模式要「浮起的圆角卡片 + 溢出卡片的圆形封面」，
    // 只有透明窗口才能做到（普通模式下 .window 自己铺满不透明底色，看不出差别）。
    // show:false + ready-to-show 已保证首帧画好才显示，不会闪一下透明窗。
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: '橙子音乐',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 允许后台节流：窗口最小化 / 被完全遮挡时暂停渲染与定时器，显著降低待机 CPU、GPU。
      // 音频播放不受影响（media 元素不参与节流），进度由 player.position 事件驱动。
      backgroundThrottling: true,
    },
  })

  // 进程级 AUMID 必须在任何窗口/UI 创建之前设置（模块顶层已设置，这里再兜一次）。
  // Chromium 的 SMTC 会话把这条例程 ID 上报给 Windows，媒体面板才能反查到「橙子音乐」。
  try { app.setAppUserModelId(AUMID) } catch { /* 进程级 AUMID */ }
  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => {
    win.show()
    if (!SELF_TEST) win.focus()
  })
  win.loadURL(`${SCHEME}://${HOST}/index.html`)

  if (UI_SHOT) {
    const wlog = (m) => { try { fs.appendFileSync(path.join(SHOT_DIR, '_uishot.log'), m + '\n') } catch { /* ignore */ } }
    const runJS = (code) => win.webContents.executeJavaScript(code)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const shot = async (name) => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG())
      wlog(`shot ${name}`)
    }
    win.webContents.on('console-message', (ev) => {
      if (ev.level === 'error' || ev.level === 'warning') wlog('CONSOLE ' + String(ev.message).slice(0, 300))
    })
    win.webContents.once('did-finish-load', async () => {
      // --probe：只做音源实测，不跑整套截图流程（整套偶发 Render frame disposed，很费时间）
      if (PROBE) {
        try {
          await wait(3000)
          const res = await run(`(async () => {
            const w = (ms) => new Promise((r) => setTimeout(r, ms))
            document.querySelector('[data-section="rise"]')?.click(); await w(3000)
            for (let i = 0; i < 12 && !document.querySelectorAll('.orange-cp-name').length; i++) await w(700)
            const rows = [...document.querySelectorAll('.orange-cp-name')].slice(0, 5)
            const out = []
            for (const b of rows) {
              b.click(); await w(5200)
              const a = document.getElementById('previewAudio')
              const bar = (document.getElementById('barTitle')?.textContent || '').slice(0, 14)
              out.push({ song: b.textContent.slice(0, 14), bar, ok: !!(a && a.currentTime > 0.3 && !a.paused), src: (a && a.src || '').slice(0, 60) })
              try { a && a.pause() } catch (e) {}
            }
            return out
          })()`)
          logLine('[probe] ' + JSON.stringify(res))
        } catch (e) {
          logLine('[probe] 失败：' + e.message)
        }
        app.quit()
        return
      }
      try {
        fs.writeFileSync(path.join(SHOT_DIR, '_uishot.log'), '')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 80 && !document.querySelector('.orange-home .orange-song'); i++) await w(500);
          await w(2500); return 1 })()`)
        await shot('_ui1_home.png')
        // 逐个试歌，直到有真能取到播放链接的那一首（音源偶发拿不到直链）。
        let played = 0
        for (let i = 0; i < 6 && !played; i++) {
          played = await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
            const b = document.querySelectorAll('.orange-home .orange-song')[${i}];
            if (!b) return 0
            b.click(); await w(3200);
            const t = document.querySelector('#barTitle')?.textContent || ''
            if (t && t !== '未在播放') { document.querySelector('#barLikeBtn')?.click(); await w(700); return 1 }
            return 0 })()`)
        }
        wlog('played=' + played)
        await shot('_ui2_home_liked.png')
        const goLib = async (lib) => {
          await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('.orange-side-item[data-lib="${lib}"]')?.click(); await w(1200); return 1 })()`)
          await wait(400)
        }
        await goLib('我喜欢'); await shot('_ui3_like.png')
        await goLib('最近播放'); await shot('_ui4_recent.png')
        await goLib('本地/下载'); await shot('_ui5_local.png')
        await goLib('试听列表'); await shot('_ui6_demo.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('.orange-nav[data-section="home"]')?.click(); await w(1200);
          document.querySelector('#barCover')?.click(); await w(2600); return 1 })()`)
        await shot('_ui7_player.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#npListBtn')?.click(); await w(900); return 1 })()`)
        await shot('_ui7b_queue.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#npListBtn')?.click(); await w(500);
          document.querySelector('#npQualityBtn')?.click(); await w(700); return 1 })()`)
        await shot('_ui7c_quality.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.body.click(); await w(300); return 1 })()`)
        await shot('_ui7d_clean.png')
        // 播放模式浮层 + 词曲同步自检
        const sync = await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#npModeBtn')?.click(); await w(600)
          const box = document.querySelector('#npLyrics')
          const on = box?.querySelector('.lyric-line.on')
          const lines = [...(box?.querySelectorAll('.lyric-line') || [])]
          const i = on ? lines.indexOf(on) : -1
          return {
            audioMs: Math.round((document.querySelector('#previewAudio')?.currentTime || 0) * 1000),
            onIdx: i, onMs: on?.dataset.t || '', nextMs: lines[i + 1]?.dataset.t || '',
            onTop: on ? Math.round(on.getBoundingClientRect().top - box.getBoundingClientRect().top) : -1,
            boxH: box ? Math.round(box.clientHeight) : 0,
          } })()`)
        wlog('sync=' + JSON.stringify(sync))
        await shot('_ui7e_mode.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.body.click(); await w(300); return 1 })()`)
        // 歌词拖动：按住左键上下拖 → 时间线浮标
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          const box = document.querySelector('#npLyrics'); if (!box) return 0
          const r = box.getBoundingClientRect()
          const opt = (y) => ({ bubbles: true, button: 0, pointerId: 7, isPrimary: true, clientX: r.left + 60, clientY: y })
          box.dispatchEvent(new PointerEvent('pointerdown', opt(r.top + 140)))
          await w(80)
          box.dispatchEvent(new PointerEvent('pointermove', opt(r.top + 70)))
          await w(260); return 1 })()`)
        await shot('_ui7g_lyric_drag.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#npLyricBtn')?.click(); await w(700); return 1 })()`)
        await shot('_ui7h_no_lyric.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#npLyricBtn')?.click(); await w(600); return 1 })()`)
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          const box = document.querySelector('#npLyrics')
          box?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }))
          await w(400); return 1 })()`)
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          const box = document.querySelector('#npLyrics')
          box?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }))
          await w(500); return 1 })()`)
        // 进度条拖动自检：把滑块设到 50%，看音频是否真的跳过去
        const seekTest = await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          const a = document.querySelector('#previewAudio')
          const s = document.querySelector('#npSeek')
          const before = a ? a.currentTime : 0
          if (s) { s.value = 500; s.dispatchEvent(new Event('input', { bubbles: true })) }
          await w(700)
          return { before: Math.round(before * 1000), after: Math.round((a?.currentTime || 0) * 1000), dur: Math.round((a?.duration || 0) * 1000) } })()`)
        wlog('seek=' + JSON.stringify(seekTest))
        // 队列：任何页面都能开（先收起播放页）
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#collapseBtn')?.click(); await w(500);
          document.querySelector('#barList')?.click(); await w(700); return 1 })()`)
        await shot('_ui7f_queue_home.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.body.click(); await w(400); return 1 })()`)

        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#collapseBtn')?.click(); await w(600);
          document.querySelector('#tbCollapse')?.click(); await w(900); return 1 })()`)
        await wait(1200)
        await shot('_ui8_mini.png')
        // 模式菜单 / 设置页 / 关于弹层（先退出精简模式）
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#miniClose')?.click(); await w(1000);
          document.querySelector('.orange-nav[data-section="home"]')?.click(); await w(900);
          document.querySelector('#qqTheme')?.click(); await w(700); return 1 })()`)
        await shot('_ui8b_theme.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.body.click(); await w(400);
          document.querySelector('#qqCog')?.click(); await w(1600); return 1 })()`)
        await shot('_ui8c_settings.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#qqAbout')?.click(); await w(900); return 1 })()`)
        await shot('_ui8d_about.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#closeAboutBtn')?.click(); await w(500);
          document.documentElement.dataset.scheme = 'dark';
          try { localStorage.setItem('orangemusic:scheme', 'dark') } catch (e) {}
          document.querySelector('.orange-nav[data-section="home"]')?.click(); await w(1200); return 1 })()`)
        await wait(900)
        await shot('_ui9_dark.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('.orange-side-item[data-lib="我喜欢"]')?.click(); await w(1200); return 1 })()`)
        await shot('_ui10_like_dark.png')
        await runJS(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('.orange-nav[data-section="home"]')?.click(); await w(900);
          document.querySelector('#barCover')?.click(); await w(2200); return 1 })()`)
        await shot('_ui11_player_dark.png')
        wlog('done')
        app.exit(0)
      } catch (e) {
        wlog(`ERR ${e.message}`)
        app.exit(3)
      }
    })
  }

  if (SELF_TEST) {
    // 自检时把渲染进程的错误/警告打到终端，便于定位「点了没反应」这类问题
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) logLine(`[renderer] ${message} (${String(sourceId).split('/').pop()}:${line})`)
    })
    const run = (code) => win.webContents.executeJavaScript(code)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const shot = async (name) => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG())
      logLine(`[self-test] 截图 ${name}`)
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        const out = {}
        // --probe OM_PROBE_ALIGN=1：量推荐页各封面实际高度，定位没对齐的容器
        if (PROBE && process.env.OM_PROBE_ALIGN) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 40 && !document.querySelector('.orange-home'); i++) await w(500)
              await w(8000)
              const measure = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map((n) => {
                const r = n.getBoundingClientRect(), cs = getComputedStyle(n)
                return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top),
                  ar: cs.aspectRatio, radius: cs.borderRadius, img: !!n.querySelector('img') }
              })
              return {
                cards: measure('.orange-cards .orange-card'),
                songCovers: measure('.orange-song-cover'),
                plCovers: measure('.orange-pl-cover-big'),
                clip: getComputedStyle(document.querySelector('.orange-card-imgbg') || document.body).clipPath,
              }
            })()`)
            logLine('[probe-align] ' + JSON.stringify(info))
            await shot('_probe_align.png')
          } catch (e) { logLine('[probe-align] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_VERIFY=1：诊断身份反查是否传到播放层（误杀排查）
        if (PROBE && process.env.OM_PROBE_VERIFY) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 60 && !(window.__omDebug && window.__omDebug.core); i++) await w(500)
              const d = window.__omDebug
              const ID = d.core.identity
              const out = { rows: [] }
              const list = await d.core.sources.searchAll('周杰伦').catch(() => [])
              const picks = list.filter((t) => /骑士精神|晴天|枫/.test(t.title)).slice(0, 4)
              for (const t of picks) {
                const real = await d.core.identity.lookupIdentity(t.pending, 3000).catch(() => null)
                const r = await d.core.sources.resolvePending(t, 0, true).catch(() => null)
                const O = d.core.official
                const replay = await (async () => { const mi = t.pending; const metas = [mi, ...((mi && mi.alts || []).slice(0, 2))]; const reals = await Promise.all(metas.map((m) => ID.lookupIdentity(m, 2500).catch(() => null))); return { n: metas.length, reals, some: reals.some((rl) => ID.identityMatches(t, rl).ok && !!rl && !!rl.name) } })()
                out.rows.push({ title: t.title, artist: t.artist, metaMs: t.durationMs, replay,
                  src: t.pending && t.pending.source, id: t.pending && t.pending.id,
                  real,
                  idMatch: ID.identityMatches(t, real),
                  rKeys: r ? Object.keys(r) : [],
                  metasCheck: t.pending ? (t.pending.alts || []).slice(0,2).map((m) => m.source + '|' + m.id) : [],
                  directMatch: (() => { try { return O.artistMatches(t.artist, real && real.singer) } catch (e) { return e.message } })(),
                  canonA: O.canonicalTitle(t.title), canonB: real && O.canonicalTitle(real.name),
                  gotStreams: !!(r && r.streams && r.streams.length) })
              }
              return out
            })()`)
            logLine('[probe-verify] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-verify] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_LOOK=1：登录页重做 + 封面去角标 截图验收
        if (PROBE && process.env.OM_PROBE_LOOK) {
          try {
            await wait(3500)
            const boot = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 60 && !(window.__omDebug && window.__omDebug.core && window.__omDebug.core.coverClean); i++) await w(500)
              for (let i = 0; i < 40 && !document.querySelector('.orange-home'); i++) await w(500)
              return { core: !!(window.__omDebug && window.__omDebug.core), toast: document.querySelector('#toast')?.textContent || '' }
            })()`)
            logLine('[probe-look] boot ' + JSON.stringify(boot))
            // 等封面清洗队列跑完（主进程取图 + Canvas）
            await wait(6500)
            const cc = await run(`(async () => {
              const d = window.__omDebug
              const info = d.core.coverClean.coverCleanInfo()
              const cleanedImgs = document.querySelectorAll('img[data-cc-status="1"]').length
              const total = document.querySelectorAll('.orange-card-imgbg img,.orange-pl-cover-big img,.orange-song-cover img').length
              return { info, cleanedImgs, total }
            })()`)
            logLine('[probe-look] coverclean ' + JSON.stringify(cc))
            await run(`(async () => { const l = document.querySelector('#loginSheet'); if (l) l.hidden = false; return 1 })()`)
            await wait(700)
            await shot('_probe_login_new.png')
            await run(`(async () => { const l = document.querySelector('#loginSheet'); if (l) l.hidden = true; return 1 })()`)
            await wait(500)
            await shot('_probe_cover_clean.png')
            const info = await run(`(async () => {
              const root = document.documentElement
              const sels = ['.orange-card-imgbg', '.orange-card-side-img', '.orange-pl-cover-big', '.orange-song-cover', '.cover:not(.round):not(.tiny)', '.cc-cover', '.card .cover']
              const rows = sels.map((sel) => {
                const el = document.querySelector(sel)
                if (!el) return [sel, 'NONE']
                const img = el.tagName === 'IMG' ? el : el.querySelector('img')
                const cs = getComputedStyle(el), is = img ? getComputedStyle(img) : null
                return [sel, 'n=' + document.querySelectorAll(sel).length, 'overflow=' + cs.overflow,
                  'clip=' + (cs.clipPath || '').slice(0, 20), 'imgT=' + (is ? is.transform : 'no-img'), 'zoomVar=' + cs.getPropertyValue('--cover-zoom')]
              })
              return { striplogo: root.dataset.striplogo, rows }
            })()`)
            logLine('[probe-look] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-look] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_IDENTITY=1：验收「按 ID 反查真实身份」能否拦住错歌/片段
        if (PROBE && process.env.OM_PROBE_IDENTITY) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              let coreReady = false
              for (let i = 0; i < 90; i++) { if (d && d.core && d.core.identity) { coreReady = true; break } await w(500) }
              const out = { lookups: [], verdicts: [], cache: null, coreReady, coreKeys: d && d.core ? Object.keys(d.core) : [], localOnly: null }
              if (!coreReady) {
                out.toast = document.querySelector('#toast')?.textContent || ''
                out.bodyErr = document.querySelector('#view')?.textContent?.slice(0, 200) || ''
                return out
              }
              const ID = d.core.identity
              const O = d.core.official
              // 1) 反查各平台 ID 的真实身份
              const ids = [
                { source: 'wy', id: '536624791', want: '玻璃糖' },       // 网易云 玻璃糖 原版
                { source: 'tx', id: '004b2hd01Ddhpl', want: '哼' },      // QQ 哼 原版
                { source: 'tx', id: '001FRviZ2iCAui', want: '哼' },      // QQ 哼 52秒片段（同 mid）
                { source: 'kw', id: '277647907', want: '哼' },           // 酷我 搜「哼冯提莫」补位=半壶纱（无详情接口）
              ]
              for (const it of ids) {
                const real = await ID.lookupIdentity(it, 3000).catch(() => null)
                out.lookups.push({ want: it.want, src: it.source, id: it.id, real })
              }
              // 2) 身份核对判定：原版放行 / 片段拒绝 / 错歌拒绝
              out.verdicts.push(['原版 vs 自身', O.officialVerdict({ name: '玻璃糖', durationMs: 225646 }).ok])
              out.verdicts.push(['52秒片段', O.officialVerdict({ name: '哼 (52秒片段)', durationMs: 52000 }).ok])
              out.verdicts.push(['消音伴奏', O.officialVerdict({ name: '哼 (消音伴奏)', durationMs: 220000 }).ok])
              out.verdicts.push(['电音Remix', O.officialVerdict({ name: '哼 (DJ电音版)', durationMs: 220000 }).ok])
              // 3) 缓存指纹：给 key 存 A 的链，用 B 的指纹读应得 null
              const SC = d.core.sources
              try {
                SC.applyCachedStreams('测试|同一首', [{ url: 'https://music.126.net/a.mp3', quality: 'hq' }], 'wy', { source: 'wy', id: 'AAA' })
                out.cache = {
                  sameID: (SC.peekCache('测试|同一首', 'wy|AAA') || []).length,
                  diffID: (SC.peekCache('测试|同一首', 'wy|BBB') || []).length,
                  noID: (SC.peekCache('测试|同一首') || []).length,
                }
              } catch (e) { out.cache = { err: e.message } }
              return out
            })()`)
            logLine('[probe-identity] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-identity] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_OFFICIAL=1：验收「只听正式发行版」（版本过滤 / 同名串歌拦截）
        if (PROBE && process.env.OM_PROBE_OFFICIAL) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              const O = d.core.official
              const out = { enabled: O.isOfficialOnly(), verdict: [], rows: [], bad: [] }
              const cases = [
                { name: '玻璃糖', singer: '徐梦圆 / 冯提莫', album: '徐梦圆 同名专辑', durationMs: 225646 },
                { name: '玻璃糖 (Instrumental)', singer: '徐梦圆 / 冯提莫', album: '徐梦圆 纯音乐版', durationMs: 225362 },
                { name: '玻璃糖 (Peter Li Remix)', singer: '徐梦圆 / Peter Li', album: '', durationMs: 257000 },
                { name: '《玻璃糖-徐梦圆/冯提莫》3DO音效耳机版', singer: '自由者音效', album: '', durationMs: 225000 },
                { name: '玻璃糖 (cover: 徐梦圆|冯提莫)', singer: '幽谷', album: '', durationMs: 225000 },
                { name: '某某歌 (Live)', singer: '某歌手', album: '', durationMs: 240000 },
                { name: '某某歌', singer: '某歌手', album: '', durationMs: 30000 },
              ]
              out.verdict = cases.map((c) => [c.name, O.officialVerdict(c).ok, O.officialVerdict(c).why])
              const res = await d.core.sources.searchAll('玻璃糖').catch(() => [])
              out.rows = res.slice(0, 30).map((t) => [t.title, t.artist, t.durationMs])
              out.bad = res.filter((t) => !O.officialVerdict(t).ok).map((t) => t.title)
              const raw = await d.core.sources.searchOpen('玻璃糖', 12).catch(() => [])
              out.raw = raw.slice(0, 26).map((r) => [r.name, r.singer, r.albumName, O.relevantTo(r, '玻璃糖')])
              const ads = await d.core.sources.enabledAdapters().catch(() => [])
              out.adapters = []
              for (const a of ads) {
                const rows = await Promise.race([a.search('玻璃糖').catch(() => []), w(7000).then(() => [])])
                out.adapters.push([a.id, (rows || []).length, (rows || []).slice(0, 4).map((t) => t.title || t.name)])
              }
              out.diag = []
              for (const name of ['晴天', '枫']) {
                const list = await d.core.sources.searchAll(name + ' 周杰伦').catch(() => [])
                const t = list.find((x) => /周杰伦/.test(x.artist || '') && x.pending)
                if (!t) { out.diag.push([name, 'no track', list.length]); continue }
                const r = await d.core.sources.resolvePending(t, 0, true).catch(() => null)
                const r2 = !r ? await d.core.sources.resolveRetry(t, []).catch(() => null) : null
                out.diag.push([name, t.pending.source, t.pending.id, (t.pending.alts || []).length, !!r, !!r2, (r && r.streams && r.streams[0] && r.streams[0].url || '').slice(0, 60)])
              }
              out.sameOk = O.sameTrack({ title: '玻璃糖', artist: '徐梦圆 / 冯提莫' }, { name: '玻璃糖', singer: '冯提莫' })
              out.sameBad = O.sameTrack({ title: '玻璃糖', artist: '徐梦圆 / 冯提莫' }, { name: '玻璃糖', singer: '程又青' })
              return out
            })()`)
            logLine('[probe-official] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-official] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_BATCH=1：批量模式下勾选框样式（统一圆形）
        if (PROBE && process.env.OM_PROBE_BATCH) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const item = [...document.querySelectorAll('.orange-side-item[data-lib]')].find((b) => /最近播放/.test(b.textContent))
              item && item.click()
              for (let i = 0; i < 40 && !document.querySelector('[data-batch="toggle"]'); i++) await w(400)
              await w(700)
              const t = document.querySelector('[data-batch="toggle"]')
              t && t.click()
              await w(700)
              const picks = [...document.querySelectorAll('[data-pick]')]
              picks[0] && picks[0].click()
              picks[2] && picks[2].click()
              await w(400)
              return { rows: document.querySelectorAll('[data-pick]').length, checked: document.querySelectorAll('[data-pick]:checked').length, head: !!document.querySelector('[data-pickall]') }
            })()`)
            logLine('[probe-batch] ' + JSON.stringify(info))
            await wait(400)
            await shot('_probe_batch.png')
          } catch (e) { logLine('[probe-batch] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_UI2=1：截图验收（首页问候语 / 个人主页 / 登录面板 / 头像面板）
        if (PROBE && process.env.OM_PROBE_UI2) {
          try {
            await wait(4000)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 40 && !document.querySelector('.orange-home'); i++) await w(500)
              await w(1200)
              const d = window.__omDebug
              const S = d.state
              const out = { greet: document.querySelector('.orange-card-gradtext h3')?.textContent || '', greetLine: document.querySelector('.orange-card-gradtext p')?.textContent || '' }
              for (let i = 0; i < 30 && !(S.recommend && S.recommend.tracks && S.recommend.tracks.length); i++) await w(500)
              out.band = (S.recommend && S.recommend.band) || ''
              out.bandTip = (S.recommend && S.recommend.bandTip) || ''
              out.recN = (S.recommend && S.recommend.tracks && S.recommend.tracks.length) || 0
              out.featTitle = (S.recommend && S.recommend.tracks && S.recommend.tracks[0] && S.recommend.tracks[0].title) || ''
              // 伪造登录态，验证个人主页与头像
              S.session = { user: { id: 'demo', name: '12.', email: 'demo@orangemusic.app' } }
              S.profile = { avatar: '' }
              S.favorites = S.favorites && S.favorites.length ? S.favorites : []
              S.playlists = S.playlists || []
              S.libTab = '个人主页'
              S.page = null
              d.core.cloud.setLocalOnly(true)
              try { window.dispatchEvent(new Event('om:noop')) } catch (e) {}
              const user = document.querySelector('.orange-user')
              user && user.click()
              await w(1200)
              out.profHtml = !!document.querySelector('.prof-page')
              out.libTab = S.libTab
              out.sec = S.section
              return out
            })()`)
            logLine('[probe-ui2] ' + JSON.stringify(info))
            await wait(700)
            await shot('_probe_profile.png')
            await run(`(async () => { document.querySelector('[data-avatar]')?.click(); return 1 })()`)
            await wait(900)
            await shot('_probe_avatar.png')
            await run(`(async () => { document.querySelector('#closeAvatarBtn')?.click(); document.querySelector('#loginSheet').hidden = false; return 1 })()`)
            await wait(700)
            await shot('_probe_login.png')
          } catch (e) { logLine('[probe-ui2] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_LOGIN=1：验证登录通道（OAuth relay / 邮箱验证码）是否被云端接受
        if (PROBE && process.env.OM_PROBE_LOGIN) {
          try {
            await wait(4000)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              const au = d && d.core && d.core.cloud && d.core.cloud.cloud && d.core.cloud.cloud.auth
              const out = { oauth: null, oauthErr: '', otp: null, otpErr: '' }
              if (!au) return { err: 'no auth' }
              out.verifySrc = String(au.verifyOtp).replace(/\s+/g, ' ').slice(0, 420)
              try {
                const r = await au.startRelayOAuth({ provider: 'wechat' }, 'http://127.0.0.1:17321/oauth')
                out.oauth = r && r.data ? r.data.url : null
                if (r && r.error) out.oauthErr = String(r.error.message || r.error)
              } catch (e) { out.oauthErr = e.message }
              try {
                const r = await au.sendOtp({ email: 'omtest' + Date.now() + '@example.com' })
                out.otp = r && r.data ? JSON.parse(JSON.stringify(r.data)) : null
                if (r && r.error) out.otpErr = String(r.error.message || r.error)
              } catch (e) { out.otpErr = e.message }
              return out
            })()`)
            logLine('[probe-login] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-login] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_AUTH=1：体检云 SDK / 登录态 / 云端可达性
        if (PROBE && process.env.OM_PROBE_AUTH) {
          try {
            await wait(4000)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              const core = d && d.core
              const out = { sdk: !!window.WorkBuddyCloud, cloud: !!(core && core.cloud && core.cloud.cloud), localOnly: null, methods: [], session: null, err: '', probes: {} }
              try { out.localOnly = core.cloud.isLocalOnly() } catch (e) {}
              const target = core && core.cloud && core.cloud.cloud
              if (target) {
                out.methods = Object.keys(target.auth || {})
                try {
                  const r = await target.auth.getSession()
                  out.session = r && r.data ? { id: r.data.user && r.data.user.id, name: r.data.user && r.data.user.name, phone: r.data.user && r.data.user.phone } : null
                  out.sessionErr = r && r.error ? String(r.error.message || r.error) : ''
                } catch (e) { out.err = e.message }
              }
              for (const u of ['https://quiet-music.app.workbuddy.host/', 'https://www.workbuddy.cn/v2/as/genie-baas/oauth']) {
                try {
                  const r = await fetch(u, { method: 'GET', mode: 'no-cors' })
                  out.probes[u] = 'ok:' + r.type
                } catch (e) { out.probes[u] = 'ERR ' + e.message }
              }
              try {
                const g = window.WorkBuddyCloud || {}
                out.sdkKeys = Object.keys(g)
                out.cfg = target && target.config ? JSON.parse(JSON.stringify(target.config, (k, v) => (typeof v === 'function' ? '[fn]' : v))) : null
                const au = target && target.auth
                const dump = (o) => {
                  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(typeof o)
                  const keys = Object.keys(o)
                  const map = {}
                  for (const k of keys) {
                    const v = o[k]
                    map[k] = typeof v === 'function' ? 'fn/' + v.length : (typeof v === 'object' ? 'obj' : typeof v)
                  }
                  return map
                }
                out.pkce = au ? dump(au.workBuddyPkce) : null
                out.sessionsStore = au && au.sessions ? dump(au.sessions.store) : null
                out.mp = au ? dump(au.workBuddyMiniProgram) : null
                out.storageKeys = target && target.storage ? Object.keys(target.storage) : []
                out.llmKeys = target && target.llm ? Object.keys(target.llm) : []
                out.authKeys = au ? Object.keys(au) : []
                const proto = (x) => { try { return Object.getOwnPropertyNames(Object.getPrototypeOf(x)).filter((k) => k !== 'constructor') } catch (e) { return ['ERR'] } }
                out.authProto = au ? proto(au) : []
                out.clientProto = proto(target || {})
                out.dbProto = target && target.database ? proto(target.database) : []
                out.storageProto = target && target.storage ? proto(target.storage) : []
                out.sessionStoreProto = au && au.sessions && au.sessions.store ? proto(au.sessions.store) : []
                const src = (n) => { try { return String(au[n]).replace(/\s+/g, ' ').slice(0, 260) } catch (e) { return 'ERR' } }
                out.src = { verifyOtp: src('verifyOtp'), parseCallbackQuery: src('parseCallbackQuery'), signInWithOtp: src('signInWithOtp') }
                out.sessionsType = au && au.sessions ? typeof au.sessions : 'none'
                out.sessionsKeys = au && au.sessions && typeof au.sessions === 'object' ? Object.keys(au.sessions) : []
                out.exchangesType = au && au.workBuddyExchanges ? (au.workBuddyExchanges.constructor && au.workBuddyExchanges.constructor.name) : 'none'
                out.oauthRelay = au ? String(au.oauthRelayBaseUrl || '') : ''
                out.baseUrl = au ? String(au.baseUrl || '') : ''
                out.topKeys = target ? Object.keys(target) : []
                out.dbKeys = target && target.database ? Object.keys(target.database).slice(0, 20) : []
                out.dbType = target && target.database ? typeof target.database : 'none'
              } catch (e) { out.shapeErr = e.message }
              if (target && target.database) {
                try {
                  const r = await target.database.from('user_state').select('key').limit(1)
                  out.probes.db = r.error ? 'ERR ' + (r.error.message || JSON.stringify(r.error)) : 'ok:' + (r.data || []).length
                } catch (e) { out.probes.db = 'ERR ' + e.message }
              }
              return out
            })()`)
            logLine('[probe-auth] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-auth] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_EFF=1：按平台体检取链 + 出声效率（自建歌单里的曲目就是这几种形态）
        if (PROBE && process.env.OM_PROBE_EFF) {
          try {
            await wait(3000)
            const per = Math.max(1, Math.min(Number(process.env.OM_PROBE_N) || 4, 10))
            const words = (process.env.OM_PROBE_WORDS || '周杰伦,告五人,林俊杰').split(',').map((x) => x.trim()).filter(Boolean)
            const wordsJson = JSON.stringify(words)
            const res = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              if (!d) return { err: 'no debug' }
              try { d.core.sources.clearStreamCache && d.core.sources.clearStreamCache() } catch (e) {}
              const words = ${wordsJson}
              const bySrc = {}
              for (const wd of words) {
                const list = await d.core.sources.searchAll(wd).catch(() => [])
                for (const t of list) {
                  const s = t && t.pending && t.pending.source
                  if (!s || !t.title) continue
                  ;(bySrc[s] || (bySrc[s] = [])).push(t)
                }
              }
              const out = { avail: Object.keys(bySrc).map((k) => k + ':' + bySrc[k].length), per: ${per}, rows: [], summary: {} }
              for (const s of Object.keys(bySrc)) {
                const arr = bySrc[s].slice(0, ${per})
                let ok = 0, sumR = 0, sumP = 0
                for (const t of arr) {
                  const t0 = Date.now()
                  let r = null, err = ''
                  try { r = await d.core.sources.resolvePending(t, 0, true) } catch (e) { err = e.message }
                  const resolveMs = Date.now() - t0
                  let played = false, playMs = 0, q = ''
                  if (r && r.streams && r.streams.length) {
                    const t1 = Date.now()
                    try {
                      const hit = await d.core.quality.playWithFallback(r, 0, 'auto')
                      played = true; q = (hit && hit.quality) || ''
                    } catch (e) { err = (err ? err + ' | ' : '') + e.message }
                    playMs = Date.now() - t1
                  }
                  const a = document.getElementById('previewAudio')
                  const host = String((a && a.src) || '').replace(/^https?:\\/\\//, '').split('/')[0]
                  try { a && a.pause() } catch (e) {}
                  if (played) { ok += 1; sumR += resolveMs; sumP += playMs }
                  out.rows.push({ src: s, title: String(t.title).slice(0, 12), resolveMs, playMs, ok: played, q, host, err: String(err).slice(0, 40) })
                }
                out.summary[s] = { n: arr.length, ok, avgResolve: ok ? Math.round(sumR / ok) : 0, avgPlay: ok ? Math.round(sumP / ok) : 0 }
              }
              return out
            })()`)
            logLine('[probe-eff] ' + JSON.stringify(res))
          } catch (e) { logLine('[probe-eff] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_WRONG=1：端到端验收用户点名的两首歌（哼/玻璃糖 - 冯提莫）
        if (PROBE && process.env.OM_PROBE_WRONG) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 60 && !(window.__omDebug && window.__omDebug.core); i++) await w(500)
              const d = window.__omDebug, S = d.core.sources, ID = d.core.identity
              const out = { songs: [] }
              for (const item of [{ q: '哼 冯提莫', name: '哼' }, { q: '玻璃糖 冯提莫', name: '玻璃糖' }]) {
                const hits = await S.searchAll(item.q).catch(() => [])
                // 歌名严格等于目标 + 歌手含冯提莫，优先网易云（有 outer 直链）
                const cands = hits.filter((t) => t.title === item.name && /冯提莫/.test(t.artist))
                const want = cands.find((t) => t.pending && t.pending.source === 'wy') || cands[0]
                if (!want) { out.songs.push({ q: item.q, err: 'no official hit', got: hits.slice(0,4).map((t)=>t.title+'/'+t.artist) }); continue }
                const real = await ID.lookupIdentity(want.pending, 3000).catch(() => null)
                const r = await S.resolvePending(want, 0, true).catch(() => null)
                const idc = ID.identityMatches(want, real)
                out.songs.push({ q: item.q, picked: want.title + '/' + want.artist,
                  pendingId: want.pending && (want.pending.source + '|' + want.pending.id),
                  realName: real && real.name, realSinger: real && real.singer, realMs: real && real.durationMs,
                  identityOk: idc.ok, identityWhy: idc.why,
                  gotStreams: !!(r && r.streams && r.streams.length) })
              }
              return out
            })()`)
            logLine('[probe-wrong] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-wrong] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_SWITCH=1：精确测「点下一首 → 真正出声」耗时（缓存热，用户实际场景）
        if (PROBE && process.env.OM_PROBE_SWITCH) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 60 && !document.querySelector('[data-pl]'); i++) await w(500)
              document.querySelector('[data-pl]')?.click()
              for (let i = 0; i < 90 && document.querySelectorAll('[data-key]').length < 6; i++) await w(500)
              await w(1500)
              const out = { first: 0, next: [], cacheHits: 0 }
              const a = document.getElementById('previewAudio')
              // 先点第一首，轮询到真正出声
              const pick = async (i) => {
                const row = document.querySelectorAll('[data-key]')[i]
                if (!row) return null
                const t0 = Date.now()
                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                let played = 0
                for (let k = 0; k < 60; k++) { await w(100); if (a && a.currentTime > 0.3 && !a.paused) { played = Date.now() - t0; break } }
                try { a && a.pause() } catch (e) {}
                return played
              }
              out.first = await pick(0) || 0
              await w(300)
              for (let i = 1; i <= 5; i++) { const ms = await pick(i); if (ms != null) out.next.push(ms); await w(200) }
              return out
            })()`)
            logLine('[probe-switch] ' + JSON.stringify(info))
          } catch (e) { logLine('[probe-switch] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_GPL=1：模拟「歌单里连点若干首」——最贴近自建歌单的实际使用场景
        if (PROBE && process.env.OM_PROBE_GPL) {
          try {
            await wait(3000)
            const res = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              if (!d) return { err: 'no debug' }
              for (let i = 0; i < 60 && !document.querySelector('[data-pl]'); i++) await w(500)
              document.querySelector('[data-pl]')?.click()
              for (let i = 0; i < 90 && document.querySelectorAll('[data-key]').length < 3; i++) await w(500)
              await w(600)
              const rows = [...document.querySelectorAll('[data-key]')]
              const out = { rows: rows.length, n: 0, ok: 0, list: [] }
              const N = Math.min(Number('${process.env.OM_PROBE_N || 8}') || 8, rows.length)
              for (let i = 0; i < N; i++) {
                const t0 = Date.now()
                const row = document.querySelectorAll('[data-key]')[i]   // 每轮重查：render 会替换 DOM
                if (!row) break
                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                await w(5200)
                const a = document.getElementById('previewAudio')
                const bar = document.getElementById('barTitle')?.textContent || ''
                const good = !!(a && a.currentTime > 0.3 && !a.paused)
                if (good) out.ok += 1
                out.n += 1
                out.list.push({ i, bar: String(bar).slice(0, 12), ok: good, t: +(a ? a.currentTime : 0).toFixed(1), ms: Date.now() - t0 })
                try { a && a.pause() } catch (e) {}
              }
              return out
            })()`)
            logLine('[probe-gpl] ' + JSON.stringify(res))
          } catch (e) { logLine('[probe-gpl] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_MINI=1：验证播放页右上角「切换到精简模式」是否真的生效
        if (PROBE && process.env.OM_PROBE_MINI) {
          try {
            await wait(3500)
            const info = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              for (let i = 0; i < 40 && !document.querySelector('#barCover'); i++) await w(500)
              document.querySelector('#barCover')?.click()
              await w(1500)
              const out = { btns: [], npShown: false, before: '', after: '', dataMini: '', cls: '' }
              const box = document.querySelector('#npWinBtns')
              out.npShown = !document.querySelector('#nowPlaying')?.hidden
              out.btns = [...document.querySelectorAll('#npWinBtns [data-win]')].map((b) => b.dataset.win)
              out.before = document.querySelector('#window')?.className || ''
              const btn = document.querySelector('#npWinBtns [data-win="mini"]')
              btn && btn.click()
              await w(1600)
              out.cls = document.querySelector('#window')?.className || ''
              out.dataMini = String(document.documentElement.dataset.mini || '')
              out.npHidden = !!document.querySelector('#nowPlaying')?.hidden
              return out
            })()`)
            logLine('[probe-mini] ' + JSON.stringify(info))
            await wait(600)
            await shot('_probe_mini.png')
          } catch (e) { logLine('[probe-mini] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_LIST=1：体检乐馆歌单曲目（=自建歌单里常见的曲目形态）能不能取到链
        if (PROBE && process.env.OM_PROBE_LIST) {
          try {
            await wait(3000)
            const res = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              if (!d) return { err: 'no debug' }
              const S = d.state
              for (let i = 0; i < 60 && !document.querySelector('[data-section="hall"]'); i++) await w(500)
              document.querySelector('[data-section="home"]')?.click()
              for (let i = 0; i < 60 && !document.querySelector('[data-pl]'); i++) await w(500)
              const card = document.querySelector('[data-pl]')
              if (!card) return { err: 'no card', html: document.body.innerHTML.length }
              card.click()
              for (let i = 0; i < 60 && !(S.page && S.page.tracks && S.page.tracks.length); i++) await w(500)
              const list = (S.page && S.page.tracks) || []
              const out = { pl: (S.page && S.page.source && S.page.source.id) || '', n: list.length, stats: {}, samples: [] }
              for (const t of list.slice(0, 60)) {
                const p = t.pending || {}
                const k = (p.source || 'none') + ':' + (p.id ? 'id' : 'NOID')
                out.stats[k] = (out.stats[k] || 0) + 1
              }
              for (const t of list.slice(0, 6)) {
                const t0 = Date.now()
                let hit = null, err = ''
                try {
                  hit = await Promise.race([d.core.sources.resolvePending(t), w(20000).then(() => null)])
                } catch (e) { err = e.message }
                const st = hit && hit.streams && hit.streams[0]
                out.samples.push({ title: String(t.title || '').slice(0, 14), artist: String(t.artist || '').slice(0, 10), src: t.pending && t.pending.source, pid: String((t.pending && t.pending.id) || '').slice(0, 22), ok: !!st, q: (st && st.quality) || '', host: String((st && st.url) || '').replace(/^https?:\\/\\//, '').split('/')[0].slice(0, 24), ms: Date.now() - t0, err })
              }
              return out
            })()`)
            logLine('[probe-list] ' + JSON.stringify(res))
          } catch (e) { logLine('[probe-list] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe OM_PROBE_PL=1：只体检「自建歌单」里的歌能不能取到链（诊断大量放不了）
        if (PROBE && process.env.OM_PROBE_PL) {
          try {
            await wait(3000)
            const res = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              for (let i = 0; i < 60 && !window.__omDebug; i++) await w(500)
              const d = window.__omDebug
              if (!d) return { err: 'no debug' }
              const S = d.state
              for (let i = 0; i < 100 && !(S.playlists || []).length; i++) await w(500)
              const diag = { cloud: !!S.cloud, session: !!(S.session && S.session.user), lsKeys: Object.keys(localStorage).length, ls: [] }
              try { diag.ls = Object.keys(localStorage).filter((k) => k.indexOf('orangemusic') === 0).slice(0, 40) } catch (e) {}
              const pls = S.playlists || []
              const pl = pls.find((p) => !p.fav) || pls[0]
              const out = { diag, pls: pls.length, name: pl && pl.name, n: (pl && pl.tracks && pl.tracks.length) || 0, stats: {}, samples: [] }
              const all = (pl && pl.tracks) || []
              for (const t of all.slice(0, 80)) {
                const p = t.pending
                const k = (p && p.source ? p.source : 'none') + ':' + (p && p.id ? 'id' : 'noid') + (t.streams && t.streams.length ? ':streams' : '')
                out.stats[k] = (out.stats[k] || 0) + 1
              }
              for (const t of all.slice(0, 6)) {
                const t0 = Date.now()
                let hit = null, err = ''
                try { hit = await d.core.sources.resolvePending(t) } catch (e) { err = e.message }
                const st = hit && hit.streams && hit.streams[0]
                out.samples.push({ title: t.title, artist: t.artist, src: t.pending && t.pending.source, pid: String((t.pending && t.pending.id) || '').slice(0, 24), ok: !!(hit && hit.streams && hit.streams.length), q: (st && st.quality) || '', url: String((st && st.url) || '').slice(0, 52), ms: Date.now() - t0, err })
              }
              return out
            })()`)
            logLine('[probe-pl] ' + JSON.stringify(res))
          } catch (e) { logLine('[probe-pl] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // --probe：只做音源实测（约 40 秒），用来验收「点下去到底有没有出声」
        if (PROBE) {
          try {
            await wait(2500)
            const res = await run(`(async () => {
              const w = (ms) => new Promise((r) => setTimeout(r, ms))
              const diag0 = { debug: !!window.__omDebug, navs: document.querySelectorAll('[data-section]').length, bodyLen: document.body.innerHTML.length }
              if (!window.__omDebug) return { diag0 }
              for (let i = 0; i < 40 && !document.querySelector('[data-section="rise"]'); i++) await w(500)
              document.querySelector('[data-section="rise"]')?.click()
              for (let i = 0; i < 22 && !document.querySelectorAll('.orange-cp-name').length; i++) await w(700)
              const d = window.__omDebug
              const core = d && d.core
              const st = (d && d.state) || {}
              let tracks = (st.page && st.page.tracks) || []
              if (!tracks.length && st.chartTracks && st.chartTracks.values) {
                for (const v of st.chartTracks.values()) { if (v && v.length) { tracks = v; break } }
              }
              if (!tracks.length) tracks = st.searchResults || []
              const out = { section: st.section || '', tracks: tracks.length, probe: [] }
              out.probe = []
              const rows = [...document.querySelectorAll('.orange-cp-name')].slice(0, 4)
              for (const b of rows) {
                b.click(); await w(5000)
                const a = document.getElementById('previewAudio')
                out.probe.push({
                  song: b.textContent.slice(0, 12),
                  bar: (document.getElementById('barTitle')?.textContent || '').slice(0, 12),
                  ok: !!(a && a.currentTime > 0.3 && !a.paused),
                  src: a ? String(a.src).slice(0, 56) : '',
                })
                try { a && a.pause() } catch (e) {}
              }
              return out
            })()`)
            logLine('[probe] ' + JSON.stringify(res))
          } catch (e) { logLine('[probe] 失败：' + e.message) }
          app.exit(0)
          return
        }
        // 调试快通道：OM_SELFTEST_ONLY 只跑指定一段，改一处 UI 时不用等整套自检（约 3.5 分钟）
        if (process.env.OM_SELFTEST_ONLY) {
          const quick = await run(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms))
            const qa = (s) => [...document.querySelectorAll(s)]
            const info = {}
            for (let i = 0; i < 40 && !document.querySelector('.orange-home'); i++) await wait(500)
            await wait(1500)
            // 巅峰榜
            document.querySelector('[data-section="peak"]')?.click()
            await wait(800)
            info.peakNav = document.querySelector('.orange-nav[aria-current="page"]')?.dataset.section || ''
            info.peakTitle = document.querySelector('.orange-cp-meta h1')?.textContent || ''
            info.peakCover = (document.querySelector('.orange-cp-cover')?.innerHTML || '').includes('path')
            // 飙升榜
            document.querySelector('[data-section="rise"]')?.click()
            await wait(800)
            info.riseNav = document.querySelector('.orange-nav[aria-current="page"]')?.dataset.section || ''
            info.riseTitle = document.querySelector('.orange-cp-meta h1')?.textContent || ''
            info.riseCover = (document.querySelector('.orange-cp-cover')?.innerHTML || '').includes('path')
            // 乐馆 → 歌手（验证头像放大）
            document.querySelector('[data-section="hall"]')?.click()
            await wait(500)
            const artistTab = qa('[data-hall="歌手"]')[0]
            artistTab?.click()
            await wait(2500)
            const ava = document.querySelector('.orange-art-ava')
            info.artistTab = !!artistTab
            info.avaSize = ava ? (ava.getBoundingClientRect().width + 'x' + ava.getBoundingClientRect().height) : 'none'
            info.hotArtists = qa('.orange-art-hot').length
            return info
          })()`)
          logLine('[self-test][only] ' + JSON.stringify(quick))
          // 三张截图：巅峰 / 飙升 / 乐馆歌手
          await run(`document.querySelector('[data-section="peak"]')?.click()`)
          await wait(700); await shot('_shot_only_peak.png')
          await run(`document.querySelector('[data-section="rise"]')?.click()`)
          await wait(700); await shot('_shot_only_rise.png')
          await run(`document.querySelector('[data-section="hall"]')?.click(); document.querySelectorAll('[data-hall="歌手"]')[0]?.click()`)
          await wait(2500); await shot('_shot_only_artist.png')
          app.quit()
          return
        }
        // ① 首页：封面卡 + 实时推荐 + 推荐歌单 / 歌手
        out.home = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          // 等核心与榜单曲目就绪（首屏渲染完成后再点，避免点到空目录）
          // Windows QQ 风格主页用 .orange-home/.orange-card/.orange-song；旧版/iOS 用 .cc
          for (let i = 0; i < 60 && !document.querySelector('.cc, .orange-home, .orange-card, .orange-song'); i++) await wait(500)
          await wait(1500)
          const qa = (s) => [...document.querySelectorAll(s)]
          // 滚到当前页底部后继续滑：滚轮必须被拦住，主菜单高亮与板块都不能变
          const v = document.querySelector('#view')
          const navBefore = document.querySelector('.nav-item[aria-current="page"], .orange-nav[aria-current="page"]')?.dataset.section || ''
          const headBefore = document.querySelector('.section-head h1, .orange-banner-head h2')?.textContent || ''
          v.scrollTop = v.scrollHeight
          await wait(250)
          const ev = new WheelEvent('wheel', { deltaY: 320, bubbles: true, cancelable: true })
          v.dispatchEvent(ev)
          await wait(150)
          const navAfter = document.querySelector('.nav-item[aria-current="page"], .orange-nav[aria-current="page"]')?.dataset.section || ''
          const headAfter = document.querySelector('.section-head h1, .orange-banner-head h2')?.textContent || ''
          return {
            scheme: location.protocol, host: !!window.orangeWindow,
            banner: !!document.querySelector('.banner, .orange-banner-head'),
            chartCards: qa('.cc').length + qa('.orange-card').length,
            chartCoverImgs: qa('.cc-cover img').length + qa('.orange-card img').length,
            strip: qa('.rec-strip .strip-item').length + qa('.orange-song').length,
            playlists: qa('[data-pl]').length,
            artists: qa('[data-artist]').length,
            artistRows: new Set(qa('.artist-row [data-artist]').map((b) => b.getBoundingClientRect().top)).size,
            fallbacksLeft: qa('#view [data-ck]').length,
            scrollLocked: !!ev.defaultPrevented,
            navStable: navBefore === navAfter && headBefore === headAfter,
          }
        })()`)
        await shot('_shot1_home.png')
        // 首页下半屏：今日榜单 / 推荐歌单 / 热门歌手（一行 8 个）
        await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('.artist-row')?.scrollIntoView({ block: 'center' })
          await wait(900)
          return true
        })()`)
        await shot('_shot1b_home_bottom.png')

        // ② 全部榜单页
        out.allCharts = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          // iOS 旧版首页用 #goChartsBtn；Windows QQ 风格点侧栏「榜单」
          if (document.querySelector('#goChartsBtn')) document.querySelector('#goChartsBtn').click()
          else document.querySelector('.orange-nav[data-section="charts"]')?.click()
          await wait(3000)
          const qa = (s) => [...document.querySelectorAll(s)]
          const v = document.querySelector('#view')
          v.scrollTop = 0
          // 不轮播：静置多处采样，封面必须始终固定在该榜第一首。
          const seen = new Set()
          for (let i = 0; i < 10; i++) {
            const s = document.querySelector('.cc-cover img')?.getAttribute('src') || ''
            if (s) seen.add(s)
            await wait(400)
          }
          return {
            staticCover: seen.size === 1 && !!seen.values().next().value,
            coverFrames: seen.size,
            pageBar: !!document.querySelector('.page-bar'),
            title: document.querySelector('.section-head h1')?.textContent || '',
            groups: qa('.board-group').length,
            cards: qa('.cc').length,
            uniqueTitles: new Set(qa('.cc-title').map((n) => n.textContent)).size,
            uniqueFirstCovers: new Set(qa('.cc-cover img').map((i) => i.getAttribute('src'))).size,
            withCover: qa('.cc-cover img').length,
            pending: qa('.cc-count').filter((n) => /载入中/.test(n.textContent)).length,
            subHasSource: qa('.cc-sub').some((n) => /QQ|网易云|酷狗|酷我|咪咕|Billboard|Spotify|Oricon/.test(n.textContent)),
          }
        })()`)
        await shot('_shot2_allcharts.png')

        // ③ 榜单曲目列表页 + 批量操作
        out.detail = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const first = [...document.querySelectorAll('.cc-cover')].find((el) => el.querySelector('img'))
          first?.click()
          await wait(3000)
          const qa = (s) => [...document.querySelectorAll(s)]
          const picks = qa('.row .pick').slice(0, 2)
          picks.forEach((c) => { c.checked = true; c.dispatchEvent(new Event('change')) })
          return {
            hero: !!document.querySelector('.detail-hero'),
            title: document.querySelector('.detail-meta h1')?.textContent || '',
            rows: qa('#view .row').length,
            batchButtons: qa('.list-actions [data-batch]').length,
            picked: document.querySelector('.la-count')?.textContent || '',
          }
        })()`)
        await shot('_shot3_detail.png')

        // ④ 播放全部 + 进度条
        out.play = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('[data-batch="play"]')?.click()
          await wait(14000)
          const audio = document.getElementById('previewAudio')
          return {
            paused: audio?.paused, at: audio ? +audio.currentTime.toFixed(1) : null,
            cur: document.querySelector('#curTime')?.textContent,
            total: document.querySelector('#totalTime')?.textContent,
            seek: document.querySelector('#seek')?.value,
            npTitle: document.querySelector('#barTitle')?.textContent || '',
            qualitySel: document.querySelector('#qualitySel')?.value || '',
          }
        })()`)
        await shot('_shot4_playing.png')

        // ⑤ 乐馆 → 歌单广场（不再有排行榜，也不再有类型标签 / 我的自建歌单）
        out.hall = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-back]')?.click(); await wait(700)
          document.querySelector('[data-section="hall"]')?.click(); await wait(3500)
          const tabs = qa('[data-tab]').map((b) => b.dataset.tab)
          return { title: document.querySelector('#view h1')?.textContent || '', tabs, hasChartTab: tabs.includes('排行榜') }
        })()`)
        out.square = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          const ready = () => qa('[data-pl]').length >= 5
          for (let i = 0; i < 20 && !ready(); i++) await wait(400)
          return { recCards: qa('[data-pl]').length, myCards: qa('[data-mypl]').length, chips: qa('[data-category]').length }
        })()`)
        await shot('_shot5_hall_square.png')

        // ⑥ 歌手：TOP10 头像 + 名字列表 + 性别 / 首字母筛选
        out.hallArtist = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          qa('[data-tab]').find((b) => b.dataset.tab === '歌手')?.click()
          for (let i = 0; i < 24 && !qa('.orange-art-name').length; i++) await wait(500)
          const hot = qa('.orange-art-hot').length
          const names = qa('.orange-art-name').length
          const sexChips = qa('[data-artsex]').length
          const letters = qa('[data-artletter]').length
          qa('[data-artsex="female"]')[0]?.click(); await wait(2200)
          const female = qa('.orange-art-name').length
          qa('[data-artletter="L"]')[0]?.click(); await wait(2200)
          const letterL = qa('.orange-art-name').length
          const firstL = qa('.orange-art-name')[0]?.textContent || ''
          return { hot, names, sexChips, letters, female, letterL, firstL }
        })()`)
        await shot('_shot6_hall_artist.png')

        // ⑦ 分类歌单：只留类型 + 50 个方形封面歌单
        out.hallCategory = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          qa('[data-artletter=""]')[0]?.click(); await wait(300)
          qa('[data-tab]').find((b) => b.dataset.tab === '分类歌单')?.click()
          for (let i = 0; i < 20 && !qa('.orange-type').length; i++) await wait(400)
          const types = qa('.orange-type').length
          const cards = qa('.orange-pl-card').length
          const txt = qa('.orange-type')[0]?.textContent?.trim() || ''
          const cols = getComputedStyle(document.querySelector('.orange-pl-grid') || document.body).gridTemplateColumns.split(' ').length
          return { types, cards, firstType: txt, cols }
        })()`)
        await shot('_shot7_hall_category.png')

        // ⑧ 电台：25 个频道，进去 100 首
        out.hallRadio = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          qa('[data-tab]').find((b) => b.dataset.tab === '电台')?.click()
          for (let i = 0; i < 24 && qa('.cc').length < 10; i++) await wait(500)
          const cards = qa('.cc').length
          const names = qa('.cc .cc-title, .cc b').slice(0, 6).map((x) => x.textContent.trim())
          return { cards, names }
        })()`)
        await shot('_shot8_hall_radio.png')

        // ⑨ 侧栏「巅峰榜 / 飙升榜」：整榜表格式列表（歌曲 / 歌手 / 专辑 / 时长），取满 100 首
        out.peak = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          const navLabels = qa('.orange-nav').map((b) => b.dataset.section)
          document.querySelector('[data-section="peak"]')?.click()
          for (let i = 0; i < 30 && qa('.orange-cp-row').length < 95; i++) await wait(700)
          const row = qa('.orange-cp-row')[0]
          return {
            navLabels,
            title: document.querySelector('.orange-cp-meta h1')?.textContent || '',
            upd: document.querySelector('.orange-cp-upd')?.textContent || '',
            actions: qa('.orange-cp-actions .orange-pill').map((b) => b.textContent.trim()),
            rows: qa('.orange-cp-row').length,
            idx: row?.querySelector('.orange-cp-idx')?.textContent || '',
            song: row?.querySelector('.orange-cp-name')?.textContent || '',
            artist: row?.querySelector('.orange-cp-artist')?.textContent || '',
            album: row?.querySelector('.orange-cp-album')?.textContent || '',
            time: row?.querySelector('.orange-cp-time')?.textContent || '',
            cols: (getComputedStyle(document.querySelector('.orange-cp-row') || document.body).gridTemplateColumns || '').split(' ').length,
            active: document.querySelector('.orange-nav[aria-current="page"]')?.dataset.section || '',
          }
        })()`)
        await shot('_shot9_peak.png')

        out.rise = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-section="rise"]')?.click()
          for (let i = 0; i < 30 && qa('.orange-cp-row').length < 95; i++) await wait(700)
          const row = qa('.orange-cp-row')[2]
          const before = qa('.orange-cp-heart').length
          qa('.orange-cp-heart')[0]?.click(); await wait(600)
          const liked = qa('.orange-cp-heart.on').length
          qa('.orange-cp-heart')[0]?.click(); await wait(600)
          const unliked = qa('.orange-cp-heart.on').length
          const view = document.querySelector('#view'); if (view) view.scrollTop = 0
          return {
            title: document.querySelector('.orange-cp-meta h1')?.textContent || '',
            rows: qa('.orange-cp-row').length, before, liked, unliked,
            idx3: row?.querySelector('.orange-cp-idx')?.textContent || '',
            song3: row?.querySelector('.orange-cp-name')?.textContent || '',
            active: document.querySelector('.orange-nav[aria-current="page"]')?.dataset.section || '',
          }
        })()`)
        await shot('_shot10_rise.png')

        // ⑥ 打开平台推荐歌单 → 歌曲列表
        out.playlist = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const card = document.querySelector('[data-pl]')
          const pid = card?.dataset.pl || ''
          const before = document.querySelector('.section-head h1')?.textContent || ''
          card?.click()
          await wait(500)
          const t1 = document.querySelector('.detail-meta h1')?.textContent || ''
          // 上游曲目会先上屏，同类型补齐是后台请求，轮询等它回填完再统计
          let rows = 0
          for (let i = 0; i < 24 && rows < 30; i++) {
            await wait(500)
            rows = document.querySelectorAll('#view .row').length
          }
          document.querySelector('#view').scrollTop = 0
          return {
            pid, before, t1,
            title: document.querySelector('.detail-meta h1')?.textContent || '',
            rows,
            loading: !!document.querySelector('.loading'),
          }
        })()`)
        await shot('_shot7_playlist.png')

        // ⑦ 单曲「＋」→ 新建歌单并添加（打包版会写用户真实数据，默认跳过，加 --mutate 才跑）
        if (SELF_TEST_MUTATE) {
          // ⑦ 单曲「＋」→ 新建歌单并添加
          out.addTo = await run(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms))
            document.querySelector('.row [data-addpl]')?.click()
            await wait(500)
            const sheet = document.getElementById('pickSheet')
            const opened = !!sheet && !sheet.hidden
            document.getElementById('pickNewName').value = '自检歌单'
            document.getElementById('pickNewBtn')?.click()
            await wait(1500)
            return {
              sheetOpened: opened, sheetClosed: !!document.getElementById('pickSheet')?.hidden,
              sidePlaylists: document.querySelectorAll('[data-playlist]').length,
              toast: document.getElementById('toast')?.textContent || '',
            }
          })()`)
          await shot('_shot8_added.png')
        }

        // ⑧ 我的：总览 + 听歌报告
        out.mine = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-section="library"]')?.click()
          await wait(1800)
          return {
            tabs: qa('[data-tab]').map((b) => b.dataset.tab),
            stats: qa('.stat').length,
            days: qa('.day-bar i').length,
            topArtists: qa('.top-line').length,
            rows: qa('.row').length,
          }
        })()`)
        await shot('_shot9_mine.png')

        // ⑨ 设置页
        out.settings = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-section="settings"]')?.click()
          await wait(900)
          const sw = document.getElementById('setCompact')
          const before = document.documentElement.classList.contains('compact-rows')
          if (sw) { sw.checked = !sw.checked; sw.dispatchEvent(new Event('change')) }
          await wait(300)
          const after = document.documentElement.classList.contains('compact-rows')
          if (sw) { sw.checked = !sw.checked; sw.dispatchEvent(new Event('change')) }
          await wait(300)
          // 滚到「更新」分组，方便截图核对
          document.querySelectorAll('.set-group')[3]?.scrollIntoView({ block: 'start' })
          await wait(400)
          return {
            title: document.querySelector('.section-head h1')?.textContent || '',
            groups: qa('.set-group').length,
            rows: qa('.set-row').length,
            switches: qa('.switch input').length,
            compactToggled: before !== after,
            demoBtn: !!document.getElementById('setDemoBtn'),
            demoArtist: (document.getElementById('setDemoBtn')?.closest('.set-row')?.textContent || '').includes('鞠婧祎'),
            updateBtn: !!document.getElementById('setUpdateCheck'),
            updateRepo: document.getElementById('setUpdRepo')?.value || '',
            autoUpdate: !!document.getElementById('setAutoUpdate')?.checked,
          }
        })()`)
        await shot('_shot10_settings.png')

        // ⑩ 电台：封面卡（跟榜单同一套）+ 每台 100 首
        out.radio = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-section="hall"]')?.click()
          await wait(800)
          const tabOn = () => document.querySelector('[data-tab="电台"]')?.getAttribute('aria-selected') === 'true'
          let radioCoversAtEntry = 0
          for (let i = 0; i < 40; i++) {
            if (qa('.cc').length >= 6) { radioCoversAtEntry = qa('.cc-cover img').length; break }
            if (!tabOn()) qa('[data-tab]').find((b) => b.dataset.tab === '电台')?.click()
            await wait(500)
          }
          for (let i = 0; i < 30 && qa('.cc-cover img').length < 2; i++) await wait(500)
          await wait(1200)
          const cards = qa('.cc').length
          const imgs = qa('.cc-cover img').length
          const firstTitle = qa('.cc-title')[0]?.textContent || ''
          qa('.cc-cover')[0]?.click()
          await wait(5000)
          const sub = document.querySelector('.detail-meta p')?.textContent || ''
          const rows = qa('#view .row').length
          return {
            cards, coverImgs: imgs, firstTitle, coversAtEntry: radioCoversAtEntry,
            pageTitle: document.querySelector('.detail-meta h1')?.textContent || '',
            rows, sub,
            subMatchesRows: sub.indexOf(String(rows) + ' 首') >= 0,
            hundred: rows >= 100,
          }
        })()`)
        await shot('_shot11_radio.png')

        // ⑪ 我的 → 自建歌单：卡片上有删除按钮
        out.minePlaylists = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-back]')?.click()
          await wait(700)
          document.querySelector('[data-section="library"]')?.click()
          await wait(900)
          const plReady = () => document.querySelector('[data-tab="自建歌单"]')?.getAttribute('aria-selected') === 'true'
          for (let r = 0; r < 3 && !plReady(); r++) {
            qa('[data-tab]').find((b) => b.dataset.tab === '自建歌单')?.click()
            for (let i = 0; i < 12 && !plReady(); i++) await wait(400)
          }
          await wait(500)
          return { cards: qa('[data-mypl]').length, delButtons: qa('[data-delpl]').length }
        })()`)
        await shot('_shot12_mine_playlists.png')

        // ⑫ 搜索结果按发行时间倒序 + 歌手可点进完整曲目清单页
        out.searchAndArtist = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-section="search"]')?.click()
          await wait(700)
          const si = document.getElementById('searchInput')
          if (si) { si.value = '鞠婧祎'; si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
          for (let i = 0; i < 40 && !qa('#view .row').length; i++) await wait(500)
          const pts = qa('#view .row').map((r) => Number(r.dataset.pt || 0))
          const newestFirst = pts.every((v, i) => i === 0 || pts[i - 1] >= v)
          qa('[data-tab]').find((b) => b.dataset.tab === '歌手')?.click()
          await wait(800)
          const artistCards = qa('.entity[data-artist]').length
          const card = document.querySelector('.entity[data-artist]')
          const artist = card?.dataset.artist || ''
          card?.click()
          for (let i = 0; i < 20 && !document.querySelector('.detail-meta h1'); i++) await wait(400)
          return {
            rows: pts.length,
            withPubTime: pts.filter((v) => v > 0).length,
            newestFirst,
            artistCards,
            artist,
            pageTitle: document.querySelector('.detail-meta h1')?.textContent || '',
            artistRows: qa('#view .row').length,
          }
        })()`)
        await shot('_shot13_artist.png')

        // ⑬ 队列逐首播放 + 全屏播放页控件 + 歌词
        out.queueAndPlayer = await run(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          const qa = (s) => [...document.querySelectorAll(s)]
          document.querySelector('[data-batch="play"]')?.click()
          await wait(1800)
          const titles = []
          for (let i = 0; i < 3; i++) {
            document.getElementById('nextBtn')?.click()
            await wait(2600)
            titles.push(document.getElementById('barTitle')?.textContent || '')
          }
          document.getElementById('expandBtn')?.click()
          await wait(700)
          const controls = {
            seek: !!document.getElementById('npSeek'),
            play: !!document.getElementById('npPlayBtn'),
            prev: !!document.getElementById('npPrevBtn'),
            next: !!document.getElementById('npNextBtn'),
            closeIcon: !!document.querySelector('#collapseBtn svg'),
            npCur: document.getElementById('npCurTime')?.textContent || '',
            npTotal: document.getElementById('npTotalTime')?.textContent || '',
            queueRows: qa('#npQueue .row').length,
            playingRow: qa('#npQueue .row.playing').length,
          }
          for (let i = 0; i < 26 && !qa('#npLyrics .lyric-line').length; i++) await wait(500)
          const lyricText = (document.getElementById('npLyrics')?.textContent || '').trim()
          const vizPicks = qa('.viz-pick')
          const vizBefore = document.querySelector('.viz-pick.on')?.dataset.viz || ''
          // 上次选择会持久化，所以固定点 wave 可能等于当前值；改选一个与当前不同的模式
          const vizTarget = vizPicks.find((b) => b.dataset.viz !== vizBefore)
          vizTarget?.click()
          await wait(250)
          const vizAfter = document.querySelector('.viz-pick.on')?.dataset.viz || ''
          // 播放页皮肤：切到黑胶（截图在 eval 外统一做），返回当前皮肤
          document.querySelector('[data-npskin="classic"]')?.click()
          await wait(200)
          return {
            titles,
            distinctTitles: new Set(titles).size,
            controls,
            lyricLines: qa('#npLyrics .lyric-line').length,
            lyricState: document.getElementById('npLyrics')?.dataset.state || '',
            lyricPreview: lyricText.slice(0, 40),
            viz: { canvas: !!document.getElementById('vizCanvas'), picks: vizPicks.length, before: vizBefore, after: vizAfter, switched: vizBefore !== vizAfter },
            title: document.title,
          }
        })()`)
        await shot('_shot14_full_player.png')
        const skins = { classic: out.title ? 'classic' : '' }
        for (const sk of ['vinyl', 'turntable', 'immerse']) {
          await run('document.querySelector(\'[data-npskin="' + sk + '"]\')?.click()')
          await wait(500)
          skins[sk] = await run('document.getElementById("nowPlaying")?.dataset.skin || ""')
          await shot('_shot15_skin_' + sk + '.png')
        }
        await run('document.querySelector(\'[data-npskin="classic"]\')?.click()')
        await wait(300)
        out.skins = skins
        // 侧栏缩略版：点圆形箭头收起 → 截图 → 再点一次展开
        await run('document.getElementById("nowPlaying")?.setAttribute("hidden","")')
        await run("document.querySelector('.orange-side-item[data-lib=\"我喜欢\"]')?.click()")
        await wait(900)
        out.plTab = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          const fav = document.querySelector('[data-pltab="fav"]')
          fav?.click(); await w(400)
          const favTxt = document.querySelector('.orange-pl-empty')?.textContent || ''
          const onFav = !!document.querySelector('[data-pltab="fav"].on')
          document.querySelector('[data-pltab="mine"]')?.click(); await w(300)
          const onMine = !!document.querySelector('[data-pltab="mine"].on')
          return { favTxt, onFav, onMine, favHidden: document.querySelectorAll('.orange-pl-item').length }
        })()`)
        out.fav = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('.orange-nav[data-section="hall"]')?.click(); await w(500)
          document.querySelector('[data-tab="歌单广场"]')?.click(); await w(3200)
          const stars = [...document.querySelectorAll('[data-favpl]')]
          const before = stars.length
          const id = stars[0] ? stars[0].dataset.favpl : ''
          stars[0]?.click(); await w(900)
          const on = !!document.querySelector('[data-favpl="' + id + '"].on')
          document.querySelector('[data-pltab="fav"]')?.click(); await w(500)
          const favItems = document.querySelectorAll('.orange-pl-group .orange-pl-item').length
          const favName = document.querySelector('.orange-pl-group .orange-pl-item .orange-side-txt')?.textContent || ''
          return { before, id, on, favItems, favName }
        })()`)
        await shot('_shot18_fav_playlist.png')
        out.unfav = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          const before = document.querySelectorAll('.orange-pl-group .orange-pl-item').length
          const star = document.querySelector('[data-favpl].on')
          star?.click(); await w(900)
          const after = document.querySelectorAll('.orange-pl-group .orange-pl-item').length
          return { clicked: !!star, before, after, empty: document.querySelector('.orange-pl-empty')?.textContent || '' }
        })()`)
        out.pick = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('.orange-nav[data-section="charts"]')?.click(); await w(1200)
          const cards = [...document.querySelectorAll('[data-chartopen]')]
          let opened = 0
          for (const c of cards.slice(0, 5)) {
            c.click(); await w(1400)
            if (document.querySelector('.la-more')) { opened++; break }
            document.querySelector('[data-back]')?.click(); await w(500)
          }
          const before = document.querySelectorAll('.row .pick').length
          const moreBtn = !!document.querySelector('.la-more')
          document.querySelector('.la-more')?.click(); await w(500)
          const after = document.querySelectorAll('.row .pick').length
          const countTxt = document.querySelector('.la-count')?.textContent || ''
          document.querySelector('[data-batch="pickdone"]')?.click(); await w(400)
          const done = document.querySelectorAll('.row .pick').length
          return { opened, before, moreBtn, after, countTxt, done }
        })()`)
        await shot('_shot19_batch.png')
        await run('document.querySelector(\'[data-back]\')?.click()')
        await wait(600)
        out.narrow = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          const btn = document.getElementById('qqNarrow')
          btn?.click(); await w(600)
          const cols = getComputedStyle(document.getElementById('window')).gridTemplateColumns
          const label = getComputedStyle(document.querySelector('.orange-side-txt') || document.body).display
          return { cols, label, cls: document.getElementById('window').className }
        })()`)
        await shot('_shot16_side_narrow.png')
        await run(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.getElementById('qqNarrow')?.click(); await w(600); return 1 })()`)
        await shot('_shot17_side_wide.png')

        // 精简模式（迷你播放器）：透明窗口 + 浮起卡片 + 溢出卡片的圆封面 + 环形进度
        await run(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#tbCollapse')?.click(); await w(1500); return 1 })()`)
        await wait(900)
        await shot('_shot20_mini.png')
        out.mini = await run(`(async () => {
          const q = (s) => document.querySelector(s)
          const rect = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null }
          const card = rect('.mini-card'), cover = rect('.mini-cover-wrap'), ring = q('#miniRing')
          return {
            on: !!q('.window.mini-mode'),
            card: card ? [Math.round(card.width), Math.round(card.height)] : null,
            coverW: cover ? Math.round(cover.width) : 0,
            protrude: card && cover ? Math.round(card.top - cover.top) : 0,
            ring: !!ring,
            dash: ring ? String(ring.style.strokeDashoffset) : '',
            win: [innerWidth, innerHeight],
          }
        })()`)
        // 悬停整条播放栏 → 出按钮条（用 CSS 强制 :hover 无法模拟，这里只校验命名节点存在）
        out.miniHover = await run(`(async () => {
          const q = (s) => document.querySelector(s)
          return { controls: !!q('.mini-controls'), btns: document.querySelectorAll('.mini-controls .mini-btn').length,
            play: !!q('#miniPlay'), close: !!q('#miniClose') }
        })()`)
        await run(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelector('#miniClose')?.click(); await w(1400); return 1 })()`)
        await wait(600)
        await shot('_shot21_back.png')

        // 批量操作条（参考图）：乐馆歌单点「批量」→ 播放 / 添加 … 退出批量操作
        out.batchbar = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('.orange-nav[data-section="hall"]')?.click(); await w(900)
          const card = document.querySelector('[data-pl]')
          card?.click(); await w(2600)
          document.querySelector('[data-batch="picktoggle"]')?.click(); await w(700)
          const bar = document.querySelector('.list-actions.batch-bar')
          const head = document.querySelector('.list-head.picking')
          return {
            opened: !!card,
            bar: !!bar,
            pills: bar ? [...bar.querySelectorAll('.act-pill')].map((b) => b.textContent.trim()) : [],
            headSum: head?.querySelector('.lh-sum')?.textContent.trim() || '',
            checkboxes: document.querySelectorAll('.row .pick').length,
            done: !!document.querySelector('[data-batch="pickdone"]'),
          }
        })()`)
        await shot('_shot23_batch.png')

        // 音乐库（喜欢 / 最近播放 / 本地歌曲）批量条：播放 / 添加 / 删除 … 退出批量操作
        out.batchbarLib = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('[data-batch="pickdone"]')?.click(); await w(400)
          document.querySelector('[data-section="library"][data-lib="最近播放"]')?.click(); await w(800)
          document.querySelector('[data-batch="toggle"]')?.click(); await w(600)
          const bar = document.querySelector('.orange-lib-actions.batch-bar')
          const head = document.querySelector('.orange-thead.picking')
          return {
            bar: !!bar,
            pills: bar ? [...bar.querySelectorAll('.orange-pill')].map((b) => b.textContent.trim()) : [],
            headSum: head?.querySelector('.orange-th-sum')?.textContent.trim() || '',
            pickAll: !!document.querySelector('[data-pickall]'),
            rows: document.querySelectorAll('.orange-tr.picking').length,
          }
        })()`)
        await shot('_shot24_batch_lib.png')

        // 音源与音质：应是内嵌页面（不再是弹窗），从侧栏「音源与音质」进去
        out.sourcePage = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.getElementById('qqSource')?.click(); await w(1800)
          const v = document.getElementById('view')
          const snap = {
            sheet: !!document.getElementById('sourceSheet'),
            inPage: !!v.querySelector('#sourceList'),
            heading: v.querySelector('h1')?.textContent || '',
            groups: v.querySelectorAll('.set-group').length,
            title: document.getElementById('tbTitle')?.textContent || '',
          }
          return snap
        })()`)
        await shot('_shot22_source.png')

        // 榜单页：播放第 3 首后，当前行要出现高亮；列表里不应再有「精品伴奏」等小标签
        out.playingRow = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('[data-section="rise"]')?.click(); await w(2600)
          let rows = document.querySelectorAll('.orange-cp-row').length
          for (let i = 0; i < 10 && !rows; i++) { await w(700); rows = document.querySelectorAll('.orange-cp-row').length }
          const names = document.querySelectorAll('.orange-cp-name')
          names[2]?.click(); await w(350)
          // 点下去应该立刻高亮（S.current 先切、再取链），2 秒后再看一次防止被失败跳过带偏
          const early = document.querySelectorAll('.orange-cp-row.playing').length
          const bar = document.getElementById('barTitle')?.textContent || ''
          await w(1800)
          return {
            rows,
            playingEarly: early,
            playingLater: document.querySelectorAll('.orange-cp-row.playing').length,
            bar,
            tags: document.querySelectorAll('.orange-tr-tag, .orange-cp-try, .orange-tr-try').length,
          }
        })()`)
        await shot('_shot25_playing.png')

        // 音源实测：在飙升榜上连续点 6 首，看是否真的出声（currentTime 在走）
        out.playTest = await run(`(async () => {
          const w = (ms) => new Promise((r) => setTimeout(r, ms))
          document.querySelector('[data-section="rise"]')?.click(); await w(2600)
          const rows = [...document.querySelectorAll('.orange-cp-name')].slice(0, 4)
          const res = []
          for (const b of rows) {
            b.click(); await w(4600)
            const a = document.getElementById('previewAudio')
            const bar = document.getElementById('barTitle')?.textContent || ''
            res.push(b.textContent.slice(0, 12) + '=>' + (a && a.currentTime > 0.3 && !a.paused ? 'OK' : 'FAIL') + ' [' + bar.slice(0, 12) + ']')
            try { a && a.pause() } catch (e) {}
          }
          return res
        })()`)
        logLine('[self-test] ' + JSON.stringify(out))
      } catch (e) {
        logLine('[self-test] 失败：' + e.message)
      }
      app.quit()
    })
  }

  // 站外链接交给系统浏览器，应用内不做导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })

  // 媒体键 / 后台播放：Electron 默认允许，这里只确保窗口最小化后仍继续播放
  win.on('enter-full-screen', () => { try { win.webContents.send('win:fullscreen', true) } catch { /* ignore */ } })
  win.on('leave-full-screen', () => { try { win.webContents.send('win:fullscreen', false) } catch { /* ignore */ } })
  // 自愈：精简模式窗口被放大（双击标题 / Win+↑ / 系统还原）时主进程状态会卡在 mini，
  // 之后再进精简模式位置就算错。这里以实际宽度为准退回普通状态（页面侧也会按宽度自愈）。
  // 精简模式拖动窗口时记录位置（覆盖「没点退出精简模式就直接关软件」的情况）
  win.on('moved', () => {
    if (!miniOn || !win) return
    try { const b = win.getBounds(); saveMiniPos(b.x, b.y) } catch { /* ignore */ }
  })
  win.on('resize', () => {
    if (!miniOn || !win) return
    try {
      if (win.getBounds().width > 640) {
        miniOn = false
        normalBounds = null
        win.setAlwaysOnTop(false)
        const [mw, mh] = NORMAL_MIN()
        win.setMinimumSize(mw, mh)
      }
    } catch { /* ignore */ }
  })
  // 关闭拦截：按用户设置处理（询问 / 最小化到托盘 / 退出），首次关闭会弹一次选择框
  win.on('close', (e) => {
    if (isQuitting || SELF_TEST) return
    e.preventDefault()
    if (closeAction === 'quit') { quitApp(); return }
    if (closeAction === 'tray') { hideToTray(); return }
    askCloseAction()
  })
  win.on('closed', () => { win = null })
}

ipcMain.on('win:close', () => win?.close())
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggleMax', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
// 播放页全屏按钮：进/出全屏，状态回推给渲染进程换图标
ipcMain.on('win:full', () => {
  if (!win) return
  win.setFullScreen(!win.isFullScreen())
})

// 精简模式：缩成小窗并置顶；退出时还原尺寸与置顶状态
let normalBounds = null
let miniOn = false
const NORMAL_MIN = () => [SELF_TEST ? 320 : 1000, SELF_TEST ? 400 : 660]
// 记住精简模式窗口位置：退出后再次进入，出现在上次拖动到的位置
const miniPosPath = () => path.join(app.getPath('userData'), 'mini-pos.json')
function loadMiniPos() {
  try {
    const j = JSON.parse(fs.readFileSync(miniPosPath(), 'utf8'))
    if (Number.isFinite(j?.x) && Number.isFinite(j?.y)) return { x: Math.round(j.x), y: Math.round(j.y) }
  } catch { /* 首次运行没有这个文件 */ }
  return null
}
let miniPosSaveTimer = 0
function saveMiniPos(x, y) {
  clearTimeout(miniPosSaveTimer)
  miniPosSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(miniPosPath()), { recursive: true })
      fs.writeFileSync(miniPosPath(), JSON.stringify({ x: Math.round(x), y: Math.round(y) }))
    } catch { /* 只读目录就算了 */ }
  }, 400)
}
ipcMain.on('win:mini', (_e, on) => {
  if (!win) return
  const want = !!on
  if (want) {
    // 幂等：已经在精简模式里就只保证置顶，不再重算位置（否则每点一次就往下漂 42px）
    if (!miniOn) {
      if (win.isFullScreen()) win.setFullScreen(false)
      // 记录「正常尺寸」：最大化时要用 getNormalBounds，否则恢复后还是最大化的小窗
      normalBounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
      if (win.isMaximized()) win.unmaximize()
      win.setMinimumSize(330, 112)
      const b = win.getBounds()
      // 默认落在原窗口右下角；有历史位置且仍在屏幕可见区内 → 直接用历史位置
      let x = b.x + Math.max(0, b.width - 372)
      let y = b.y + Math.round(b.height / 3)
      const saved = loadMiniPos()
      if (saved) {
        try {
          const d = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y })
          const wa = d.workArea
          const inside = saved.x >= wa.x - 24 && saved.x + 372 <= wa.x + wa.width + 24
            && saved.y >= wa.y - 24 && saved.y + 126 <= wa.y + wa.height + 24
          if (inside) { x = saved.x; y = saved.y }
        } catch { /* 屏幕信息拿不到就用默认位置 */ }
      }
      win.setBounds({ x, y, width: 372, height: 126 })
      win.setAlwaysOnTop(true, 'floating')
      // 从最大化 / 全屏退出时 setBounds 偶尔被系统异步覆盖，120ms 后再校正一次，
      // 否则窗口停在「既不是小窗也不是原尺寸」的中间态，页面看起来就是空的。
      setTimeout(() => {
        if (!win || !miniOn) return
        try {
          const bb = win.getBounds()
          if (Math.abs(bb.width - 372) > 4 || Math.abs(bb.height - 126) > 4) {
            win.setBounds({ x: bb.x, y: bb.y, width: 372, height: 126 })
          }
        } catch { /* ignore */ }
      }, 120)
    }
    miniOn = true
    try { win.webContents.send('win:miniState', true) } catch { /* ignore */ }
  } else {
    if (!miniOn && !normalBounds) return           // 本来就不在精简模式：别把窗口挪走
    // 退出前把当前位置记下来，下次进入还在原处
    try { const cb = win.getBounds(); saveMiniPos(cb.x, cb.y) } catch { /* ignore */ }
    win.setAlwaysOnTop(false)
    const [mw, mh] = NORMAL_MIN()
    win.setMinimumSize(mw, mh)
    const nb = normalBounds
    normalBounds = null
    if (nb) win.setBounds({ x: nb.x, y: nb.y, width: Math.max(nb.width, mw), height: Math.max(nb.height, mh) })
    else win.setBounds({ width: Math.max(1320, mw), height: Math.max(880, mh) })
    miniOn = false
    try { win.webContents.send('win:miniState', false) } catch { /* ignore */ }
  }
})
// 精简模式里展开播放队列：整窗往下拉高（顶边不动），卡片高度不变，多出来的空间放列表
ipcMain.on('win:miniQueue', (_e, on) => {
  if (!win || !miniOn) return                      // 不在精简模式时别改窗口尺寸
  try {
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y, width: 372, height: on ? 374 : 126 })
  } catch { /* ignore */ }
})
// 精简模式小窗拖动：页面自己算指针位移，这里只负责移动窗口
let dragFrom = null
ipcMain.on('win:dragStart', (_e, x, y) => {
  if (!win) return
  const [wx, wy] = win.getPosition()
  dragFrom = { wx, wy, x, y }
})
ipcMain.on('win:dragMove', (_e, x, y) => {
  if (!win || !dragFrom) return
  win.setPosition(Math.round(dragFrom.wx + (x - dragFrom.x)), Math.round(dragFrom.wy + (y - dragFrom.y)))
})
ipcMain.on('win:dragEnd', () => { dragFrom = null })

ipcMain.on('win:theme', (_e, mode) => {
  try { nativeTheme.themeSource = mode === 'light' || mode === 'dark' ? mode : 'system' } catch { /* ignore */ }
})
ipcMain.handle('app:autoStart', (_e, on) => {
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
    else app.setLoginItemSettings({ openAtLogin: !!on })
    return app.getLoginItemSettings().openAtLogin
  } catch { return false }
})
ipcMain.handle('app:chooseDir', async () => {
  if (!win) return ''
  const r = await dialog.showOpenDialog(win, { title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? '' : (r.filePaths[0] || '')
})
// 关闭按钮行为（设置页读写）
ipcMain.handle('app:getCloseAction', () => closeAction)
ipcMain.handle('app:setCloseAction', (_e, a) => saveCloseAction(a))
// 封面角标清洗：主进程取回图片原始字节（绕过渲染进程跨域），返回 dataURL 给 Canvas 抹 logo
ipcMain.handle('image:fetch', async (_e, url, timeout) => {
  try { return { ok: true, dataUrl: await fetchImageBase64(String(url || ''), timeout) } }
  catch (err) { return { ok: false, error: err.message } }
})

// SMTC 封面：Chromium 的 MediaMetadata.artwork 只接受 data: / blob: / https: 图片，
// file:// 会被系统媒体面板直接丢弃 —— 这正是之前「歌名有、封面一直空白」的根因。
// 主进程把跨域封面取成原始字节，回传 dataURL（浏览器进程可直接解码成 SMTC 缩略图），
// 并把真实 MIME 类型一起带回，避免 JPEG 被声明成 image/png 导致解码失败。
ipcMain.handle('smtc:art', async (_e, url) => {
  try {
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false }
    const dataUrl = await fetchImageBase64(String(url).replace(/^http:\/\//i, 'https://'), 9000)
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
    if (!m) return { ok: false }
    // 统一转成 512×512 JPEG：第三方 CDN 常给 webp/avif 或超大图，系统 SMTC 的
    // 缩略图解码器对格式/体积很挑；转码后 dataURL 更小、解码成功率最高。
    let buf = Buffer.from(m[2], 'base64')
    let type = m[1] || 'image/jpeg'
    try {
      const img = nativeImage.createFromBuffer(buf)
      if (!img.isEmpty()) {
        buf = img.resize({ width: 512, height: 512, quality: 'good' }).toJPEG(86)
        type = 'image/jpeg'
      }
    } catch { /* 转码失败就退回原字节，MIME 用服务器给的 */ }
    return { ok: true, dataUrl: `data:${type};base64,${buf.toString('base64')}`, type }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── 应用内一键自更新（参考 OrangeIsland 的 PortableUpdate 思路，适配 NSIS 单文件壳）──
// 交付形态是「外层 NSIS 壳 + 内层 Electron」：壳 Exec 内层后立即退出，所以运行中只有内层，
// 壳文件不被锁定，可以安全替换。链路：壳把自身路径通过 --om-launcher= 传进来 →
// GitHub 下载新壳到 userData\updates\ 暂存（Range 断点续传 + 重试 + 进度回推）→
// apply 时启动 PowerShell 助手：等本进程退出 → 备份旧壳(.old) → 换上新壳 → 启动新壳
// （新壳按新构建号重新解压并清理旧目录；数据在 %APPDATA%\橙子音乐 不受影响）→ 失败回滚。
const updStageDir = () => path.join(app.getPath('userData'), 'updates')
const updStagePath = () => path.join(updStageDir(), 'OrangeMusic-update.exe')
const updResultPath = () => path.join(updStageDir(), 'update-result.txt')

function updPushProgress(received, total) {
  try { if (win && !win.isDestroyed()) win.webContents.send('upd:progress', { received, total }) } catch { /* 窗口已关 */ }
}

// 下载（支持断点续传）：逻辑在 upd-core.cjs，与测试脚本共用同一份实现（测的就是跑的）。
async function updDownload(url, expectedSize) {
  const { downloadUpdate } = require('./upd-core.cjs')
  fs.mkdirSync(updStageDir(), { recursive: true })
  return downloadUpdate(url, expectedSize, updStagePath(), (received, total) => updPushProgress(received, total))
}

// 上一次更新的结果标记（apply 的助手写的 ok / fail: 原因），内层启动时读给前端提示
ipcMain.handle('app:updInfo', () => {
  let staged = null
  try {
    const p = updStagePath()
    if (fs.existsSync(p)) { const st = fs.statSync(p); staged = { size: st.size, mtimeMs: st.mtimeMs } }
  } catch { /* ignore */ }
  let result = ''
  try { if (fs.existsSync(updResultPath())) result = fs.readFileSync(updResultPath(), 'utf8').trim() } catch { /* ignore */ }
  return { launcher: launcherPath, staged, result }
})

ipcMain.handle('app:updDownload', async (_e, url, expectedSize) => {
  if (!url || !/^https:\/\/github\.com\/|https:\/\/api\.github\.com\/|https:\/\/objects\.githubusercontent\.com\//i.test(String(url))) {
    return { ok: false, error: '下载地址不受支持' }
  }
  try { return await updDownload(String(url), Number(expectedSize) || 0) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('app:updApply', (_e, expectedSize) => {  try {
    if (!launcherPath) return { ok: false, error: '本次运行缺少壳路径（旧版包请先手动更新一次）' }
    const staged = updStagePath()
    if (!fs.existsSync(staged)) return { ok: false, error: '没有已下载的更新包' }
    const want = Number(expectedSize) || 0
    if (want && fs.statSync(staged).size !== want) return { ok: false, error: '更新包不完整，请重新下载' }
    fs.mkdirSync(updStageDir(), { recursive: true })
    const { buildHelperCommand } = require('./upd-core.cjs')
    const { file, args } = buildHelperCommand({
      launcherPath,
      stagedPath: staged,
      resultPath: updResultPath(),
      pid: process.pid,
    })
    const child = require('node:child_process').spawn(file, args,
      { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    // 给助手进程一点启动时间，然后退出；助手等本进程退出后完成替换
    setTimeout(() => { isQuitting = true; try { app.quit() } catch { process.exit(0) } }, 400)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// 更新落地收尾（新内层首次启动时由前端调用一次）：删掉替换助手留下的回滚备份
// 和壳目录里更旧的带版本号 exe（保守模式：只匹配 OrangeMusic-<版本>-*.exe 且版本低于当前，
// 匹配不上的文件一律不动），并清掉已消费的更新结果标记。
ipcMain.handle('app:updCleanup', () => {
  const deleted = []
  const tryDel = (p) => { try { fs.unlinkSync(p); deleted.push(path.basename(p)) } catch { /* 锁定就留着下次清 */ } }
  try {
    if (!launcherPath) return { ok: false, deleted }
    const dir = path.dirname(launcherPath)
    // 1) 回滚备份：<壳名>.old
    const bak = launcherPath + '.old'
    if (fs.existsSync(bak)) tryDel(bak)
    // 2) 更旧的带版本号 exe（如 OrangeMusic-1.0.0.exe）
    const cur = parseAppVersion(app.getVersion())
    for (const f of fs.readdirSync(dir)) {
      const m = /^OrangeMusic-([0-9.]+)(-\w+)?\.exe$/i.exec(f)
      if (!m) continue
      if (parseAppVersion(m[1]) < cur) tryDel(path.join(dir, f))
    }
    // 3) 已消费的结果标记
    tryDel(updResultPath())
  } catch { /* 目录扫描失败不影响运行 */ }
  return { ok: true, deleted }
})

// "1.0.1" -> [1,0,1]，逐段比较用
function parseAppVersion(v) {
  return String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number(String(x).replace(/\D/g, '')) || 0)
    .reduce((a, n, i) => a + n * Math.pow(1000, 2 - i), 0)
}

logLine('[boot] ready, packaged=' + app.isPackaged)
if (!app.requestSingleInstanceLock()) {
  logLine('[boot] 单实例锁失败，退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    logLine('[boot] whenReady')
    loadCloseAction()
    patchCloudCors()
    registerProtocol()
    // 系统媒体面板的名字解析：注册表在模块初始化时已写好，这里只补「开始菜单 .lnk」。
    // 每次启动重做一遍，确保 .lnk 的 target 指向本次解压出来的内层 exe。
    try {
      const lnk = ensureStartMenuShortcut()
      smtcDiag(`[smtc] boot aumid=${AUMID} registry=${AUMID_REG_OK} shortcut=${lnk} exe=${process.execPath}`)
      logLine(`[smtc] boot aumid=${AUMID} registry=${AUMID_REG_OK} shortcut=${lnk}`)
    } catch (e) { smtcDiag('[smtc] boot failed: ' + (e?.message || e)) }
    createWindow()
    createTray()
    // 预热托盘菜单窗口：第一次右键时就不用现建现加载，弹出更快
    setTimeout(() => { if (!SELF_TEST) { try { ensureTrayMenuWin() } catch { /* ignore */ } } }, 1200)
    logLine('[boot] createWindow 已调用')
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('before-quit', () => { isQuitting = true })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
