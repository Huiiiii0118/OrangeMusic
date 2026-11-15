import {
  SECTIONS, HALL_TABS, LIBRARY_TABS, SEARCH_TABS, PLAY_MODES, ADS_ENABLED, normKey, makeTrack,
  PLAYLIST_CATEGORIES, PLAZA_CATEGORIES, RADIO_STATIONS, HOT_SEARCHES, QUICK_ENTRIES, DEMO_TRACK,
} from '../protocol/model.js'
import { native, on } from '../protocol/bridge.js'
import { getMusicApiBase, setMusicApiBase, getMusicApiUrl, setMusicApiUrl, checkMusicApi, checkRelay, getBuiltinApi, setBuiltinApi, isWinHost, builtinActive } from '../core/engine/client.js'
import { filterOfficial, filterRelevant, officialBoost, officialVerdict, isOfficialOnly, setOfficialOnly } from '../core/official.js'

const $ = (s) => document.querySelector(s)
// 本次重构（QQ 音乐风格）只作用于 Windows 桌面端；iOS 网页版保持原 orange 主题，互不污染。
const IS_WIN = document.documentElement.dataset.platform === 'windows'
const IS_IOS = document.documentElement.dataset.platform === 'ios'
// 本地测试环境：页面从 localhost / 内网 IP 打开（本地 node server.js）才算。
// 线上站点是公网域名，永不命中 —— 「本地测试账号」一键登录只在这个开关下可用。
const IS_LOCAL_TEST = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(location.hostname)
// 顶栏前进 / 后退历史栈（仅 Windows 顶栏按钮使用）
let _hist = []
let _fwd = []
// 播放队列上限 500 首：所有入队路径统一截断
const QUEUE_MAX = 500
const capQ = (q) => (q.length > QUEUE_MAX ? q.slice(0, QUEUE_MAX) : q)
// 整榜最多推荐 300 首（卡片计数与详情页共用同一个上限）
const CHART_MAX = 300
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const mmss = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
let toastTimer
// 黑框提示：用户要求「除了『暂时无法播放』外，其他所有黑框提示都删除；精简模式不提示」。
// 因此：默认静默；只有播放链路明确传 show=true 才弹，且文案一律强制为「暂时无法播放」，
// 不再透出「已试 N 条链路 / 试听片段 / HTTP 直链」等内部细节（截图里那类黑框）。
// 榜单曲目池：首页推荐兜底 / 搜索兜底 / 歌手页都要「全部榜单曲目」，
// 以前每次调用都 allChartTracks() 重新分配几千条的大数组，
// 首屏与每次 render() 都会做一遍 → 主线程抖动 + 内存峰值。改为带失效标记的惰性缓存。
let poolCache = null
function bumpChartPool() { poolCache = null }
function allChartTracks() {
  if (!poolCache) poolCache = [...S.chartTracks.values()].flat()
  return poolCache
}

const PLAY_FAIL = '暂时无法播放'
const toast = (msg, show = false) => {
  if (!show || document.documentElement.dataset.mini === '1') return
  const el = $('#toast')
  if (!el) return
  el.textContent = PLAY_FAIL; el.hidden = false
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 3200)
}

// 音量偏好：托盘 / 播放条调的都是一份落盘音量，切歌、重启后不会被重置成 100。
// 之前托盘音量「无效」的根因：只改了当前 <audio>.volume，没落盘；下次 play 新建/重置元素后就回到 1.0。
const VOLUME_KEY = 'orangemusic:volume'
const prefVolume = () => {
  try {
    const s = localStorage.getItem(VOLUME_KEY)
    // ★ 真机诊断截图确认的根因：从未调过音量时 localStorage 是 null，
    //   Number(null) === 0 会被当成「用户把音量调到 0」→ applyVolumePref() 设 a.muted=true。
    //   iOS 的 volume 只读（仍是 1）、muted 却生效，于是「手机没静音、界面在播、就是没声音」。
    if (s === null || s === '') return 1
    const v = Number(s)
    // 旧版本把音量存成 0~1 的小数，新版存 0~100 的整数。
    // 不区分的话旧值会被再除一次 100（0.8 → 0.008），同样近乎静音。
    if (Number.isFinite(v) && v >= 0 && v <= 100) return String(s).includes('.') ? Math.min(1, v) : v / 100
  } catch { /* 隐私模式 */ }
  return 1
}
function applyVolumePref() {
  const a = $('#previewAudio')
  if (!a) return
  let v = prefVolume()
  // 清掉历史脏数据：本地残留的 0 会让整站永久静音，没有「用户主动静音」标记时按 100% 回写。
  if (v <= 0 && !window.__omUserMuted) {
    v = 1
    try { localStorage.setItem(VOLUME_KEY, '100') } catch { /* 隐私模式 */ }
  }
  a.volume = v
  // 只要不是用户主动静音，就强制解除：iOS Safari 里 muted 是唯一能真正掐掉声音的开关。
  a.muted = v <= 0
  $('#volBtn')?.classList.toggle('muted', v <= 0)
}
function setVolumePref(v) {
  const x = Math.min(1, Math.max(0, Number(v) || 0))
  try { localStorage.setItem(VOLUME_KEY, String(Math.round(x * 100))) } catch { /* 隐私模式 */ }
  const a = $('#previewAudio')
  if (a) { a.volume = x; a.muted = x <= 0 }
  $('#volBtn')?.classList.toggle('muted', x <= 0)
}


export const QUALITY_ABBR = { lossless: '无损', hq: '高品质', sq: '标准', lq: '流畅' }
const QUALITY_PREF_KEY = 'orangemusic:quality'
const readQualityPref = () => {
  try {
    const v = localStorage.getItem(QUALITY_PREF_KEY) || 'auto'
    return ['auto', 'lossless', 'hq', 'sq', 'lq'].includes(v) ? v : 'auto'
  } catch { return 'auto' }
}

// 本地设置（不涉及账号数据，只影响这台设备上的表现）
const SETTINGS_KEY = 'orangemusic:settings'
const DEFAULT_SETTINGS = { resumeLast: true, compact: false, mode: 'list', lockLyric: true }
const readSettings = () => {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}) } } catch { return { ...DEFAULT_SETTINGS } }
}
function applySettings() {
  document.documentElement.classList.toggle('compact-rows', !!S.settings.compact)
  // 封面去角标：已内置默认执行，设置页不再提供开关；始终开启
  document.documentElement.dataset.striplogo = '1'
}
function saveSetting(key, value) {
  S.settings[key] = value
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)) } catch { /* 隐私模式 */ }
  applySettings()
}

// 滚轮只滚「当前这一页」，滚到顶 / 到底就停住：
//  · 吃掉越界的 wheel，滚动不会链到父容器、侧栏主菜单，也不会切换首页大板块；
//  · 侧栏单独隔离，主菜单滚到头不会带着内容区一起动；
//  · 歌单选择框 / 播放队列 / 发布说明等子滚动区还有余量时照常滚动。
// 这里不做任何 goto / 板块切换，滚轮永远不会改变当前板块。
function lockScrollBounds() {
  const main = $('#view')
  const canScroll = (el, dy) => {
    const max = el.scrollHeight - el.clientHeight
    return max > 1 && ((dy > 0 && el.scrollTop < max - 1) || (dy < 0 && el.scrollTop > 1))
  }
  const innerScroller = (target, dy) => {
    let el = target instanceof Element ? target : null
    while (el && el !== main && el !== document.body) {
      const s = getComputedStyle(el)
      if (/(auto|scroll)/.test(s.overflowY) && canScroll(el, dy)) return el
      el = el.parentElement
    }
    return null
  }
  document.addEventListener('wheel', (e) => {
    const dy = e.deltaY
    if (!dy) return
    const target = e.target instanceof Element ? e.target : null
    const side = target?.closest('.sidebar')
    if (side) {
      if (!canScroll(side, dy)) e.preventDefault()
      return
    }
    if (innerScroller(target, dy)) return
    const s = main && getComputedStyle(main)
    const el = (s && /(auto|scroll)/.test(s.overflowY)) ? main : (document.scrollingElement || document.documentElement)
    if (!canScroll(el, dy)) e.preventDefault()
  }, { passive: false })
}

// 上次会话的推荐歌单 / 歌手：同步读本机缓存，首屏立刻上屏，后台再刷新最新（stale-while-revalidate）。
function readDiscoverCache() {
  try {
    const j = JSON.parse(localStorage.getItem('orangemusic:discover:v1') || '{}')
    return {
      playlists: Array.isArray(j?.playlists?.items) ? j.playlists.items : [],
      artists: Array.isArray(j?.artists?.items) ? j.artists.items : [],
      plaza: Array.isArray(j?.plaza?.items) ? j.plaza.items : [],
    }
  } catch { return { playlists: [], artists: [], plaza: [] } }
}

// 试听列表（听过的专辑/歌单）本机缓存：未登录也要能记录，登录后同步云端
function readTrialItems() {
  try {
    const j = JSON.parse(localStorage.getItem('orangemusic:trialList') || 'null')
    return Array.isArray(j?.items) ? j.items : []
  } catch { return [] }
}

const S = {
  section: 'home', hallTab: '歌单广场', libTab: '总览', searchTab: '单曲', plTab: 'mine', sideNarrow: false,
  libQuery: '', libSearchOpen: false, libFilter: 'all', libRange: 'all', orangeView: 'normal', pageQuery: '',
  artistSex: 'all', artistLetter: '', artistQuery: '', artistDir: [], artistDirKey: '', artistBusy: false, artistQueue: '', artistFailAt: 0,
  plazaAt: 0, plazaBusy: false,
  chart: null, category: null,
  // 子页面：null | { kind:'list', title, sub, cover, tracks, from, loading, source }
  page: null,
  queue: [], queueFrom: null, current: null, positionMs: 0, playing: false, mode: 'list', npqPick: new Set(),
  device: 'browser', session: null, identity: {}, cloud: null, core: null,
  searchResults: [], favorites: [], recent: [], playlists: [], recommend: null, trialList: { id: 'trial-list', name: '试听列表', items: readTrialItems(), source: { type: 'trial' } },
  profile: null, profileTab: 'like',
  localTracks: [], chartBusy: false,
  // 首页「今日榜单」的每条榜单曲目 / 推荐歌单 / 热门歌手
  chartTracks: new Map(), chartAt: new Map(), lanesBusy: false, radioBusy: false, radioReal: new Set(), radioAt: 0, discover: readDiscoverCache(), discoverBusy: false,
  // 歌单广场：多平台多品类聚合结果 / 来源与分类筛选
  plaza: (readDiscoverCache().plaza || []), plazaAt: 0, plazaBusy: false, plazaSource: 'all', plazaCat: '全部',
  batchTracks: [], picked: new Set(), pickKeys: [], pickMode: false,
  plCounts: {},   // 歌单真实曲目数缓存：pid -> number，用于首页角标 / 详情副标题
  quality: readQualityPref(), qualityNow: '',
  settings: readSettings(),
  // 删除墓碑（跨端删除同步）：{ fav:{key:ts}, recent:{}, trial:{} }
  tombs: readTombs(),
  update: null, updateBusy: false,
  // 本地测试账号会话（仅 IS_LOCAL_TEST 环境自动登录）
  localTest: false,
  // iOS 设置页的两个卡片：'settings' | 'about'
  iosSetTab: 'settings',
  // 当前曲目歌词：切歌后异步补齐，lines 用于逐行同步高亮
  lyrics: { key: '', forKey: '', lines: [], text: '', ok: false, loading: false },
}

async function loadCore() {
  const [auth, repo, sources, quality, importer, rec, cloud, charts, covers, chartTracks, discover, genrePool, updater, lyrics, official, identity, coverClean] = await Promise.all([
    import('../core/auth.js'), import('../core/repo.js'), import('../core/sources.js'),
    import('../core/quality.js'), import('../core/playlist-import.js'), import('../core/recommend.js'),
    import('../core/cloud.js'), import('../core/charts.js'),
    import('../core/covers.js'), import('../core/chart-tracks.js'),
    import('../core/discover.js'), import('../core/genre-pool.js'), import('../core/updater.js'),
    import('../core/lyrics.js'), import('../core/official.js'), import('../core/identity.js'), import('../core/cover-clean.js'),
  ])
  return { auth, repo, sources, quality, importer, rec, cloud, charts, covers, chartTracks, discover, genrePool, updater, lyrics, official, identity, coverClean }
}

async function boot() {
  // 调试钩子：自检 / 排查用（只读暴露状态与核心模块），必须在最早的时机挂上。
  try { window.__omDebug = { get state() { return S }, get core() { return S.core } } } catch { /* ignore */ }
  applySettings()
  applyScheme()
  try { S.autoStart = localStorage.getItem('orangemusic:autostart') === '1' } catch { S.autoStart = false }
  // iOS：播放模式跟随上次选择（默认顺序播放）；Windows 仍按原约定每次默认顺序。
  if (IS_IOS) {
    const saved = String(S.settings?.mode || '')
    S.mode = ['order', 'single', 'shuffle'].includes(saved) ? saved : 'order'
  } else {
    S.mode = 'order'   // 需求：每次打开软件默认顺序播放（不恢复上次记忆的随机 / 单曲）
  }
  renderNav()
  bindStatic()
  // 弹层（登录 / 头像 / 队列 / 右键菜单等）打开时给 <html> 加 .sheet-open：CSS 据此暂停后台持续动画，
  // 否则 .sheet 的 backdrop-filter 模糊会在每帧重算，盖在旋转的封面 / 跳动的律动条上整页发卡。
  try {
    const syncSheetOpen = () => {
      const open = document.querySelector('.sheet:not([hidden]), .ask-sheet:not([hidden]), .np-queue:not([hidden]), .ctx-menu:not([hidden]), .now-playing:not([hidden])')
      document.documentElement.classList.toggle('sheet-open', !!open)
    }
    const mo = new MutationObserver(syncSheetOpen)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    syncSheetOpen()
  } catch { /* 老浏览器不支持 MutationObserver 也不影响功能 */ }
  bindHomeHero()
  bindCogMenu()
  lockScrollBounds()
  // 本地测试账号：登录面板的一键入口（仅 localhost / 内网 IP 显示，线上永不显示）。
  // 退出登录会记 orangemusic:testLoggedOut 标记，点这里清除标记并刷新 → boot 自动登录。
  if (IS_LOCAL_TEST) {
    const tb = $('#testLoginBtn')
    if (tb) {
      tb.hidden = false
      tb.onclick = () => {
        try { localStorage.removeItem('orangemusic:testLoggedOut') } catch { /* ignore */ }
        toast('已启用本地测试账号，正在刷新…')
        setTimeout(() => location.reload(), 350)
      }
    }
  }
  $('#syncPill').textContent = '初始化中…'
  await render()                 // 先出首屏：绝不因云 SDK / 网络阻塞而白屏
  startPositionSync()
  try {
    S.core = await loadCore()
    S.cloud = true
    // 封面角标清洗：核心就绪后才挂委托（首屏图此时已加载，主动补扫一遍）
    if (S.core.coverClean) {
      document.addEventListener('load', onCoverLoaded, true)
      document.querySelectorAll(COVER_SEL).forEach((img) => {
        if (img.complete && img.naturalWidth > 0) onCoverLoaded({ target: img })
      })
    }
    applyQualityPref(S.quality, { silent: true })
    // 「登录保持」关闭：本次启动先把持久会话踢掉（保留昵称/绑定档案），强制重新登录
    if (S.core.auth.keepLoginEnabled?.() === false) {
      try { await S.core.auth.dropSessionKeepProfile() } catch { /* 离线也不阻塞启动 */ }
    }
    // 本地测试账号：仅当页面从 localhost / 内网 IP 打开（本地 node server.js 测试环境）才生效，
    // 线上站点（quiet-music.app.workbuddy.host）永不命中。跳过云端验证码登录，
    // 直接以「本地测试」会话进入；数据只写本机（localStorage），不打任何云端 auth/repo 请求。
    // 退出登录会写入 orangemusic:testLoggedOut，此后不再自动登录，可从登录面板一键重新启用。
    const testAutoLogin = IS_LOCAL_TEST && !localStorage.getItem('orangemusic:testLoggedOut')
    if (testAutoLogin) {
      S.session = { user: { id: 'local-test', name: '本地测试', email: 'test@local.dev' } }
      S.localTest = true
    } else {
      S.session = await S.core.auth.restoreAuth()
    }
    // 身份统一从落盘档案取（auth.js 的 session() 已双向合并），并**每次启动都**再拉一次云端
    // 资料补齐手机号/昵称：以前只在 user 全空时才拉，SDK 只给 email 就永远补不到手机号，
    // 于是「邮箱和手机号已互绑」却一直显示「手机号未绑定」。
    if (S.session && !S.localTest) {
      try {
        const ident = await S.core.auth.refreshIdentity()
        S.identity = ident || S.core.auth.loadIdentity() || {}
        S.session.user = { ...(S.session.user || {}), ...S.identity,
          phone: S.identity.phone || S.session.user?.phone || '',
          phone_number: S.identity.phone || S.session.user?.phone_number || '' }
      } catch { S.identity = S.core.auth.loadIdentity() || {} }
    } else {
      S.identity = {}
    }
    // 匿名会话（uid='anon'）同样按未登录处理：否则会写进公共的 anon 桶，多台机器互相覆盖
    S.anonSession = isAnonSession(S.session)
    // 本地测试账号强制只写本机：没有真实云端会话，写云端既无意义也可能污染数据
    S.core.cloud.setLocalOnly(!S.session || S.anonSession || !!S.localTest)
  } catch (e) {
    S.cloud = false
    toast(`核心加载失败：${e.message}`)
  }
  try { S.device = await native.deviceId() } catch { S.device = /iPhone|iPad/i.test(navigator.userAgent) ? 'ios' : 'windows' }
  await syncUserState()
  await render()                 // 云端状态 + 榜单智能分组就绪后回填
  // 启动恢复上次播放：只恢复「哪首歌 + 队列」，**进度归零**（用户要求重开软件点播放从头开始）。
  // 同时丢掉上次保存的直链（签名地址会过期，复用它就是「在播但没声音」的元凶），
  // 点播放时重新取一条新链。
  if (S.settings.resumeLast && S.resume?.track && !S.current) {
    S.current = { ...S.resume.track, streams: [] }
    S.positionMs = 0
    if (S.resume.queue?.length) S.queue = capQ(S.resume.queue).map((t) => ({ ...t, streams: [] }))
    updatePlayerBar()
  }
  // 每次启动清一次直链缓存：跨会话的签名 URL 基本都过期了
  try { S.core?.sources?.clearStreamCache?.() } catch { /* 无核心时跳过 */ }
  // iOS：打开就是播放页，并把上次那首歌续上（用户要求「进来直接播上次的」）
  // 延后一拍：此时模块常量（IOS_IC / iosApi 等）已完成初始化，否则会命中 TDZ
  if (IS_IOS) setTimeout(() => { try { iosBoot() } catch (e) { console.warn('[iOS] boot', e && e.message) } }, 120)

  // 音源预热（新引擎为懒加载，无需下载脚本；此处保留接口兼容）
  if (S.core) S.core.sources.warmupSources?.().catch?.(() => {})
  // 电台 / 歌单广场：首屏渲染与首次交互优先，重预热延后到空闲时再做，避免启动卡顿
  // （以前一启动就把 6 个电台 ×100 首 + 上百个歌单广场数据源一起拉，首启明显发卡）。
  if (S.core) {
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500))
    idle(() => {
      if (document.hidden) return          // 最小化 / 隐藏时不抢带宽，等下次空闲
      startRadioAutoRefresh()
      startPlazaAutoRefresh()
      // 在线更新：仅桌面端静默查 GitHub Release（iOS 的更新说明与版本走本地
      // release-notes.json，随站点发布，不再请求 GitHub）。
      if (!IS_IOS) S.core.updater.checkSilently()
        .then((r) => { if (r) { S.update = r; toast(`发现新版本 ${r.latest}，可在「设置 → 更新」中获取`) } })
        .catch(() => {})
    })
  }
  // 首次启动 / 清缓存后：空闲逐项预热全站页面数据，用户点进去时直接读缓存，不出现「加载中」
  setTimeout(() => { try { warmAllPages() } catch { /* noop */ } }, 4000)
  // 版本升级检测：与上次运行版本不同（且非首次启动）时，弹出「本次更新内容」
  try {
    const cv = S.core.updater.CURRENT_VERSION
    const lv = localStorage.getItem('orangemusic:lastVersion') || ''
    if (lv && lv !== cv) {
      // 只有确实存在「可展示的版本记录」时才弹「本次更新内容」；
      // 取不到就静默跳过 —— 否则会有一个 z-index 9999 的全屏弹窗先转 9 秒再报错、
      // 并且一直挡住整个界面（表现为「哪都点不动」）。iOS 端说明读本地 release-notes.json。
      setTimeout(async () => {
        try {
          const releases = await loadReleaseNotes()
          if (releases && releases.length) {
            openChangelog({ whatsNew: true, title: `本次更新内容（v${cv}）` })
          }
        } catch { /* noop */ }
      }, 1400)
    }
    localStorage.setItem('orangemusic:lastVersion', cv)
  } catch { /* 隐私模式 */ }
  // 跨设备改名同步：低频轻查云端 profile，只有带更新才覆盖本机并局部刷新名字
  setInterval(async () => {
    if (!S.cloud || !S.session || document.hidden) return
    try {
      const pr = await S.core.repo.getState(S.core.repo.keys.profile)
      const remote = String(pr?.name || '').trim()
      const remoteAt = Number(pr?.nameUpdatedAt) || 0
      const localAt = Number(localStorage.getItem('orangemusic:profile:nameAt')) || 0
      if (remote && remoteAt > localAt) {
        localStorage.setItem('orangemusic:profile:name', remote)
        localStorage.setItem('orangemusic:profile:nameAt', String(remoteAt))
        S.core?.auth?.saveDisplayName?.(remote)
        S.profile = { ...(S.profile || {}), name: remote, nameUpdatedAt: remoteAt }
        if (S.session) S.session.user = { ...(S.session.user || {}), name: remote }
        renderNav(); syncNameLabels()
      }
      // 跨设备头像同步：另一端上传 / 恢复默认后，本端 60 秒内跟上
      if (await reconcileAvatar(pr)) { refreshAvatarDom(); renderNav() }
    } catch { /* 网络抖动忽略，下次再试 */ }
  }, 60000)
}

// ── 会话真伪：云端按 auth.uid() 隔离，匿名会话的 uid 就是 'anon' ──
// 症状：界面显示「已登录」（身份是从本机缓存补回去的邮箱/昵称），但会话其实是匿名会话，
// 写云端时 owner_id 落到公共的 'anon' 桶 —— 数据看起来"丢了"，多台未登录机器还会互相覆盖。
// 这里直接解 JWT 的 sub（sub 才是真正的 auth.uid()），识别出匿名会话后按未登录处理。
function sessionUid(s) {
  const direct = String(s?.user?.id ?? s?.user_id ?? s?.user?.sub ?? '').trim()
  if (direct) return direct
  try {
    const raw = String(s?.access_token || '')
    const t = raw.split('.')[1]
    if (!t) return ''
    const json = atob(t.replace(/-/g, '+').replace(/_/g, '/'))
    const p = JSON.parse(json)
    return String(p.sub || p.user_id || p.uid || '')
  } catch { return '' }
}
function isAnonSession(s) {
  if (!s) return false
  const uid = sessionUid(s)
  return !!uid && /^(anon|anonymous)$/i.test(uid)
}

// ── 跨端删除同步：删除墓碑 + 快照对比 ─────────────────────────────────────
// 目标：一端把「喜欢 / 最近播放 / 试听列表」里的条目删掉，另一端打开时也消失；
// 但「云端一次空读取」绝不能把本机清空（之前 200 多首喜欢就是这么丢的）。
// 做法：每次落盘前把「上次已知的 key 集合」与现在的对比，消失的 key 记一条墓碑
// （删除时间）；合并时「墓碑时间 >= 条目加入时间」就丢弃，删除后重新收藏会把
// addedAt 刷新成更晚的时间，自然盖过旧墓碑。墓碑 60 天后自动清理。
const TOMB_KEY = 'orangemusic:tombs'
const TOMB_TTL = 60 * 24 * 3600 * 1000
function readTombs() {
  try {
    const j = JSON.parse(localStorage.getItem('orangemusic:tombs') || '{}')
    return { fav: j.fav || {}, recent: j.recent || {}, trial: j.trial || {} }
  } catch { return { fav: {}, recent: {}, trial: {} } }
}
function saveTombs() {
  try { localStorage.setItem('orangemusic:tombs', JSON.stringify(S.tombs || {})) } catch { /* 隐私模式 */ }
}
function pruneTombs(map) {
  const now = Date.now(), out = {}
  for (const [k, t] of Object.entries(map || {})) {
    const ts = Number(t) || 0
    if (ts && now - ts < TOMB_TTL) out[k] = ts
  }
  return out
}
const keySetOf = (list) => new Set((list || []).map((t) => t && t.key).filter(Boolean))
const tombSnap = { fav: null, recent: null, trial: null }
function noteTombs(kind, list) {
  const now = keySetOf(list)
  const prev = tombSnap[kind]
  if (prev) for (const k of prev) if (!now.has(k)) S.tombs[kind][k] = Date.now()
  tombSnap[kind] = now
  saveTombs()
}
// 带墓碑的合并：并集 - 已删除的；任何一方都不丢数据，同时尊重删除
function mergeByTombs(local, cloud, localTombs, cloudTombs, { cap = 0, sortBy = '' } = {}) {
  const tombs = { ...(cloudTombs || {}) }
  for (const [k, t] of Object.entries(localTombs || {})) tombs[k] = Math.max(Number(t) || 0, Number(tombs[k]) || 0)
  const richness = (x) => (x.cover ? 2 : 0) + (x.durationMs ? 1 : 0) + ((x.streams && x.streams.length) ? 1 : 0) + (x.pending ? 1 : 0)
  const map = new Map()
  for (const t of [...(local || []), ...(cloud || [])]) {
    if (!t || !t.key) continue
    const prev = map.get(t.key)
    if (!prev) { map.set(t.key, t); continue }
    const winner = richness(t) >= richness(prev) ? { ...prev, ...t } : { ...t, ...prev }
    const addedAt = Math.max(Number(prev.addedAt) || 0, Number(t.addedAt) || 0)
    map.set(t.key, addedAt ? { ...winner, addedAt } : winner)
  }
  let out = [...map.values()].filter((t) => {
    const rm = Number(tombs[t.key]) || 0
    return !rm || (Number(t.addedAt) || 0) > rm
  })
  if (sortBy) out = out.sort((a, b) => (Number(b[sortBy]) || 0) - (Number(a[sortBy]) || 0))
  return { list: cap ? out.slice(0, cap) : out, removed: pruneTombs(tombs) }
}
// 统一落盘入口：先按快照记墓碑，再连同墓碑一起写云端（任何删除入口都能同步出去）
function saveFavorites() {
  noteTombs('fav', S.favorites)
  if (!S.cloud) return Promise.resolve()
  if (!tombSnap.fav) return Promise.resolve()   // 首次同步未完成：等合并后再写，别用空列表覆盖云端
  return S.core.repo.setState(S.core.repo.keys.favorites, { tracks: S.favorites, removed: S.tombs.fav })
}
function saveRecent() {
  noteTombs('recent', S.recent)
  if (!S.cloud) return Promise.resolve()
  if (!tombSnap.recent) return Promise.resolve()
  return S.core.repo.setState(S.core.repo.keys.recent, { tracks: S.recent, removed: S.tombs.recent })
}
function saveTrial() {
  const items = S.trialList?.items || []
  noteTombs('trial', items)
  if (!S.cloud) return Promise.resolve()
  if (!tombSnap.trial) return Promise.resolve()
  return S.core.repo.setState(S.core.repo.keys.playlist('trial-list'), { items, removed: S.tombs.trial })
}

async function syncUserState() {
  if (!S.cloud) { $('#syncPill').textContent = '核心未就绪'; return }
  const r = S.core.repo
  try {
    const [fav, rec, pls, pb, pr, tl] = await Promise.all([
      r.getState(r.keys.favorites), r.getState(r.keys.recent), r.listState('playlist:'), r.getState(r.keys.playback),
      r.getState(r.keys.profile).catch(() => null),
      r.getState(r.keys.playlist('trial-list')).catch(() => null),
    ])
    // 同账号跨设备同步：喜欢 / 最近播放 / 试听列表。
    // 「并集 - 删除墓碑」：一次空读取不会清空本机，但另一端主动删掉的会在这里消失。
    const cloudFav = Array.isArray(fav?.tracks) ? fav.tracks : null
    if (cloudFav === null) {
      if (!Array.isArray(S.favorites)) S.favorites = []
      tombSnap.fav = keySetOf(S.favorites)
    } else {
      const m = mergeByTombs(S.favorites, cloudFav, S.tombs.fav, fav?.removed, { cap: 1000 })
      S.favorites = m.list
      S.tombs.fav = m.removed
      saveTombs()
      tombSnap.fav = keySetOf(S.favorites)
      if (m.list.length !== cloudFav.length || Object.keys(m.removed).length) {
        r.setState(r.keys.favorites, { tracks: S.favorites, removed: S.tombs.fav }).catch(() => {})
      }
    }
    const cloudRec = Array.isArray(rec?.tracks) ? rec.tracks : null
    if (cloudRec) {
      const m = mergeByTombs(S.recent, cloudRec, S.tombs.recent, rec?.removed, { cap: 100, sortBy: 'playedAt' })
      S.recent = m.list
      S.tombs.recent = m.removed
      saveTombs()
      tombSnap.recent = keySetOf(S.recent)
      if (m.list.length !== cloudRec.length || Object.keys(m.removed).length) {
        r.setState(r.keys.recent, { tracks: S.recent, removed: S.tombs.recent }).catch(() => {})
      }
    } else if (!Array.isArray(S.recent)) S.recent = []
    // 歌单数据兜底清洗：无 id 的丢弃；无名（历史遗留 / 导入缺名）统一补「未命名歌单」，
    // 既避免侧栏出现空白条目、又让它可被正常删除（防止「无名歌单删不掉」再次复现）。
    S.playlists = pls.map((p) => p.value).filter((p) => p && p.id).map((p) => (p.name ? p : { ...p, name: '未命名歌单' }))
    // 试听列表：同样「并集 - 墓碑」，云端删了这边也消失。
    const cloudTl = Array.isArray(tl?.items) ? tl.items : null
    if (cloudTl) {
      const m = mergeByTombs(S.trialList?.items || [], cloudTl, S.tombs.trial, tl?.removed, { cap: 300 })
      S.trialList = { ...S.trialList, items: m.list, source: { type: 'trial' } }
      S.tombs.trial = m.removed
      saveTombs()
      tombSnap.trial = keySetOf(m.list)
      if (m.list.length !== cloudTl.length || Object.keys(m.removed).length) {
        r.setState(r.keys.playlist('trial-list'), { items: m.list, removed: S.tombs.trial }).catch(() => {})
      }
    }
    // 头像：云端优先，离线时用本机那份
    S.profile = pr || null
    // 多端昵称同步：云端 profile 带 nameUpdatedAt，比本机自定义名更新时以云端为准，
    // 否则 B 设备会永远守着旧昵称。时间戳都在本机/云端落盘，重启依旧有效。
    try {
      const remote = String(pr?.name || '').trim()
      const remoteAt = Number(pr?.nameUpdatedAt) || 0
      const localAt = Number(localStorage.getItem('orangemusic:profile:nameAt')) || 0
      if (remote && remoteAt > localAt) {
        localStorage.setItem('orangemusic:profile:name', remote)
        localStorage.setItem('orangemusic:profile:nameAt', String(remoteAt))
        S.core?.auth?.saveDisplayName?.(remote)
        S.profile = { ...(S.profile || {}), name: remote, nameUpdatedAt: remoteAt }
        if (S.session) S.session.user = { ...(S.session.user || {}), name: remote }
      }
    } catch { /* 本机存储不可用不影响其它同步 */ }
    // 头像：按 avatarUpdatedAt 取云端 / 本机中最后一次上传的那份
    await reconcileAvatar(pr)
    const label = S.session ? `已同步 · ${S.device}` : `离线试用 · 仅本机 · ${S.device}`
    $('#syncPill').textContent = label
    $('#syncPill').title = label
    $('#accountBtn').textContent = S.session ? (readDisplayName() || S.session.user?.name || '我的') : '离线试用'
    $('#logoutBtn').hidden = !S.session
    renderNav()
    syncNameLabels()
    if (pb?.track?.key) {
      S.resume = pb
      if (pb.device !== S.device) toast(`另一台设备停在《${pb.track.title}》${mmss(pb.positionMs)}，点播放即可续听`)
    }
  } catch (e) { toast(`读取用户数据失败：${e.message}`) }
}

// ---- 侧栏 / 底部 Tab Bar：QQ 音乐式分区导航（两端共用 DOM，样式由主题决定） ----
// ── 头像：默认自动生成 + 多端同步（以最后上传为准）────────────────────────
// 默认头像按「账号唯一标识」确定性生成 5×5 对称 identicon 渐变 SVG；两端算法一致，
// 不写云端、也不需要同步。自定义头像才进 user_state.profile，并带 avatarUpdatedAt
// 时间戳做 last-write-wins：谁最后上传（含「恢复默认」）谁生效。
const AV_KEY = 'orangemusic:avatar'
const AV_AT_KEY = 'orangemusic:avatar:at'
const AV_ANON_KEY = 'orangemusic:avatar:anon'
function avHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function avatarSeed() {
  const a = S.core?.auth?.accountView?.() || {}
  const u = S.session?.user || {}
  const v = String(a.loginTarget || u.id || u.sub || u.uid || a.email || a.phone || '').trim()
  if (v) return v
  try {
    let anon = localStorage.getItem(AV_ANON_KEY)
    if (!anon) { anon = 'anon-' + Math.random().toString(36).slice(2) + '-' + Date.now(); localStorage.setItem(AV_ANON_KEY, anon) }
    return anon
  } catch { return 'orangemusic-guest' }
}
let _defAvaCache = { seed: '', src: '' }
function defaultAvatar(seed = avatarSeed()) {
  if (_defAvaCache.seed === seed && _defAvaCache.src) return _defAvaCache.src
  const h = avHash(seed)
  const hue = h % 360, hue2 = (hue + 34 + ((h >>> 9) % 46)) % 360
  let cells = ''
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const bit = (h >>> ((y * 3 + x) % 29)) ^ (h >>> (7 + ((y + x) % 20)))
    if (!(bit & 1)) continue
    const px = 8 + x * 10, py = 8 + y * 10
    cells += `<rect x="${px}" y="${py}" width="9" height="9" rx="2"/>`
    if (x < 2) cells += `<rect x="${8 + (4 - x) * 10}" y="${py}" width="9" height="9" rx="2"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 82% 62%)"/><stop offset="1" stop-color="hsl(${hue2} 78% 46%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><g fill="hsl(${(hue + 180) % 360} 92% 96%)" fill-opacity=".92">${cells}</g></svg>`
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  _defAvaCache = { seed, src }
  return src
}
function avatarSrc() {
  // 云端 profile → 本机 localStorage → 自动生成的默认头像；离线也能显示上次上传的那张
  const custom = String(S.profile?.avatar || '').trim() || readAvatarLocal()
  return custom || defaultAvatar()
}
function avatarImgHtml() { return `<img class="av-img" src="${esc(avatarSrc())}" alt="头像" draggable="false">` }
function readAvatarLocal() { try { return String(localStorage.getItem(AV_KEY) || '') } catch { return '' } }
function readAvatarAt() { try { return Number(localStorage.getItem(AV_AT_KEY) || 0) || 0 } catch { return 0 } }
function writeAvatarLocal(value, at) {
  try { localStorage.setItem(AV_KEY, value || '') } catch { /* 配额满忽略 */ }
  try { localStorage.setItem(AV_AT_KEY, String(at || 0)) } catch { /* ignore */ }
}
// 局部刷新所有头像槽位，不整页 render（避免打断滚动 / 播放 / 正在输入的表单）
function refreshAvatarDom() {
  const src = avatarSrc()
  document.querySelectorAll('[data-av-slot] img.av-img').forEach((img) => {
    if (img.getAttribute('src') !== src) img.setAttribute('src', src)
  })
}
// 云端 / 本机按 avatarUpdatedAt 取最新者。返回 true 表示本机被云端改写、需要刷新 UI。
async function reconcileAvatar(pr) {
  const remoteAt = Number(pr?.avatarUpdatedAt) || 0
  const localAt = readAvatarAt()
  if (remoteAt > localAt) {
    const next = String(pr?.avatar || '')
    S.profile = { ...(S.profile || {}), avatar: next, avatarUpdatedAt: remoteAt }
    writeAvatarLocal(next, remoteAt)
    return true
  }
  if (localAt > remoteAt && S.session && S.cloud && S.core?.repo) {
    // 本机较新（离线改过 / 上次写云端失败）：推回云端，保留云端其它字段（昵称等）
    const next = readAvatarLocal()
    S.profile = { ...(pr || {}), ...(S.profile || {}), avatar: next, avatarUpdatedAt: localAt }
    try { await S.core.repo.setState(S.core.repo.keys.profile, S.profile) } catch { /* 离线忽略，下次再试 */ }
    return false
  }
  if (!S.profile?.avatar) {
    const a = readAvatarLocal()
    if (a) S.profile = { ...(S.profile || {}), avatar: a }
  } else if (!localAt && !remoteAt) {
    writeAvatarLocal(S.profile.avatar, 0)   // 兼容旧版「有头像但没时间戳」
  }
  return false
}

function renderNav() {
  if (IS_IOS) return iosRenderNav()
  if (IS_WIN) return orangeRenderNav()
  const nav = SECTIONS.filter((s) => s.id !== 'player')
  const tabs = nav.filter((s) => s.id !== 'settings')
  const active = S.page ? (S.page.from === 'home' ? 'home' : 'hall') : S.section
  $('#nav').innerHTML = `
    <div class="side-brand">
      <span class="brand-mark" aria-hidden="true"><img class="brand-logo" src="./logo.png" alt="" width="30" height="30" draggable="false"></span>
      <span class="brand-text"><b>橙子音乐</b><small>Orange Music</small></span>
    </div>
    <div class="side-group">
      <div class="side-label">音乐馆</div>
      ${nav.map((s) => `<button class="nav-item" data-section="${s.id}" aria-current="${s.id === active ? 'page' : 'false'}"><span class="nav-ico">${s.icon}</span>${s.label}</button>`).join('')}
    </div>
    <div class="side-group">
      <div class="side-label">我的音乐</div>
      <button class="nav-item sub" data-section="library" data-lib="总览"><span class="nav-ico">▦</span>听歌报告</button>
      <button class="nav-item sub" data-section="library" data-lib="自建歌单"><span class="nav-ico">♪</span>自建歌单</button>
      <button class="nav-item sub" id="sideImportBtn"><span class="nav-ico">＋</span>导入歌单</button>
    </div>
    <div class="side-group">
      <div class="side-label">自建歌单 <span class="side-count">${S.playlists.filter((p) => !p.fav).length}</span></div>
      ${S.playlists.filter((p) => !p.fav).map((p) => `<button class="nav-item sub" data-playlist="${esc(p.id)}"><span class="nav-ico">♪</span>${esc(p.name)}</button>`).join('')}
    </div>
    ${S.playlists.some((p) => p.fav) ? `<div class="side-group">
      <div class="side-label">收藏歌单 <span class="side-count">${S.playlists.filter((p) => p.fav).length}</span></div>
      ${S.playlists.filter((p) => p.fav).map((p) => `<button class="nav-item sub" data-playlist="${esc(p.id)}"><span class="nav-ico">☆</span>${esc(p.name)}</button>`).join('')}
    </div>` : ''}
    <div class="side-cog-row">
      <button class="side-cog" id="sideCog" title="设置与工具" aria-label="设置与工具" aria-haspopup="menu">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2"/>
          <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-.6-1-2.6-2 .4a7.6 7.6 0 0 0-2.1-2.1l.4-2-2.6-1-.6 2a7.6 7.6 0 0 0-3 0l-.6-2-2.6 1 .4 2A7.6 7.6 0 0 0 4.6 8l-2-.4-1 2.6 2 .6a7.6 7.6 0 0 0 0 3l-2 .6 1 2.6 2-.4a7.6 7.6 0 0 0 2.1 2.1l-.4 2 2.6 1 .6-2a7.6 7.6 0 0 0 3 0l.6 2 2.6-1-.4-2a7.6 7.6 0 0 0 2.1-2.1l2 .4 1-2.6-2-.6z"/>
        </svg>
      </button>
      <span class="side-cog-label">设置与工具</span>
    </div>
    <div class="side-foot">Orange Music · 橙子音乐<br>iOS 网页 / Windows 实时同步</div>`
  $('#tabbar').innerHTML = tabs.map((s) =>
    `<button class="tab-item" data-section="${s.id}" aria-current="${s.id === active ? 'page' : 'false'}"><span class="tab-ico">${s.icon}</span><span>${s.label}</span></button>`).join('')
}

// ── Windows · 左侧导航栏（1:1 复刻参考图）──
function orangeRenderNav() {
  // 已登录但 user 里没有 name 时，退回邮箱/手机号，绝不显示「未登录」——避免与「已登录 · 云端同步」自相矛盾。
  // 优先用自定义昵称（落盘档案），保证侧栏 / 个人主页 / 设置页显示同一个名字。
  const who = displayName()
  const active = S.page ? (S.page.from === 'home' ? 'home' : 'hall') : S.section
  const libActive = (v) => (S.section === 'library' && !S.page && S.libTab === v ? 'page' : 'false')
  const navItems = [
    { id: 'home', label: '推荐', icon: '<path d="M4.2 11.3 12 4.3l7.8 7V20a1 1 0 0 1-1 1h-4.3v-5.6H9.5V21H5.2a1 1 0 0 1-1-1z"/>' },
    { id: 'hall', label: '乐馆', icon: '<circle cx="12" cy="12" r="8.6"/><path d="m15.3 8.7-2.2 5.1-5.1 2.2 2.2-5.1z"/>' },
    // 巅峰榜：三根圆角柱 + 一条基线（按用户给的柱状图图标重绘），描边走 currentColor
    { id: 'peak', label: '巅峰榜', icon: '<path d="M3 19.6H21"/><rect x="4.6" y="11.4" width="4.2" height="8.2" rx="1.3"/><rect x="9.9" y="4.9" width="4.2" height="14.7" rx="1.3"/><rect x="15.2" y="9.4" width="4.2" height="10.2" rx="1.3"/>' },
    // 飙升榜：粗箭头向上突破 + 底部阶梯（参考用户给的线性图标）。
    { id: 'rise', label: '飙升榜', icon: '<path d="M3.2 18.3 9.5 12 11.7 14.2 20.2 5.7"/><path d="M15.2 5.7h5V10.7"/><path d="M4.2 20.6h4.4M11 20.6h3.4v-3.2M17.4 20.6h2.8v-5.6"/>' },
  ]
  const sideItems = [
    { lib: '我喜欢', label: '喜欢', count: S.favorites.length, icon: '<path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/>', fillable: true },
    { lib: '最近播放', label: '最近播放', count: S.recent.length, icon: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/>' },
    { lib: '本地歌曲', label: '本地歌曲', count: S.localTracks.length, icon: '<path d="M12 4v9.6"/><path d="m8.2 10.4 3.8 3.8 3.8-3.8"/><path d="M5 18.6h14"/>' },
    { lib: '试听列表', label: '试听列表', count: S.trialList?.items?.length || 0, icon: '<path d="M4 7.4h9M4 12h6.4M4 16.6h4.6"/><circle cx="16.4" cy="15.8" r="2.4"/><path d="M18.8 15.8V7.6"/>' },
  ]
  // 歌单分组：自建 = 自己新建 / 导入合并的；收藏 = 在歌单广场点星标收藏的平台歌单（fav 标记）
  const plTab = S.plTab === 'fav' ? 'fav' : 'mine'
  const minePls = S.playlists.filter((p) => !p.fav)
  const favPls = S.playlists.filter((p) => p.fav)
  const shownPls = plTab === 'fav' ? favPls : minePls
  // 缩略版导航栏（只留图标），状态持久化；右侧内容区 / 播放条随 grid 列宽自动适应
  const narrow = !!S.sideNarrow
  $('#nav').innerHTML = `
    <div class="orange-side">
      <div class="orange-user${S.session ? '' : ' is-guest'}" ${S.session ? '' : 'data-open-login="1"'}>
        <div class="orange-avatar" data-av-slot>${S.session
          ? avatarImgHtml()
          : '<span class="orange-avatar-note"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18.4V7.2l9-1.8v9.8"/><circle cx="6.9" cy="18.6" r="2.3" fill="currentColor" stroke="none"/><circle cx="15.9" cy="17" r="2.3" fill="currentColor" stroke="none"/></svg></span>'}</div>
        <div class="orange-user-meta">
          <b id="sideUserName">${esc(who)}</b>
          <div class="orange-user-badges">${S.session
            ? '<span class="orange-badge-login">已登录 · 云端同步</span>'
            : '<span class="orange-badge-login">登录同步歌单 ›</span>'}</div>
        </div>
      </div>
      <div class="orange-brand">
        <span class="orange-brand-logo"><img class="brand-logo" src="./logo.png" alt="橙子音乐" width="26" height="26" draggable="false"></span>
        <span class="orange-brand-txt"><b>橙子音乐</b><small>Orange Music</small></span>
      </div>
      <div class="orange-nav-grid">
        ${navItems.map((n) => `<button class="orange-nav" data-section="${n.id}" aria-current="${n.id === active ? 'page' : 'false'}" title="${n.label}" aria-label="${n.label}">
            <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${n.icon}</svg>
            <span class="orange-nav-txt">${n.label}</span>
          </button>`).join('')}
      </div>
      <div class="orange-side-group">
        ${sideItems.map((s) => `<button class="orange-side-item${s.fillable ? ' orange-heart-item' : ''}" data-section="library" data-lib="${s.lib}" aria-current="${libActive(s.lib)}">
            <svg class="orange-ico-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${s.icon}</svg>
            <span class="orange-side-txt">${s.label}${s.count ? `<i class="orange-count">·${s.count}</i>` : ''}</span>
          </button>`).join('')}
      </div>
      <div class="orange-side-group orange-pl-group">
        <div class="orange-side-label">
          <button class="orange-tab${plTab === 'mine' ? ' on' : ''}" data-pltab="mine">自建歌单</button>
          <span class="orange-tab-sep">|</span>
          <button class="orange-tab${plTab === 'fav' ? ' on' : ''}" data-pltab="fav">收藏歌单</button>
          <span class="orange-add" id="qqAddPl2" title="新建歌单">+</span>
        </div>
        ${shownPls.length
          ? shownPls.map((p) => `<button class="orange-side-item orange-pl-item" data-playlist="${esc(p.id)}"><span class="orange-pl-cover">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : ''}</span><span class="orange-side-txt">${esc(p.name)}</span></button>`).join('')
          : `<div class="orange-pl-empty">${plTab === 'fav' ? '还没有收藏歌单 · 在歌单卡右上角点 ☆' : '还没有自建歌单'}</div>`}
      </div>
      <div class="orange-side-tools">
        <button class="orange-tool orange-narrow-toggle" id="qqNarrow" title="${narrow ? '展开导航栏' : '收起导航栏'}" aria-label="${narrow ? '展开导航栏' : '收起导航栏'}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="${narrow ? 'm10.4 8.2 3.8 3.8-3.8 3.8' : 'm13.6 8.2-3.8 3.8 3.8 3.8'}"/></svg>
        </button>
        <button class="orange-tool" id="qqSource" title="音源与音质">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><path d="M12 6.4a5.6 5.6 0 0 1 5.6 5.6"/></svg>
        </button>
        <button class="orange-tool" id="qqCog" title="设置">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4 19 7.2v9.6L12 20.6 5 16.8V7.2z"/><circle cx="12" cy="12" r="2.6"/></svg>
        </button>
        <button class="orange-tool" id="qqAbout" title="关于">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 10.6v5.6"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
    </div>`
  $('#window')?.classList.toggle('orange-narrow', narrow)
  $('#tabbar').innerHTML = ''
}

function homeAction(act, el) {
  if (act === 'report') { S.libTab = '最近播放'; goto('library'); return }
  if (act === 'vip') { openSourceSheet(); return }
  if (act === 'shuffle') {
    const tracks = (S.recommend?.tracks?.length ? S.recommend.tracks : allChartTracks())
    if (!tracks.length) return toast('暂无推荐曲目')
    S.queue = capQ(tracks.slice())
    S.queueFrom = { id: 'home:shuffle', name: '推荐 · 随机播放' }
    S.mode = 'shuffle'; playTrack(tracks[0])
    return
  }
  if (act === 'radio') { const r = RADIO_STATIONS.find((x) => x.id === el.dataset.radio); if (r) playRadio(r.id); return }
}

// ---- 通用渲染片段 ----
// 封面：有就直接用；没有先出确定性渐变占位（data-ck 标记），渲染后由 hydrateCovers() 换成真图。
// 无封面时的占位渐变色相：统一落在橙 / 琥珀区间，避免整屏五颜六色
const hueOf = (s) => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return 12 + (h % 32) }
// 已解析过的封面（本地缓存）直接同步取出，首屏就不用等 hydrateCovers 再换一次。
const cachedCover = (t) => t?.cover || (t?.key && S.core?.covers ? S.core.covers.coverOf(t) : '')

// 歌手照片（头像），优先从权威歌手名录取；绝不回退到歌曲封面。
// S.artistDir / S.discover.artists 的 a.cover 是网易云 picUrl / 酷狗 imgurl 的歌手头像。
function artistPhoto(name) {
  if (!name) return ''
  name = String(name).trim()
  for (const src of [S.artistDir, S.discover?.artists]) {
    if (!src || !src.length) continue
    const hit = src.find((a) => a.name === name)
    if (hit?.cover) return hit.cover
  }
  return ''
}
const coverHtml = (t, { eager = false } = {}) => {
  const u = cachedCover(t)
  if (!u) return `<span class="cover-fallback" data-ck="${esc(t?.key || '')}" data-hue="${hueOf(t?.key)}">♪</span>`
  return eager
    ? `<img src="${esc(u)}" alt="" decoding="async" fetchpriority="high" data-ckey="${esc(t?.key || '')}">`
    : `<img src="${esc(u)}" alt="" loading="lazy" decoding="async" data-ckey="${esc(t?.key || '')}">`
}

// 播放页唱盘中央：始终要一张大图（不走 lazy），缺图时给渐变占位音符。
const npCoverHtml = (t) => {
  const u = cachedCover(t)
  if (!u) return `<span class="cover-fallback" data-ck="${esc(t?.key || '')}" data-hue="${hueOf(t?.key)}">♪</span>`
  return `<img src="${esc(u)}" alt="" decoding="async" fetchpriority="high" data-ckey="${esc(t?.key || '')}">`
}

// 图片来源是第三方 CDN，偶发 404 / 防盗链 / 超时。坏图直接换成确定性渐变占位，
// 不留白框，也不出现浏览器的破图图标（CSP 不允许内联 onerror，所以在这里统一挂）。
function bindImageFallback(root = document) {
  root.querySelectorAll('img:not([data-fb])').forEach((img) => {
    img.dataset.fb = '1'
    const fail = () => {
      if (!img.isConnected) return
      const span = document.createElement('span')
      span.className = 'cover-fallback'
      span.dataset.hue = String(hueOf(img.getAttribute('src') || ''))
      // 保留曲目 key：下一轮 hydrateCovers 会换一个封面源再试，不会永久停在灰块。
      const ck = img.dataset.ckey || img.dataset.ck || ''
      if (ck) span.dataset.ck = ck
      span.textContent = '♪'
      img.replaceWith(span)
      span.style.setProperty('--h', span.dataset.hue)
    }
    img.addEventListener('error', fail, { once: true })
    // 刚插入 DOM 的懒加载图片 complete 会短暂为 true / naturalWidth 为 0，
    // 立即判失败会把好图误换成占位 —— 延后一帧，且只处理确实已加载完的图。
    setTimeout(() => {
      if (img.isConnected && img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail()
    }, 150)
  })
}

// ── 封面角标清洗 ─────────────────────────────────────────────────────────
// 第三方封面四角常叠平台 logo / 播放量水印。这里在图片加载完成后，走主进程取回
// 原始字节、Canvas 抹掉角标，再换回显示。用 document 捕获阶段委托，hydrateCovers
// 动态插入的图也能覆盖。并发限 2，避免几十张图同时解码卡住 UI。
let ccInFlight = 0
const ccQueue = []
function pumpCoverClean() {
  while (ccInFlight < 2 && ccQueue.length) {
    const { img, src } = ccQueue.shift()
    ccInFlight++
    const done = () => { ccInFlight--; pumpCoverClean() }
    S.core.coverClean.cleanCover(src)
      .then((clean) => {
        if (!img.isConnected || img.dataset.ccSrc !== src) return done()   // 已被换图/换页
        if (clean && clean !== src) { img.dataset.ccStatus = '1'; img.src = clean }
        else img.dataset.ccStatus = 'skip'
      })
      .catch(() => done())
      .finally(done)
  }
}
const COVER_SEL = '.cover img, .cc-cover img, .hero-cover img, .detail-cover img, .orange-card-imgbg img, .orange-card-side-img img, .orange-pl-cover img, .orange-pl-cover-big img, .prof-pl-cover img, .orange-song-cover img, .orange-tr-cover img, .orange-cp-cover-img, .strip-item .cover img, .card .cover img, .rec-card .cover img'
function onCoverLoaded(e) {
  const img = e.target
  if (!img || img.tagName !== 'IMG' || img.dataset.ccStatus) return
  if (!S.core?.coverClean || !S.core.coverClean.isCleanEnabled()) return
  if (!img.matches(COVER_SEL)) return                       // 头像 / 图标 / 歌手圆图不处理
  const src = img.currentSrc || img.src
  if (!/^https?:/i.test(src) || src.startsWith('data:')) return
  if (ccQueue.length > 30) return                            // 队列过长（快速滚动）就放弃，不影响滚动流畅
  img.dataset.ccStatus = 'pending'
  img.dataset.ccSrc = src
  ccQueue.push({ img, src })
  pumpCoverClean()
}

// CSP 是 style-src 'self'，HTML 里写死的行内 style 会被浏览器整条丢弃，
// 所以占位色相、轮播模糊底这类动态样式统一在渲染后用 CSSOM 补。
function paintDynamics(root = document) {
  root.querySelectorAll('[data-hue]').forEach((n) => n.style.setProperty('--h', n.dataset.hue))
  root.querySelectorAll('[data-bar]').forEach((n) => n.style.setProperty('--bar', `${Math.max(2, Number(n.dataset.bar) || 0)}%`))
  root.querySelectorAll('[data-blur]').forEach((n) => {
    if (n.dataset.blur && !n.style.backgroundImage) n.style.backgroundImage = `url('${n.dataset.blur}')`
  })
  bindImageFallback(root)
}

// 通用右键/更多菜单：anchor 触发元素（或 {x,y} 坐标），
// items = [{label, icon, arrow, danger, disabled, onClick, sub:[...]}] 或 {sep:true}。
// sub 存在时 hover 展开二级菜单（添加到/移动到 的 QQ 式引导）。
let _ctxEl = null
function closeCtxMenu() {
  if (_ctxEl) { _ctxEl.remove(); _ctxEl = null }
  document.querySelectorAll('.ctx-sub').forEach((n) => n.remove())
}
function _ctxOutside(e) { if (!e.target.closest('.ctx-menu')) closeCtxMenu() }
// 图标占位恒定存在：有图标的项与纯文字项共用同一 18px 左槽，文字起点才会在一条竖线上。
const _ctxItemHtml = (it, idxAttr, i) => it.sep
  ? '<div class="ctx-sep"></div>'
  : `<button class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" ${idxAttr}="${i}"><span class="ctx-ico">${it.icon || ''}</span><span class="ctx-label">${esc(it.label)}</span>${it.arrow ? '<span class="ctx-arrow">›</span>' : ''}</button>`

function openCtxMenu(anchor, items) {
  closeCtxMenu()
  const el = document.createElement('div')
  el.className = 'ctx-menu'
  el.innerHTML = items.map((it, i) => _ctxItemHtml(it, 'data-i', i)).join('')
  document.body.appendChild(el)
  _ctxEl = el
  const r = anchor && anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: anchor?.x || 0, right: anchor?.x || 0, top: anchor?.y || 0, bottom: anchor?.y || 0 }
  const mw = el.offsetWidth, mh = el.offsetHeight
  let x = anchor?.getBoundingClientRect ? r.right - mw : r.left
  let y = r.bottom + 6
  if (y + mh > innerHeight - 8) y = r.top - mh - 6
  if (x < 8) x = 8
  if (x + mw > innerWidth - 8) x = innerWidth - 8 - mw
  el.style.left = x + 'px'; el.style.top = Math.max(8, y) + 'px'
  el.querySelectorAll('.ctx-item').forEach((b) => {
    const it = items[+b.dataset.i]
    if (it.disabled) return
    if (it.sub?.length) {
      let subEl = null
      const openSub = () => {
        closeSubs()
        subEl = document.createElement('div')
        subEl.className = 'ctx-menu ctx-sub'
        subEl.innerHTML = it.sub.map((s, j) => _ctxItemHtml(s, 'data-j', j)).join('')
        document.body.appendChild(subEl)
        const br = b.getBoundingClientRect()
        subEl.style.top = Math.min(br.top, innerHeight - 8 - subEl.offsetHeight) + 'px'
        const flip = br.right + subEl.offsetWidth > innerWidth - 8
        subEl.style.left = (flip ? br.left - subEl.offsetWidth - 2 : br.right + 2) + 'px'
        subEl.querySelectorAll('.ctx-item').forEach((sb) => sb.onclick = () => {
          const s = it.sub[+sb.dataset.j]
          if (s.disabled) return
          closeCtxMenu(); s.onClick && s.onClick()
        })
        subEl.onmouseleave = () => { if (subEl) { subEl.remove(); subEl = null } }
      }
      const closeSubs = () => document.querySelectorAll('.ctx-sub').forEach((n) => n.remove())
      b.addEventListener('mouseenter', openSub)
      b.addEventListener('mouseleave', () => setTimeout(() => {
        const s = document.querySelector('.ctx-sub')
        if (s && !s.matches(':hover')) s.remove()
      }, 120))
    } else {
      b.onclick = () => { closeCtxMenu(); it.onClick && it.onClick() }
    }
  })
  setTimeout(() => document.addEventListener('click', _ctxOutside, { once: true }), 0)
}

const HEART_SVG = (on) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>`

function findTrack(key) {
  return allTracks().find((x) => x.key === key) || S.favorites.find((x) => x.key === key)
    || S.queue.find((x) => x.key === key) || trackIndex.get(key) || null
}
async function toggleLikeKey(key) {
  const t = findTrack(key); if (!t) return
  const exists = S.favorites.some((x) => x.key === key)
  S.favorites = exists ? S.favorites.filter((x) => x.key !== key) : [{ ...t, addedAt: Date.now() }, ...S.favorites].slice(0, 1000)
  if (S.cloud) await saveFavorites().catch((e) => toast(e.message))
  updatePlayerBar(); toast(exists ? '已取消喜欢' : '已加入我喜欢'); renderNav(); render()
}
function copyTrackShare(t) { try { navigator.clipboard.writeText(`${t?.title || ''} - ${t?.artist || ''}`); toast('已复制歌曲信息') } catch { toast('复制失败') } }
function copyTrackInfo(t) { try { navigator.clipboard.writeText(`${t?.title || ''} - ${t?.artist || ''} · ${t?.album || ''}`); toast('已复制歌曲信息') } catch { toast('复制失败') } }
// 列表行「更多」菜单（1:1 对齐 QQ 参考图：播放 / 下一首播放 / 播放相似单曲 /
// 我喜欢 / 添加到▸ / 移动到▸ / 删除；MV、购买、分享、评论、曲谱、复制信息已按需求移除）。
const MI = {
  play: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8.4 5.4v13.2L19 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 5.6v12.8L15 12z"/><rect x="15.6" y="5.6" width="2.6" height="12.8" rx="1"/></svg>',
  similar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7.2"/><path d="M9.2 12a2.8 2.8 0 0 1 5.6 0"/><path d="M12 4.8V2.9M12 21.1v-1.9"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>',
  heartOn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="#ff4d5e" stroke="#ff4d5e" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.4v7.2M8.4 12h7.2"/></svg>',
  move: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 7.2h6l1.8 2.2h9v9.4H3.6z"/></svg>',
  dl: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.4v9.4"/><path d="m8.4 10.4 3.6 3.6 3.6-3.6"/><path d="M5 18.6h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M8.2 7V4.8h7.6V7"/><path d="M6.6 7l.9 12.2h9l.9-12.2"/></svg>',
}

// 「下一首播放」：插到当前曲目之后
function playNextOf(key) {
  const t = findTrack(key); if (!t) return
  const rest = S.queue.filter((x) => x.key !== key)
  const i = S.current ? rest.findIndex((x) => x.key === S.current.key) : -1
  S.queue = capQ(i >= 0
    ? [...rest.slice(0, i + 1), t, ...rest.slice(i + 1)]
    : (S.current ? [S.current, t, ...rest.filter((x) => x.key !== S.current.key)] : [t, ...rest]))
  updatePlayerBar()
  if ($('#npqList')) renderNpQueue()
  toast('已添加到下一首播放')
}

// 「播放相似单曲」：同歌手 / 同曲风 / 同专辑召回 12 首，排在当前曲之后连播
function playSimilarOf(t) {
  if (!t) return
  const pool = [...new Map(allTracks().map((x) => [x.key, x])).values()]
  const artist = String(t.artist || '').split(/\s*\/\s*/)[0].trim().toLowerCase()
  const tags = (t.tags || []).map(String)
  const picks = pool.filter((x) => x.key !== t.key).map((x) => {
    const a = String(x.artist || '').split(/\s*\/\s*/)[0].trim().toLowerCase()
    let s = 0
    if (a && a === artist) s += 3
    if (tags.some((tag) => (x.tags || []).includes(tag))) s += 2
    if (t.albumName && x.albumName === t.albumName) s += 1
    return { x, s }
  }).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.x).slice(0, 12)
  if (!picks.length) return toast('曲库里还没有相似歌曲（同曲风 / 同歌手），多听几首后就有了')
  S.queue = capQ([t, ...picks])
  S.queueFrom = { id: `similar:${t.key}`, name: `相似单曲 · ${t.title}` }
  playTrack(t)
  toast(`已按相似度排入 ${picks.length} 首相似单曲`)
}

// ── 自绘确认 / 输入弹窗：替掉原生 confirm()/prompt()（系统灰框跟整个 UI 不是一个风格）──
function askDialog({ title = '确认', message = '', ok = '确定', cancel = '取消', danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'sheet ask-sheet'
    wrap.innerHTML = `<div class="sheet-card ask-card" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
      ${message ? `<p class="ask-msg">${esc(message)}</p>` : ''}
      ${input ? `<input class="field ask-input" id="askInput" placeholder="${esc(input.placeholder || '')}" maxlength="${Number(input.max) || 40}" value="${esc(input.value || '')}" spellcheck="false">` : ''}
      <div class="btn-row end">
        <button class="btn small" data-ask="cancel">${esc(cancel)}</button>
        <button class="btn small${danger ? ' danger' : ' primary'}" data-ask="ok">${esc(ok)}</button>
      </div>
    </div>`
    document.body.appendChild(wrap)
    const field = wrap.querySelector('#askInput')
    const finish = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v) }
    const submit = () => finish(input ? ((field?.value || '').trim() || null) : true)
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(input ? null : false) }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); submit() }
    }
    wrap.querySelector('[data-ask="ok"]').onclick = submit
    wrap.querySelector('[data-ask="cancel"]').onclick = () => finish(input ? null : false)
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) finish(input ? null : false) })
    document.addEventListener('keydown', onKey, true)
    setTimeout(() => { (field || wrap.querySelector('[data-ask="ok"]')).focus() }, 30)
  })
}
const askConfirm = (message, opts = {}) => askDialog({ ...opts, message })
const askText = (title, placeholder = '', opts = {}) => askDialog({ ...opts, title, ok: opts.ok || '创建', input: { placeholder } })

// 关闭确认弹窗（应用内自绘，替代系统灰框）：最小化到托盘 / 退出软件 / 取消 + 记住选择
function showCloseDialog() {
  if (document.querySelector('.ask-sheet.close-sheet')) return
  const wrap = document.createElement('div')
  wrap.className = 'sheet ask-sheet close-sheet'
  wrap.innerHTML = `<div class="sheet-card ask-card" role="dialog" aria-modal="true">
    <h2>关闭橙子音乐</h2>
    <p class="ask-msg">收起主面板音乐不会停；彻底退出才会停止播放。</p>
    <div class="ask-choices">
      <button class="ask-choice" data-close="tray">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v9.2H4z"/><path d="M2.6 18.2h18.8"/><path d="M12 9.4v5.6"/></svg>
        <b>最小化到托盘</b><small>音乐继续播放，点托盘图标可再打开</small>
      </button>
      <button class="ask-choice danger" data-close="quit">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.4v8.2"/><path d="M6.2 7.4a7.4 7.4 0 1 0 11.6 0"/></svg>
        <b>退出软件</b><small>完全关闭橙子音乐，停止播放</small>
      </button>
    </div>
    <label class="ask-remember"><input type="checkbox" id="askRemember"> 记住我的选择，不再询问<small>之后可在「设置 → 外观与桌面 → 关闭按钮」修改</small></label>
    <div class="btn-row end"><button class="btn small" data-close="cancel">取消</button></div>
  </div>`
  document.body.appendChild(wrap)
  const done = (action) => {
    document.removeEventListener('keydown', onKey, true)
    const remember = !!wrap.querySelector('#askRemember')?.checked
    wrap.remove()
    if (action === 'cancel') return
    window.orangeWindow?.answerClose?.(action, remember)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); done('cancel') }
    else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done('tray') }
  }
  wrap.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => done(b.dataset.close) })
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done('cancel') })
  document.addEventListener('keydown', onKey, true)
  setTimeout(() => wrap.querySelector('[data-close="tray"]')?.focus(), 40)
}

function openRowMoreMenu(anchor, key) {
  const t = findTrack(key); const liked = S.favorites.some((x) => x.key === key)
  const inPl = S.page?.source?.type === 'playlist'
  // 删除只保留在自建歌单页；推荐歌单 / 收藏歌单 / 喜欢等列表不再提供「删除」
  const removable = inPl
  const addSub = [
    ...S.playlists.map((p) => ({ label: `${p.name}（${p.tracks?.length || 0} 首）`, onClick: () => mergeIntoPlaylist(p, [key]) })),
    { sep: true },
    { label: '新建歌单…', onClick: async () => {
      const name = await askText('新建歌单', '给歌单起个名字')
      if (!name) return
      S.pickKeys = [key]
      await createPlaylistWithKeys(name)
    } },
  ]
  const moveSub = inPl
    ? S.playlists.filter((p) => p.id !== S.page.source.id).map((p) => ({
        label: p.name,
        onClick: async () => {
          await removeFromPlaylist(S.page.source.id, key)
          await mergeIntoPlaylist(p, [key])
          toast(`已移动到「${p.name}」`)
        },
      }))
    : []
  openCtxMenu(anchor, [
    { label: '播放', icon: MI.play, onClick: () => t && playTrack(t) },
    { label: '下一首播放', icon: MI.next, onClick: () => playNextOf(key) },
    { label: '播放相似单曲', icon: MI.similar, onClick: () => playSimilarOf(t) },
    { sep: true },
    { label: '我喜欢', icon: liked ? MI.heartOn : MI.heart, onClick: () => toggleLikeKey(key) },
    { label: '添加到', icon: MI.add, arrow: true, sub: addSub },
    { label: '移动到', icon: MI.move, arrow: true, disabled: !inPl || !moveSub.length, sub: moveSub },
    ...(removable ? [{ sep: true }, { label: '删除', icon: MI.trash, danger: true, onClick: () => removeFromContext(key) }] : []),
  ])
}

// 从当前所在列表移除歌曲：歌单详情页 → 从歌单删；「我喜欢」页 → 从收藏删；其他列表不支持。
async function removeFromContext(key) {
  if (S.page?.source?.type === 'playlist') return removeFromPlaylist(S.page.source.id, key)
  if (S.libTab === '我喜欢') {
    S.favorites = S.favorites.filter((x) => x.key !== key)
    if (S.cloud) await saveFavorites().catch(() => {})
    render(); return toast('已从我喜欢移除')
  }
  toast('当前列表不支持删除')
}

// 列表行：批量模式下才显示勾选框，平时显示序号（默认不多选）。
// tracks 与 S.batchTracks 对应。
const rowsHtml = (tracks, opt = {}) => {
  const { showReason = false, selectable = false, addable = true, removable = false, nohead = false } = opt
  const picking = selectable && !!S.pickMode
  if (!tracks.length) return '<div class="empty">暂无内容。配置授权音源或导入歌单后自动填充。</div>'
  indexTracks(tracks)
  // QQ 音乐式表头：歌曲 / 歌手 / 专辑 / 时长；小屏由 CSS 收起专辑与歌手列
  // 批量模式下表头左侧换成「全选 + 已选中 N 首」（参考图：圆圈全选在歌名列位置）
  const allPicked = tracks.length > 0 && tracks.every((t) => t.key && S.picked.has(t.key))
  const head = nohead ? '' : `<div class="list-head${picking ? ' picking' : ''}"${picking ? '' : ' aria-hidden="true"'}>
    ${picking
      ? `<span class="lh-pick"><input type="checkbox" class="pick" data-pickall ${allPicked ? 'checked' : ''} aria-label="全选"></span>
         <span class="lh-sum">全选<i>|</i>已选中 ${S.picked.size} 首</span><span></span><span class="lh-al">专辑</span><span>时长</span><span></span>`
      : '<span></span><span></span><span>歌曲</span><span>歌手</span><span class="lh-al">专辑</span><span>时长</span><span></span>'}
  </div>`
  return `${head}<div class="rows">${tracks.map((t, i) => {
    const on = t.key && S.favorites.some((x) => x.key === t.key)
    return `<div class="row${picking ? ' has-pick' : ''}${t.key && t.key === S.current?.key ? ' playing' : ''}" data-key="${esc(t.key)}" data-pt="${Number(t.pubTime) || 0}">
        ${picking
          ? `<input type="checkbox" class="pick" data-pick="${esc(t.key)}" ${S.picked.has(t.key) ? 'checked' : ''} aria-label="选择 ${esc(t.title)}">`
          : `<span class="idx">${i + 1}</span>`}
        <div class="cover tiny">${coverHtml(t)}</div>
        <div class="row-main"><div class="t">${esc(t.title)}</div>${showReason && t.reason ? `<div class="reason">${esc(t.reason)}</div>` : ''}</div>
        <span class="a" data-artist="${esc(t.artist)}" title="搜索该歌手">${esc(t.artist)}</span>
        <span class="al" data-album="${esc(t.albumName || '')}" data-albumartist="${esc(t.artist || '')}" title="搜索该专辑">${esc(t.albumName || '')}</span>
        <span class="d">${mmss(t.durationMs)}</span>
        <div class="row-tools">
          <button class="icon-btn row-heart${on ? ' on' : ''}" data-rowheart="${esc(t.key)}" title="喜欢">${HEART_SVG(on)}</button>
          <button class="icon-btn" data-rowmore="${esc(t.key)}" title="更多">⋯</button>
        </div>
      </div>`}).join('')}</div>`
}

// 批量勾选后同步表头「全选 | 已选中 N 首」与全选框（音乐库 / 榜单页共用）
function syncPickBadges() {
  const sum = document.querySelector('.orange-th-sum')
  if (sum) sum.innerHTML = `全选<i>|</i>已选中 ${S.picked.size} 首`
  const pa = document.querySelector('[data-pickall]')
  if (pa) {
    const total = S.batchTracks?.length || 0
    pa.checked = total > 0 && S.picked.size >= total
  }
}

// 批量勾选计数（多选模式下的「已选 N 首 · 全选 · 清除」）
const pickCountHtml = (total) => (S.picked.size
  ? `已选 ${S.picked.size} 首 · <button class="link" data-batch="pickall">全选</button> · <button class="link" data-batch="clear">清除</button>`
  : `共 ${total} 首 · 勾选歌曲后可批量播放 / 加歌单 / 收藏`)

// 列表动作区（1:1 对齐 QQ 参考图）：「播放 / 批量 / 收藏歌单」与右侧搜索框同一行同一高度。
// 进入批量后整条换成操作条（参考图）：播放 / 添加 / 删除（仅自建·收藏歌单）… 右侧「退出批量操作」
const BATCH_ICO = {
  play: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5.6v12.8M5.6 12h12.8"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M8.2 7V4.8h7.6V7"/><path d="M6.6 7l.9 12.2h9l.9-12.2"/></svg>',
}
const listActionsHtml = (tracks, { selectable = false, mine = false, del = false, search = false, favpl = null } = {}) => {
  if (!tracks.length) return ''
  if (selectable && S.pickMode) {
    return `<div class="list-actions batch-bar">
      <button class="act-pill" data-batch="play">${BATCH_ICO.play}播放</button>
      <button class="act-pill" data-batch="add">${BATCH_ICO.add}添加</button>
      ${del ? `<button class="act-pill danger" data-batch="del">${BATCH_ICO.del}删除</button>` : ''}
      <span class="la-flex"></span>
      <button class="act-pill" data-batch="pickdone">退出批量操作</button>
    </div>`
  }
  return `<div class="list-actions">
  <button class="act-pill" data-batch="play">${BATCH_ICO.play}播放</button>
  <button class="act-pill" data-batch="picktoggle"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h10"/><path d="m15.4 5.4 1.4 1.4 2.6-2.6"/></svg>批量</button>
  ${favpl ? `<button class="act-pill${favRecOf(favpl) ? ' on' : ''}" data-favpl="${esc(favpl)}">${favRecOf(favpl) ? '已收藏' : '收藏歌单'}</button>` : ''}
  <span class="la-flex"></span>
  ${search
    ? `<span class="la-search"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m19.5 19.5-3.4-3.4"/></svg><input class="la-search-input" id="plSearchInput" placeholder="搜索歌单内歌曲" value="${esc(S.pageQuery || '')}"></span>`
    : `<span class="la-count">共 ${tracks.length} 首</span>`}
</div>`
}

const cardsHtml = (tracks, cls = 'grid') => !tracks.length
  ? '<div class="empty">暂无内容</div>'
  : `<div class="${cls}">${tracks.map((t) => `
      <div class="card" data-play="${esc(t.key)}">
        <div class="cover">${coverHtml(t)}</div>
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-sub">${esc(t.artist)}${t.reason ? ' · ' + esc(t.reason) : ''}</div>
      </div>`).join('')}</div>`

const tabsHtml = (tabs, active, group) => `<div class="tabs">${tabs.map((t) => `<button class="tab" data-tab="${t}" data-group="${group}" aria-selected="${t === active}">${t}</button>`).join('')}</div>`

const head = (title, sub = '', action = '') => `<div class="section-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${action}</div>`
const pageBar = (crumb = '') => `<div class="page-bar"><button class="btn small ghost" data-back>‹ 返回</button><span class="crumb">${esc(crumb)}</span></div>`

// 榜单封面卡：一个榜一张卡，固定展示该榜第一首歌（不轮播）。
// 点封面 → 该榜歌曲列表页；右下角 ▶ → 直接播放全部。
// 记住每张封面卡上次成功显示的图片：后台预热换成新曲目、而新曲目封面还没解析出来时，
// 继续用旧封面，避免「鼠标一划过 / 数据一刷新，封面就变成渐变块」。
const coverMemory = new Map()
const chartCardHtml = (c) => {
  // 预热是渐进的：有些榜已经写进整池缓存但还没回填到界面 Map，这里直接读整池，
  // 保证「全部榜单」48 张卡一打开就都有封面，而不是一半灰块等半天。
  const poolList = S.core?.chartTracks?.cachedTracks?.(c.id) || []
  const list = S.chartTracks.get(c.id)?.length ? S.chartTracks.get(c.id) : poolList
  const first = list[0]
  const fresh = first ? cachedCover(first) : ''
  const url = fresh || coverMemory.get(c.id) || ''
  if (fresh) coverMemory.set(c.id, fresh)
  const total = c.total || Math.min(poolList.length || list.length, CHART_MAX)
  return `<div class="cc" data-cc="${esc(c.id)}">
    <div class="cc-cover" data-chartopen="${esc(c.id)}" title="打开「${esc(c.name)}」歌曲列表">
      ${url
        ? `<img data-ccimg src="${esc(url)}" alt="" decoding="async" data-ckey="${esc(first?.key || c.id)}">`
        : `<span class="cover-fallback" data-hue="${hueOf(c.name)}" data-ck="${esc(first?.key || c.id)}">▤</span>`}
      <span class="cc-count">${total ? `${total} 首` : '载入中'}</span>
      <span class="cc-now" data-ccnow>${first ? esc(first.title) : ''}</span>
      <span class="cc-play" data-playchart="${esc(c.id)}" role="button" title="播放整榜">▶</span>
    </div>
    <div class="cc-title" data-chartopen="${esc(c.id)}">${esc(c.name)}</div>
    <div class="cc-sub">${esc(c.genre)}${list.length ? '' : ' · 载入中'}</div>
  </div>`
}

// 同一张封面不相邻：卡片列表（榜单 / 歌单）先按封面做「交错」，避免两三个同图卡片排在一起，
// 看起来像重复内容。封面缺失时退回标题做区分。
const coverKeyOf = (p) => String(p?.__cover || p?.cover || p?.title || p?.name || '')
  .replace(/\?.*$/, '').replace(/\/\d+(\?|$)/, '/').toLowerCase()
function spreadByCover(list = []) {
  const pool = (list || []).slice()
  const out = []
  while (pool.length) {
    const last = out[out.length - 1]
    const lastCover = last ? coverKeyOf(last) : ''
    const lastSrc = last ? (last.source || '') : ''
    // 优先级：封面不同 + 平台不同 > 封面不同 > 只能重复
    let idx = pool.findIndex((x) => coverKeyOf(x) !== lastCover && (x.source || '') !== lastSrc)
    if (idx < 0) idx = pool.findIndex((x) => coverKeyOf(x) !== lastCover)
    if (idx < 0) idx = 0
    out.push(pool.splice(idx, 1)[0])
  }
  return out
}

// 榜单卡按「该榜第一首歌的封面」做同样的错位处理
const chartCoverKey = (c) => {
  const list = S.chartTracks.get(c.id)?.length ? S.chartTracks.get(c.id) : (S.core?.chartTracks?.cachedTracks?.(c.id) || [])
  const first = list[0]
  return coverKeyOf({ __cover: first ? cachedCover(first) : '', title: c.name })
}
function spreadCharts(charts = []) {
  const pool = charts.slice()
  const out = []
  while (pool.length) {
    const last = out[out.length - 1]
    const lastKey = last ? chartCoverKey(last) : ''
    let idx = pool.findIndex((c) => chartCoverKey(c) !== lastKey)
    if (idx < 0) idx = 0
    out.push(pool.splice(idx, 1)[0])
  }
  return out
}

const ccGrid = (charts) => `<div class="cc-grid">${spreadCharts(charts).map(chartCardHtml).join('')}</div>`

// 板块 + 榜单封面卡（首页全部榜单页 / 乐馆排行榜共用）
const boardsCoverHtml = (groups) => groups.map((g) => `
  <div class="board-group">
    <div class="board-head"><h2>${esc(g.name)}</h2><span class="board-hint">${esc(g.hint)}</span><span class="board-count">${g.charts.length} 榜 · 智能匹配</span></div>
    ${ccGrid(g.charts)}
  </div>`).join('')

// 推荐歌单 / 热门歌手卡片：真实数据 + 智能排序，卡片上标出排序依据。
// 乐馆「歌手」Tab：各大榜单上榜频次 TOP50，带名次、圆形头像。
const rankedArtistHtml = (a, rank) => `<button class="card rec-card artist ranked" data-artist="${esc(a.name)}">
  <span class="artist-rank">${rank}</span>
  <div class="cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(a.name)}">♪</span>`}</div>
  <div class="card-title">${esc(a.name)}</div>
  <div class="card-sub">${esc(a.reason || '')}</div>
</button>`

// ---- 歌单收藏 ----
// 收藏只存「引用」：本地记一条 fav 记录（name / cover / ref），点开时仍按 ref.id 去平台取真实曲目，
// 不复制曲目、不伪造数据；取消收藏就是把这条引用删掉。这样收藏夹不会随平台改版失真。
const favRecOf = (plId) => S.playlists.find((p) => p.fav && p.ref && p.ref.id === plId)
const favStarSvg = (on) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.7l2.55 5.16 5.7.83-4.12 4.02.97 5.68L12 16.71l-5.1 2.69.97-5.68L3.75 9.7l5.7-.83z"/></svg>`
const favBtnHtml = (plId) => {
  const on = !!favRecOf(plId)
  return `<span class="pl-fav-btn${on ? ' on' : ''}" data-favpl="${esc(plId)}" role="button" tabindex="0"
    title="${on ? '取消收藏' : '收藏歌单'}" aria-label="${on ? '取消收藏' : '收藏歌单'}">${favStarSvg(on)}</span>`
}
// 歌单卡注册表：data-pl 存渲染期唯一 key，点击时直接取「这张卡对应的歌单对象」
// 传给 openRecommendPlaylist，不再靠 id 去数组里 find —— 聚合数据里若残留同 id 的两条
// （多通道来源），find 永远命中靠前那条，就会「点右边的歌单却载入左边的」。
const plCardMap = new Map()
let plCardSeq = 0
function plCardKey(p) {
  const k = `p${++plCardSeq}`
  plCardMap.set(k, p)
  return k
}
const recPlaylistHtml = (p) => `<button class="card rec-card" data-pl="${plCardKey(p)}">
  <div class="cover">${p.cover ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="cover-fallback" data-hue="212">♫</span>'}</div>
  ${favBtnHtml(p.id)}
  <div class="card-title">${esc(p.title)}</div>
  <div class="card-sub">${esc(p.reason || '')}</div>
</button>`
const myPlaylistHtml = (p) => `<div class="card rec-card mypl-card">
  <button class="card-hit" data-mypl="${esc(p.id)}" title="打开「${esc(p.name)}」">
    <div class="cover">${p.tracks?.[0]?.cover ? `<img src="${esc(p.tracks[0].cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(p.name)}">♪</span>`}</div>
    <div class="card-title">${esc(p.name)}</div>
    <div class="card-sub">自建歌单 · ${p.tracks?.length || 0} 首</div>
  </button>
  <button class="pl-del" data-delpl="${esc(p.id)}" title="删除歌单" aria-label="删除歌单「${esc(p.name)}」">✕</button>
</div>`
// 收藏的歌单：卡片主体直接开平台歌单，右上角星标取消收藏
const favPlaylistHtml = (p) => `<div class="card rec-card mypl-card fav-pl-card">
  <button class="card-hit" data-favopen="${esc(p.id)}" title="打开「${esc(p.name)}」">
    <div class="cover">${p.cover ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(p.name)}">♫</span>`}</div>
    <div class="card-title">${esc(p.name)}</div>
    <div class="card-sub">${esc(p.platform || '平台歌单')} · 收藏</div>
  </button>
  ${favBtnHtml(p.ref?.id || p.id)}
</div>`
// 搜索结果排序：最新发行的排最前，最早（或查不到发行时间）的排最后。
// pubTime 为毫秒时间戳；Array.sort 是稳定排序，同时间/无时间的保留聚合原顺序。
const sortByNewest = (list = []) => [...list].sort((a, b) => (Number(b.pubTime) || 0) - (Number(a.pubTime) || 0))
const artistIn = (artist, name) => {
  const a = String(artist || '').toLowerCase(), n = String(name || '').toLowerCase()
  return !!n && (a.includes(n) || n.includes(a))
}
const albumIn = (album, name) => String(album || '').toLowerCase().includes(String(name || '').toLowerCase())

// 搜索结果里的歌手 / 专辑：从曲目的 artist（可能 "A / B"）/ album 反推，去掉重复并统计出现次数。
function searchArtistCards() {
  const map = new Map()
  for (const t of S.searchResults) {
    for (const raw of String(t.artist || '').split(/[\/、,，&;；]/)) {
      const name = raw.trim()
      if (!name || name === '未知艺人') continue
      const hit = map.get(name) || { key: name, title: name, cover: '', count: 0 }
      if (!hit.cover) hit.cover = artistPhoto(name) || cachedCover(t)
      hit.count += 1
      map.set(name, hit)
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}
function searchAlbumCards() {
  const map = new Map()
  for (const t of S.searchResults) {
    const name = String(t.album || '').trim()
    if (!name) continue
    const hit = map.get(name) || { key: name, title: name, artist: t.artist, cover: '', count: 0 }
    if (!hit.cover) hit.cover = cachedCover(t)
    hit.count += 1
    map.set(name, hit)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}
const entityCardHtml = (x, attr, sub) => `<button class="card rec-card entity" data-${attr}="${esc(x.key)}"${attr === 'album' ? ` data-albumartist="${esc(x.artist || '')}"` : ''}>
  <div class="cover${attr === 'artist' ? ' round' : ''}">${x.cover
    ? `<img src="${esc(x.cover)}" alt="" loading="lazy" decoding="async">`
    : `<span class="cover-fallback" data-hue="${hueOf(x.key)}">${attr === 'artist' ? '♪' : '▤'}</span>`}</div>
  <div class="card-title">${esc(x.title)}</div>
  <div class="card-sub">${esc(sub)}</div>
</button>`

const recArtistHtml = (a) => `<button class="card rec-card artist" data-artist="${esc(a.name)}">
  <div class="cover round">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(a.name)}">♪</span>`}</div>
  <div class="card-title">${esc(a.name)}</div>
  <div class="card-sub">${esc(a.reason || '')}</div>
</button>`

const stripHtml = (tracks) => !tracks.length
  ? `<div class="empty">正在准备推荐… <button class="link" data-demo>先试听一首（${esc(DEMO_TRACK.title)} · ${esc(DEMO_TRACK.artist)}）</button></div>`
  : `<div class="rec-strip">${tracks.map((t) => `
      <button class="strip-item" data-play="${esc(t.key)}" title="${esc(t.title)}">
        <div class="cover">${coverHtml(t, { eager: true })}</div>
      </button>`).join('')}</div>`

const allTracks = () => [...S.queue, ...S.searchResults, ...(S.recommend?.tracks || []), ...S.favorites,
  ...S.recent, ...S.localTracks, ...(S.page?.tracks || []), ...allChartTracks()]
// 渲染期缓存：把当前页面真正展示出来的曲目按 key 登记，列表行内的红心/更多/添加到
// 不再依赖「曲目是否在播放队列里」。修复「非当前播放的歌点按钮没反应」（findTrack 在队列外拿不到 track）。
const trackIndex = new Map()
const indexTracks = (arr) => { for (const t of (arr || [])) if (t && t.key) trackIndex.set(t.key, t) }
const pool = () => S.searchResults.length ? S.searchResults : (S.recommend?.tracks || [])

// 封面回填：把页面里带 data-ck 的占位批量换成真实封面（并发受控 + 本地缓存）。
// 上游封面接口偶发 503，所以占位还留着时补跑一到两轮，避免主页出现空白格子。
let coverRetryTimer
async function hydrateCovers(attempt = 0) {
  if (!S.core?.covers) return
  const nodes = [...document.querySelectorAll('[data-ck]')].filter((n) => n.dataset.ck && !n.dataset.busy)
  if (!nodes.length) return
  const byKey = new Map(allTracks().map((t) => [t.key, t]))
  nodes.forEach((n) => { n.dataset.busy = '1' })
  const keys = [...new Set(nodes.map((n) => n.dataset.ck))]
  const tracks = keys.map((k) => byKey.get(k)).filter(Boolean)
  const filled = await S.core.covers.fillCovers(tracks, { force: attempt > 0 })
  for (const n of nodes) {
    if (!n.isConnected) continue
    const t = byKey.get(n.dataset.ck)
    if (!t) { delete n.dataset.busy; continue }
    const url = filled.get(n.dataset.ck) || S.core.covers.coverOf(t)
    if (!url) { delete n.dataset.busy; continue }
    t.cover = url
    const img = document.createElement('img')
    img.src = url; img.alt = ''; img.decoding = 'async'
    img.dataset.ckey = t.key || ''
    n.replaceWith(img)
  }
  // 封面同步：列表页解析出的封面同步给播放队列与当前曲——否则歌单页有封面、
  // 播放页 / 播放条还是占位（队列副本是按 key 复制的另一份对象，不会自动拿到）。
  if (filled.size) {
    let dirty = false
    for (const [k, url] of filled) {
      if (!url) continue
      for (const q of (S.queue || [])) {
        if (q.key === k && !q.cover) { q.cover = url; if (S.current === q) dirty = true }
      }
      if (S.current?.key === k && !S.current.cover) { S.current.cover = url; dirty = true }
    }
    if (dirty) { try { updatePlayerBar() } catch { /* 核心未就绪 */ } }
  }
  const left = document.querySelectorAll('#view [data-ck]').length
  if (left && attempt < 2) {
    clearTimeout(coverRetryTimer)
    coverRetryTimer = setTimeout(() => hydrateCovers(attempt + 1), 1800 + attempt * 1800)
  }
}

// 榜单封面卡不轮播：每张卡固定展示该榜第一首歌的封面与歌名。
// 这样不同榜单的冠军位一目了然，也不会因为整页重绘把定时器饿死或反复换图费流量。
// 曲目仍会在后台预热补齐，只是不再自动切换。

// 榜单曲目预热：没有曲目的榜才拉，限并发。每回来一批就重绘一次（渐进出现，不用等全部）。
// 用「在途集合」去重而不是时间节流——之前的时间窗口会把首次请求直接丢掉，导致整页停在载入中。
let flushTimer
const warming = new Set()
async function warmCoverTracks(charts = [], limit = 10) {
  if (!S.core || !charts.length) return
  // 10 分钟新鲜度：内存里已有曲目但超过 10 分钟也要重取，封面才会跟着实时榜更新
  const staleMs = 10 * 60 * 1000
  const stale = (c) => !S.chartTracks.get(c.id)?.length || Date.now() - (S.chartAt.get(c.id) || 0) > staleMs
  const missing = charts.filter((c) => stale(c) && !warming.has(c.id) && S.core.chartTracks.canFillTracks(c))
  if (!missing.length) return
  missing.forEach((c) => warming.add(c.id))
  S.lanesBusy = true
  const flush = () => { if (S.page?.kind === 'list') return; render() }
  try {
    await S.core.chartTracks.warmCharts(missing, {
      limit,
      concurrency: 8,
      // 卡片封面要跟着实时榜单走：缓存 10 分钟就重新取一次，
      // 而不是沿用 30 分钟的旧缓存（否则「首页封面不变，点开才更新」）。
      maxAge: 10 * 60 * 1000,
      onEach: (id, tracks) => {
        S.chartTracks.set(id, tracks); bumpChartPool()
        S.chartAt.set(id, Date.now())
        clearTimeout(flushTimer)
        flushTimer = setTimeout(flush, 900)
      },
    })
  } catch { /* 单榜失败不影响其它 */ }
  S.lanesBusy = false
  missing.forEach((c) => warming.delete(c.id))
  clearTimeout(flushTimer)
  if (missing.some((c) => S.chartTracks.get(c.id)?.length)) flush()
}

// ---- 电台：把每个台当成一个「虚拟榜单」，复用封面卡 / 轮播 / 列表页那一套 ----
const RADIO_PREFIX = 'radio:'
const radioKeyOf = (r) => `${RADIO_PREFIX}${r.id}`
const radioChartOf = (r) => ({ id: radioKeyOf(r), name: r.name, genre: r.desc, tags: [], total: 100 })
const isRadioId = (id) => String(id || '').startsWith(RADIO_PREFIX)
const radioOf = (id) => RADIO_STATIONS.find((r) => radioKeyOf(r) === String(id || ''))

// ★ 不再做「借一张封面先铺上」的种子逻辑。
// 旧实现用 peekPool（未排序的原始池）铺卡片，warm 时换成 arrange 过的 6 首，
// 点开电台又重新取 100 首再排一次序 —— 三次的第一首都不同，用户看到的就是
// 「旅游台封面是周杰伦-爱在西元前，一打开变成风子-你必须在一个荒唐的夜…」。
// 现在：每台只在后台一次性取满 100 首真实曲目，卡片与详情页永远共用这一份。
function seedRadioCovers() { /* 保留空函数以兼容旧调用点：占位封面已被移除 */ }

async function warmRadio(_limit = 100, { force = false } = {}) {
  if (!S.core?.genrePool) return
  // force = 定时实时刷新：清掉「已预热」标记，并让曲库强制回源重取，不再吃旧缓存
  if (force) S.radioReal.clear()
  const todo = RADIO_STATIONS.filter((r) => !S.radioReal.has(r.id))
  if (!todo.length || S.radioBusy) return
  S.radioBusy = true
  const fill = async (r) => {
    // 一次性取满 100 首：卡片封面 = tracks[0]，详情页 = 同一份 tracks，点开不会再变
    const tracks = await S.core.genrePool.stationTracks(r, { limit: 100, deep: false, force }).catch(() => [])
    if (!tracks.length) return
    S.chartTracks.set(radioKeyOf(r), tracks); bumpChartPool()
    S.radioReal.add(r.id)
  }
  try {
    // 每批 2 台、批间留间隔：原来 5 台并行会同时拉 500 首曲目 + 500 张封面，
    // 启动瞬间直接把一个 CPU 核打满（用户感知就是「占用过大」）。分批后前台依旧有封面，
    // 但峰值降下来，也不和首屏渲染 / 音频缓冲抢资源。
    for (let i = 0; i < todo.length; i += 2) {
      await Promise.all(todo.slice(i, i + 2).map(fill))
      if (S.section === 'hall' && S.hallTab === '电台' && !S.page) render()
      await new Promise((r) => setTimeout(r, 350))
    }
    S.radioAt = Date.now()
  } finally { S.radioBusy = false }
}

// 电台实时性：启动就后台预热全部频道，之后每 20 分钟强制回源刷新一次。
// 以前只在进入「电台」tab 时才 warm，也没法自己更新，用户必须先点开歌单才看到新封面。
let radioTimer = null
function startRadioAutoRefresh() {
  if (!S.core?.genrePool) return
  warmRadio(100).catch(() => {})
  clearInterval(radioTimer)
  radioTimer = setInterval(() => {
    if (document.hidden) return          // 最小化 / 隐藏时不抢带宽
    warmRadio(100, { force: true }).catch(() => {})
  }, 20 * 60 * 1000)
}

async function openRadio(id) {
  const r = radioOf(id)
  if (!r) return toast('电台不存在')
  const key = radioKeyOf(r)
  const cached = S.chartTracks.get(key) || []
  openListPage({
    title: r.name,
    sub: `${r.desc} · 同类型热门 · ${cached.length || 100} 首`,
    cover: cached[0] ? cachedCover(cached[0]) : '',
    tracks: cached,
    loading: cached.length < 30,
    from: S.section === 'home' ? 'home' : 'hall',
    source: { type: 'radio', id: r.id },
  })
  // ★ 预热好的 100 首直接展示，绝不重新取链 / 重新排序 —— 这正是「打开后封面和第一首变了」的来源。
  if (cached.length >= 30) return
  // 只有预热还没跑完（缓存为空）才回源补一次，并与卡片共用这一份
  const tracks = await S.core.genrePool.stationTracks(r, { limit: 100, deep: false }).catch(() => [])
  if (!tracks.length) return
  S.chartTracks.set(key, tracks); bumpChartPool()
  S.radioReal.add(r.id)
  if (S.page?.source?.type === 'radio' && S.page.source.id === r.id) {
    S.page.tracks = tracks
    S.page.cover = tracks[0] ? cachedCover(tracks[0]) : ''
    S.page.loading = false
    S.page.sub = `${r.desc} · ${tracks.length} 首 · 按全网热度排序`
    render()
  }
}

async function playRadio(id) {
  const r = radioOf(id)
  if (!r) return
  const key = radioKeyOf(r)
  let tracks = S.chartTracks.get(key) || []
  // 与卡片封面共用同一份预热结果；只有完全没预热到时才补取，避免「播放全部」后首曲又变
  if (tracks.length < 30) {
    const more = await S.core.genrePool.stationTracks(r, { limit: 100, deep: false }).catch(() => [])
    if (more.length) { tracks = more; S.chartTracks.set(key, more); bumpChartPool(); S.radioReal.add(r.id) }
  }
  if (!tracks.length) return toast(`「${r.name}」暂时取不到曲目，检查网络后重试`)
  playList(tracks, 0, `「${r.name}」`)
}

// 默认测试曲：验证「搜索 → 取链 → 播放」这条链路是否通（设置页和空白首页都用它）
async function playDemo() {
  if (!S.core) return toast('正在初始化，请稍候')
  toast(`正在解析测试曲：${DEMO_TRACK.title} · ${DEMO_TRACK.artist}`)
  try {
    const rows = await S.core.sources.searchAll(DEMO_TRACK.query)
    const hit = rows.find((r) => String(r.singer || r.artist || '').includes(DEMO_TRACK.artist)) || rows[0]
    if (!hit) return toast(PLAY_FAIL, true)
    await playTrack(rowToTrack(hit), 0)
  } catch (e) {
    toast(PLAY_FAIL, true)
  }
}

// ---- 板块渲染 ----
// 视图层统一清洗：已经保存到「我喜欢 / 最近播放 / 自建歌单」里的旧数据
// 同样可能有伴奏、Remix、片段或串歌条目（以前导入歌单会退而取搜索第一条）。
// 每次渲染前把这些条目挡在界面之外；关掉「只听正式发行版」开关会重新读一遍云端状态，
// 原数据并没有被删掉。
function scrubForOfficial() {
  // 不再破坏性覆盖 S.favorites / S.recent / S.playlists[].tracks。
  // 旧实现每次 render 都把「非原版」条目从源数组里删掉，后续落盘时这些歌就真丢了，
  // 关掉「只听正式发行版」也恢复不回来 —— 正是用户反复反馈的「开关没效果」。
  // 现在过滤统一放在展示层：iosNormList（服务端数据）/ iosLibSource（我的音乐）/ 搜索。
}

async function render() {
  // 每次重建视图前清空歌单卡注册表：旧 DOM 的 key 随之失效，Map 也不会无限增长
  plCardMap.clear()
  plCardSeq = 0
  scrubForOfficial()
  const v = $('#view')
  try {
    if (S.page?.kind === 'list') v.innerHTML = listPageHtml()
    else if (S.page?.kind === 'allcharts') v.innerHTML = allChartsHtml()
    // iOS 的主界面就是播放页（覆盖在 main 上），home/hall 不再往 main 里渲染列表；
    // 「听你想听」只在左侧抽屉（#iosDrawer）里出现，避免同一份内容渲染两遍。
    else if (S.section === 'home') {
      if (IS_IOS) {
        // iOS 不再用侧边抽屉：首页就是 Music 页 / 乐库页，由 S.iosView 决定
        v.innerHTML = S.iosView === 'lib' ? iosLibraryShowHtml() : S.iosView === 'music' ? iosMusicPageHtml() : ''
        iosMountDrawer()
      } else v.innerHTML = homeHtml()
    }
    else if (S.section === 'hall') { v.innerHTML = IS_IOS ? '' : hallHtml(); if (IS_IOS) iosMountDrawer() }
    else if (S.section === 'search') v.innerHTML = searchHtml()
    else if (S.section === 'peak' || S.section === 'rise') v.innerHTML = orangeChartPageHtml()
    else if (S.section === 'charts') v.innerHTML = allChartsHtml()
    else if (S.section === 'library') v.innerHTML = IS_IOS
      ? (S.iosLib ? iosLibPageHtml() : iosMineHtml())
      : await libraryHtml()
    else if (S.section === 'settings') v.innerHTML = settingsHtml()
    else if (S.section === 'about') v.innerHTML = aboutPageHtml()
    else if (S.section === 'source') v.innerHTML = sourcePageHtml()
  } catch (e) {
    console.error('[render]', e)
    v.innerHTML = `<div class="empty">页面渲染失败：${esc(e.message)}<br>可以点左侧「首页」重试。</div>`
  }
  bindView()
  paintDynamics(v)
  hydrateCovers()
  // 换页时回到顶部（同一页的数据回填不打断阅读位置）
  const key = [S.section, S.hallTab, S.libTab, S.searchTab, S.page ? `${S.page.kind}:${S.page.source?.id || S.page.id || ''}` : ''].join('|')
  if (key !== S.viewKey) { S.viewKey = key; v.scrollTop = 0 }
  if (S.core?.covers && S.section === 'home' && !S.page) {
    S.core.covers.prefetchCovers([...(S.recommend?.tracks || []).slice(12), ...pool().slice(12)], 24)
  }
  // 音源预加载：当前页面前 5 首的直链先解析好（首页推荐 / 搜索 / 歌单 / 榜单 / 音乐库全覆盖）
  const libTracks = S.libTab === '我喜欢' ? S.favorites
    : S.libTab === '最近播放' ? S.recent
      : S.libTab === '本地歌曲' ? S.localTracks : []
  const visibleTracks = S.page?.kind === 'list' ? S.page.tracks
    : (S.section === 'peak' || S.section === 'rise') ? cpTracks()
      : S.section === 'search' ? S.searchResults
        : S.section === 'library' ? libTracks
          : S.section === 'home' ? (S.recommend?.tracks || [])
            : []
  // 播放中不做整页预取：并发取链会抢音频带宽造成卡顿；
  // 下一首由 maybePrefetchNext() 在播放过半时单独预取。
  if (visibleTracks?.length && !S.playing) schedulePrefetch(visibleTracks)
}

function homeHtml() {
  const payload = S.recommend
  // 推荐异步回填：render() 永不等待网络，首屏始终即时可见。
  // 缓存里的 band（时段档）和当前时间不一致时也重算：早上打开不该还放着深夜那批安静的歌。
  let bandNow = ''
  try { bandNow = S.core?.rec?.periodOf?.()?.id || '' } catch { /* 核心没就绪 */ }
  const stale = !payload || (bandNow && payload.band !== bandNow)
  if (S.cloud && !S.recPending && stale) {
    S.recPending = true
    S.core.rec.refreshRecommend()
      .then((p) => { S.recommend = p; if (S.section === 'home' && !S.page) render() })
      .catch((e) => toast(`推荐暂不可用：${e.message}`))
      .finally(() => { S.recPending = false })
  }
  const tracks = (payload?.tracks?.length ? payload.tracks : allChartTracks()).slice(0, 12)
  const top = S.core ? S.core.charts.topCharts(8, { real: true }) : []
  if (top.length) warmCoverTracks(top, 10)
  if (S.core && !S.discoverBusy && Date.now() - (S.discoverAt || 0) > 60000) {
    S.discoverAt = Date.now()
    S.discoverBusy = true
    loadDiscover().finally(() => { S.discoverBusy = false })
  }
  S.batchTracks = []
  if (IS_WIN) return orangeHomeHtml()
  const now = new Date()
  const hour = now.getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const dateLine = `${now.getMonth() + 1} 月 ${now.getDate()} 日`
  return `
    <div class="home-hero">
      <h1>${greet}</h1>
      <p>${dateLine} · ${payload?.tags?.length ? '偏好：' + payload.tags.join(' · ') : '基于播放 / 完播 / 收藏 / 跳过行为动态更新'}</p>
      <div class="btn-row">
        <button class="btn primary" data-hero="play">▶ 播放实时推荐</button>
        <button class="btn" data-hero="shuffle">⤨ 随机播放</button>
        <button class="btn" data-quick="daily">每日推荐</button>
      </div>
    </div>
    <div class="banner" data-quick="daily">
      <div class="banner-tag">每日推荐</div>
      <h2>听见此刻<br>只属于你的歌单</h2>
      <p>专注听歌 · 授权音源可溯源</p>
      <span class="banner-btn">立即播放 ▶</span>
    </div>
    <div class="quick-grid">${QUICK_ENTRIES.map((q) => `<button class="quick" data-quick="${q.id}"><span class="quick-ico">${q.icon}</span><span>${q.label}</span></button>`).join('')}</div>
    <div class="section-head compact"><div><h2>实时推荐</h2></div><div class="btn-row"><button class="btn small" id="refreshRecBtn">换一批</button><button class="btn small" id="openSourceBtn">音源与音质</button></div></div>
    ${stripHtml(tracks.slice(0, 12))}
    <div class="home-extra">
    <div class="section-head compact"><div><h2>今日榜单</h2><p>每个榜单一张封面 · 固定展示第一首 · 点封面看完整列表</p></div><button class="btn small" id="goChartsBtn">全部榜单 ›</button></div>
    ${top.length ? ccGrid(top) : '<div class="empty">榜单目录加载中…</div>'}
    <div class="section-head compact"><div><h2>推荐歌单</h2><p>按热度 / 口味 / 多样性智能排序 · 打开即显示上次内容</p></div><button class="btn small" id="openImportBtn">导入歌单</button></div>
    ${S.discover.playlists.length
      ? `<div class="grid rec-grid">${S.discover.playlists.map(recPlaylistHtml).join('')}</div>`
      : '<div class="empty">正在聚合各大平台歌单…</div>'}
    <div class="section-head compact"><div><h2>热门歌手</h2><p>各大音乐榜单 TOP 50 · 按上榜频次与热度排序</p></div><button class="btn small" id="goArtistsBtn">全部 ›</button></div>
    ${S.discover.artists.length
      ? `<div class="artist-row">${S.discover.artists.slice(0, 8).map(recArtistHtml).join('')}</div>`
      : '<div class="empty">正在聚合各大平台歌手…</div>'}
    </div>`
}

// ── Windows · 首页（1:1 复刻参考图）──
const fmtPlay = (n) => {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return v ? String(v) : ''
}
// 首页「听『X』的也在听」是 3 列网格：渲染数量必须是 3 的倍数且至少 6 首，
// 否则最后一行会出现空格（用户明确要求「保证 6 首、不能空缺」）。
// 推荐接口有时只回来 3~4 首，这里从榜单缓存 / 发现 / 收藏 / 最近 / 队列 / 搜索结果依次补足到 9 首；
// 按 key +「标题|歌手」双重去重，避免同一首歌占两个格子。
function homeRecTracks(payload) {
  const out = []
  const byKey = new Set()
  const byName = new Set()
  const src = [
    payload?.tracks || [],
    allChartTracks(),
    S.discover?.tracks || [],
    S.favorites || [], S.recent || [], S.queue || [], S.localTracks || [],
    S.searchResults || [], S.page?.tracks || [],
  ]
  for (const arr of src) {
    for (const t of arr) {
      if (out.length >= 9) break
      if (!t?.key || !t?.title || byKey.has(t.key)) continue
      const nk = `${String(t.title).toLowerCase()}|${String(t.artist || '').toLowerCase()}`
      if (byName.has(nk)) continue
      byKey.add(t.key); byName.add(nk); out.push(t)
    }
    if (out.length >= 9) break
  }
  // 极端冷启动（本地几乎没数据）也要凑满 6 首：复用已收集的曲目，
  // 不改 key（点击仍能命中 trackIndex）。正常联网时不会走到这里。
  if (out.length && out.length < 6) {
    const base = out.slice()
    let i = 0
    while (out.length < 6) out.push(base[i++ % base.length])
  }
  // 只渲染整行：9 首（3 行）或 6 首（2 行），永不留半行空格
  return out.length >= 9 ? out.slice(0, 9) : out.slice(0, 6)
}
function orangeHomeHtml() {
  const greet = greetOf()
  const payload = S.recommend
  const tracks = homeRecTracks(payload)
  const playlists = S.discover.playlists.slice(0, 10)
  const heroCards = S.discover.playlists.slice(0, 3)
  // 没有在播的歌时不要拿用户名凑数：退到第一首推荐曲，再退到通用文案。
  const rawName = S.current?.title || (S.discover?.tracks?.[0]?.title) || ''
  const songName = rawName.length > 12 ? rawName.slice(0, 12) + '…' : rawName
  const feat = tracks[0]
  // 问候语与侧栏共用同一个名字来源（readDisplayName），改名后首页立即同步
  const who = S.session ? displayName() : '朋友'
  return `
  <div class="orange-home">
    <section class="orange-block">
      <div class="orange-banner-head">
        <h2 id="homeGreet">Hi ${esc(who)} 今日为你推荐</h2>
      </div>
      <div class="orange-cards">
        <div class="orange-card-col">
          <button class="orange-card orange-card-grad" data-play="${feat ? esc(feat.key) : ''}">
            <div class="orange-card-gradbg"></div>
            <div class="orange-card-gradtext"><h3>${esc(greet.title)}</h3><p>${esc(greet.a)}<br>${esc(greet.b)}</p></div>
            <span class="orange-card-play"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg></span>
            <div class="orange-card-side-img"><img src="${feat && cachedCover(feat) ? esc(cachedCover(feat)) : ''}" alt="" loading="lazy" decoding="async"></div>
          </button>
          <div class="orange-card-cap"><b>${feat ? esc(feat.title) + ' - ' + esc(feat.artist) : 'New day'}</b><span>猜你喜欢·沉浸刷歌</span></div>
        </div>
        ${heroCards.map((p) => `<div class="orange-card-col">
          <button class="orange-card orange-card-img" data-pl="${plCardKey(p)}">
            <div class="orange-card-imgbg">${p.cover ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : ''}</div>
          </button>
          <div class="orange-card-cap"><b>${esc(p.title)}</b><span>${esc(p.reason || '精选歌单')}</span></div>
        </div>`).join('')}
      </div>
    </section>

    <section class="orange-block">
      <div class="orange-sec-head">
        <h2>${songName ? `听『${esc(songName)}』的也在听` : '你可能会喜欢'}</h2>
        <button class="orange-playall-round" data-action="shuffle" title="播放全部" aria-label="播放全部">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg>
        </button>
      </div>
      <div class="orange-song-grid">
        ${tracks.length ? tracks.map((t) => `
          <button class="orange-song" data-play="${esc(t.key)}">
            <div class="orange-song-cover">${coverHtml(t)}<span class="orange-song-playbadge"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg></span></div>
            <div class="orange-song-meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
          </button>`).join('') : '<div class="empty">正在准备推荐…</div>'}
      </div>
    </section>

    <section class="orange-block">
      <div class="orange-sec-head"><h2>你的私荐歌单</h2></div>
      <div class="orange-pl-grid">
        ${playlists.length ? playlists.map((p) => `<button class="orange-pl-card" data-pl="${plCardKey(p)}" title="${esc(p.title)}">
            <div class="orange-pl-cover-big">
              ${p.cover ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="cover-fallback" data-hue="212">♫</span>'}
              ${p.playCount ? `<span class="orange-pl-plays">${fmtPlay(p.playCount)}</span>` : ''}
              ${favBtnHtml(p.id)}
            </div>
            <div class="orange-pl-name">${esc(p.title)}</div>
          </button>`).join('') : '<div class="empty">正在聚合各大音乐平台的歌单…</div>'}
      </div>
    </section>
  </div>`
}

// ── Windows · 巅峰榜 / 飙升榜（版式参考 QQ 音乐榜单详情页：左侧整版封面 + 表格式 TOP 100）──
const ORANGE_CP_CHARTS = {
  peak: { chartId: 'tx_hot', title: '巅峰榜', word: '巅峰', desc: '巅峰热歌 · 全网最热' },
  rise: { chartId: 'tx_soar', title: '飙升榜', word: '飙升', desc: '24 小时涨幅最快' },
}
const cpConf = () => ORANGE_CP_CHARTS[S.section] || null
// 榜单元数据解析：静态目录里的 id 是 `${source}_${boardId}`（例如 tx_tx_hot），
// 以前直接拿 'tx_hot' 去 findChart 永远查不到 → 整榜页一直停在「取不到曲目」。
// 现在按 id 查不到时再按 boardId 兜底；仍查不到就用一份最小元数据直接走 QQ 接口。
function cpChartAt(section) {
  const conf = ORANGE_CP_CHARTS[section]
  if (!conf) return null
  const C = S.core?.charts
  const hit = C?.findChart?.(conf.chartId) || C?.CHARTS_ALL?.find?.((c) => c.boardId === conf.chartId)
  return hit || { id: conf.chartId, no: 0, source: 'tx', platform: 'QQ音乐', name: conf.title,
    boardId: conf.chartId, region: '华语', genre: '流行', tags: [] }
}
const cpChart = () => cpChartAt(S.section)
const cpKey = () => cpChart()?.id || ''
const cpTracks = () => {
  const k = cpKey()
  return k ? (S.chartTracks.get(k) || []) : []
}
// 失败不再「一次就永久放弃」：记时间戳，超过冷却期允许重试（用户手动点重试则立刻清空）
const cpTriedAt = new Map()
const CP_RETRY_MS = 12000
let cpLoading = ''

// 只取一次整榜（100 首）：失败按冷却期重试，避免 render → 重新取 → render 的死循环。
async function loadChartPage(section, { force = false } = {}) {
  if (!ORANGE_CP_CHARTS[section] || cpLoading) return
  const chart = cpChartAt(section)
  if (!chart) return
  const key = chart.id
  if (!force && Date.now() - (cpTriedAt.get(key) || 0) < CP_RETRY_MS) return
  if ((S.chartTracks.get(key) || []).length >= 100) return
  cpTriedAt.set(key, Date.now())
  cpLoading = section
  const before = (S.chartTracks.get(key) || []).length
  try {
    const tracks = await S.core.chartTracks.chartTracks(chart, { limit: 100, force }).catch(() => [])
    if (tracks.length > before) { S.chartTracks.set(key, tracks); S.chartAt.set(key, Date.now()); bumpChartPool() }
    if (tracks.length) schedulePrefetch(tracks)
  } finally {
    cpLoading = ''
    // 重绘一次把「正在载入…」换成结果；重试有 12s 冷却，不会形成 render 死循环
    if (S.section === section && !S.page) render()
  }
}

const cpHeart = (t) => S.favorites.some((x) => x.key === t.key)

// 榜单封面：圆角六边形实心徽章（参考用户给的扁平徽章样式）+ 白色字形 + 榜单名，不去抓平台素材。
const cpCoverSvg = (id) => {
  const defs = id === 'peak'
    ? '<linearGradient id="cpGradPeak" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFC94A"/><stop offset="1" stop-color="#FF7A29"/></linearGradient>'
    : '<linearGradient id="cpGradRise" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#36E2A0"/><stop offset="1" stop-color="#13B8C9"/></linearGradient>'
  const fill = id === 'peak' ? 'url(#cpGradPeak)' : 'url(#cpGradRise)'
  const glyph = id === 'peak'
    ? '<path d="M13 47 L26 27 L34 36 L43 21 L53 47" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M15 47 L49 15" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 15 H49 V31" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>'
  return `<svg viewBox="0 0 64 64" width="138" height="138" xmlns="http://www.w3.org/2000/svg">
    <defs>${defs}</defs>
    <path d="M13 11 H51 L62 32 L51 53 H13 L2 32 Z" fill="${fill}" stroke="${fill}" stroke-width="4" stroke-linejoin="round"/>
    ${glyph}
  </svg>`
}

function orangeChartPageHtml() {
  const conf = cpConf()
  if (!conf) return '<div class="empty">榜单不存在</div>'
  const all = cpTracks()
  const section = S.section
  if (!all.length && !cpLoading) loadChartPage(section)
  const q = (S.pageQuery || '').trim().toLowerCase()
  const tracks = q
    ? all.filter((t) => `${t.title || ''} ${t.artist || ''} ${t.albumName || t.album || ''}`.toLowerCase().includes(q))
    : all
  S.batchTracks = tracks
  const today = new Date()
  const upd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const loading = !all.length
  const list = loading
    ? `<div class="orange-cp-loading">${cpLoading ? '正在载入榜单曲目…' : '榜单暂时取不到曲目 <button class="orange-cp-retry" data-cpretry="1">重新加载</button>'}</div>`
    : `<div class="orange-cp-thead"><span class="orange-cp-th-song">歌曲</span><span>歌手</span><span>专辑</span><span>时长</span></div>
      <div class="orange-cp-list">
        ${tracks.map((t, i) => {
          const on = cpHeart(t)
          const playing = S.current?.key && S.current.key === t.key
          const picked = S.picked.has(t.key)
          return `<div class="orange-cp-row${playing ? ' playing' : ''}${picked ? ' picked' : ''}" data-key="${esc(t.key)}">
            <span class="orange-cp-idx">${S.pickMode
              ? `<input type="checkbox" data-pick data-pickkey="${esc(t.key)}" ${picked ? 'checked' : ''} aria-label="选择">`
              : String(i + 1).padStart(2, '0')}</span>
            <button class="orange-cp-heart${on ? ' on' : ''}" data-cpheart="${esc(t.key)}" title="${on ? '取消喜欢' : '喜欢'}" aria-label="喜欢">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>
            </button>
            <div class="orange-cp-song">
              <button class="orange-cp-name" data-cpplay="${esc(t.key)}" title="播放 ${esc(t.title)}">${esc(t.title)}</button>
            </div>
            <div class="orange-cp-artist" data-artist="${esc(t.artist || '')}" title="搜索该歌手">${esc(t.artist || '未知艺人')}</div>
            <div class="orange-cp-album"${t.albumName ? ` data-album="${esc(t.albumName)}" data-albumartist="${esc(t.artist || '')}" title="搜索该专辑"` : ''}>${esc(t.albumName || t.album || '')}</div>
            <div class="orange-cp-time">${t.durationMs ? mmss(t.durationMs) : '--:--'}</div>
          </div>`
        }).join('')}
      </div>`
  return `<div class="orange-cp">
    <div class="orange-cp-hero">
      <div class="orange-cp-cover orange-cp-cover-${section}">
        ${all[0]?.cover ? `<img class="orange-cp-cover-img" src="${esc(all[0].cover)}" alt="">` : cpCoverSvg(section)}
      </div>
      <div class="orange-cp-meta">
        <h1>${conf.title}</h1>
        <p class="orange-cp-upd">更新时间：${upd} · 共 ${all.length} 首</p>
        ${all.length ? listActionsHtml(tracks, { selectable: true, search: true }) : ''}
      </div>
    </div>
    ${list}
  </div>`
}

// 全部榜单：首页「全部榜单」跳转的独立页面，布局与首页今日榜单一致（板块 + 封面卡）。
function allChartsHtml() {
  const groups = S.core?.charts.groupedBoards() || []
  const all = groups.flatMap((g) => g.charts)
  if (all.length) warmCoverTracks(all, 6)
  S.batchTracks = []
  // 顶层「榜单」导航进入时不带返回栏；从首页点进来（子页）才显示返回首页。
  const bar = (S.section === 'charts' && !S.page) ? head('全部榜单', `${all.length} 个公开榜单 · 按榜名 / 标签 / 地区 / 曲风智能归入 ${groups.length} 个板块`) : pageBar('首页')
  return `${bar}
    ${groups.length ? boardsCoverHtml(groups) : '<div class="empty">榜单目录加载中…（核心尚未就绪）</div>'}`
}

// 乐馆：歌单广场 / 歌手 / 专辑 / 分类歌单 / 电台
const hallNeedDiscover = () => {
  if (!S.core || S.discoverBusy || Date.now() - (S.discoverAt || 0) <= 60000) return
  S.discoverAt = Date.now(); S.discoverBusy = true
  loadDiscover().finally(() => { S.discoverBusy = false })
}

// 歌手名录：只拉一次全量（每条都带 sex + 本地算好的拼音 initial），
// 分类 / 字母 / 搜索全部在 UI 本地过滤。以前按筛选条件分别请求再合并热门歌手，
// 导致「选了 J 却出现孙燕姿」「选了男却混进女歌手」以及新增歌手看不到。
async function loadArtistDir(force = false) {
  if (!S.core?.discover?.artistDirectory) return
  if (!force && S.artistDirKey === 'all') return
  // 空结果 / 网络失败不要每帧重试，20 秒后自动再试，刷新按钮可强制重试
  if (!force && S.artistFailAt && Date.now() - S.artistFailAt < 20000) return
  if (S.artistBusy) return
  const paint = () => { if (S.section === 'hall' && S.hallTab === '歌手' && !S.page) render() }
  // 同步先上屏（落盘 / 内置名录）：首次启动、清缓存后也不再出现「正在取歌手名单…」
  if (!S.artistDir.length) {
    const quick = S.core.discover.peekArtistDirectory?.() || []
    if (quick.length) { S.artistDir = quick; paint() }
  }
  S.artistBusy = true
  try {
    const rows = await S.core.discover.artistDirectory({
      onPartial: (items) => { if (items?.length) { S.artistDir = items; paint() } },
    })
    S.artistDir = rows || S.artistDir
    if (S.artistDir.length) { S.artistDirKey = 'all'; S.artistFailAt = 0 }
    else S.artistFailAt = Date.now()
    paint()
  } catch (e) { console.warn('[歌手名录] 取列表失败：' + e.message); S.artistFailAt = Date.now() } finally {
    S.artistBusy = false
  }
}

// 分类保留 全部 / 男 / 女 / 组合；字母行不再放重复的「全部」按钮（那才是要去掉的）。
const SEX_TABS = [['all', '全部'], ['male', '男'], ['female', '女'], ['band', '组合']]

// 方形封面歌单卡（歌单广场 / 全站通用）
const plCardSquare = (p) => `<button class="orange-pl-card" data-pl="${plCardKey(p)}" title="${esc(p.title)}">
    <div class="orange-pl-cover-big">
      ${p.cover ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="cover-fallback" data-hue="212">♫</span>'}
      ${favBtnHtml(p.id)}
    </div>
    <div class="orange-pl-name">${esc(p.title)}</div>
  </button>`

// 歌单广场：多平台 + 多品类聚合。缓存先上屏，后台再刷新（stale-while-revalidate）。
const PLAZA_SOURCES = [['all', '全部平台'], ['tx', 'QQ 音乐'], ['wy', '网易云'], ['kg', '酷狗音乐']]
let plazaTimer = null
let plazaLastPaint = 0
async function loadPlaza(force = false) {
  if (!S.core?.discover?.plazaPlaylists || S.plazaBusy) return
  if (!force && S.plaza.length && Date.now() - (S.plazaAt || 0) < 60000) return
  S.plazaBusy = true
  try {
    const rows = await S.core.discover.plazaPlaylists({
      limit: 500, taste: tasteTags(), force, refresh: true,
      onPartial: (items) => {
        if (!items?.length) return
        S.plaza = items
        S.plazaAt = Date.now()
        // 上百个数据源会流式回填，节流重绘：整页重画太频繁会让刚点下的卡片失效
        const now = Date.now()
        if (now - plazaLastPaint > 2500 && S.section === 'hall' && S.hallTab === '歌单广场' && !S.page) {
          plazaLastPaint = now
          render()
        }
      },
    })
    if (rows?.length) { S.plaza = rows; S.plazaAt = Date.now() }
    if (S.section === 'hall' && S.hallTab === '歌单广场' && !S.page) render()
  } catch (e) { console.warn('[歌单广场]', e.message) } finally { S.plazaBusy = false }
}

// 歌单广场实时性：启动后台聚合一次，之后每 10 分钟强制回源刷新（不等用户点进页面）。
function startPlazaAutoRefresh() {
  if (!S.core?.discover?.plazaPlaylists) return
  loadPlaza(false).catch(() => {})
  clearInterval(plazaTimer)
  plazaTimer = setInterval(() => {
    if (document.hidden) return
    loadPlaza(true).catch(() => {})
  }, 10 * 60 * 1000)
}

function hallPlazaHtml() {
  loadPlaza()
  const all = S.plaza.length ? S.plaza : (S.discover.plaza?.length ? S.discover.plaza : S.discover.playlists)
  const src = S.plazaSource
  const cat = S.plazaCat
  const match = (p) => (src === 'all' || p.source === src)
    && (cat === '全部' || (p.tags || []).includes(cat)
      || `${p.title} ${p.reason || ''} ${(p.tags || []).join(' ')}`.includes(cat))
  const list = spreadByCover(all.filter(match))
  const featured = list.slice(0, 30)
  // 分类区：每个品类取 12 个，封面已交错；只有 1 个的品类不单独成区，避免一屏碎片
  const groups = PLAZA_CATEGORIES
    .map((c) => ({ c, items: spreadByCover(list.filter((p) => (p.tags || []).includes(c)
      || `${p.title} ${p.reason || ''} ${(p.tags || []).join(' ')}`.includes(c))).slice(0, 12) }))
    .filter((g) => g.items.length >= 2)
  const favs = S.playlists.filter((p) => p.fav)
  const chips = (rows, attr, active, cls = '') => `<div class="chip-row${cls}">${rows.map(([k, l]) => `<button class="chip ${active === k ? 'on' : ''}" ${attr}="${esc(k)}">${esc(l)}</button>`).join('')}</div>`
  return `<div class="plaza-bar">
      ${chips(PLAZA_SOURCES, 'data-plsrc', src)}
      ${chips([['全部', '全部分类'], ...PLAZA_CATEGORIES.map((c) => [c, c])], 'data-plcat', cat, ' letters')}
    </div>
    <div class="section-head compact"><div><h2>精选歌单</h2></div><button class="btn small" id="refreshPlBtn">换一批</button></div>
    ${featured.length ? `<div class="orange-pl-grid plaza-grid">${featured.map(plCardSquare).join('')}</div>` : '<div class="empty">正在聚合各大平台歌单…</div>'}
    ${groups.map((g) => `<div class="section-head compact"><div><h2>${esc(g.c)}</h2><p>${g.c} · 全平台热门歌单</p></div>
        <button class="btn small" data-plcat="${esc(g.c)}">查看全部 ›</button></div>
      <div class="orange-pl-grid">${g.items.map(plCardSquare).join('')}</div>`).join('')}
    ${favs.length ? `<div class="section-head compact"><div><h2>我收藏的歌单</h2><p>${favs.length} 个 · 点星标可取消收藏</p></div></div>
      <div class="grid rec-grid">${favs.map(favPlaylistHtml).join('')}</div>` : ''}`
}


// ═════════════ iOS（PWA）· 播放页为主 + 左侧抽屉 ═════════════
// 主界面 = 播放页；顶栏 ≡ 展开左侧抽屉（听你想听）；底部三件套 dock。
// 所有数据走同源 /api（orange-music-api），不依赖浏览器直连第三方接口（会被 CORS 拦）。
// 不含任何会员 / VIP / 评论 / 分享 / 领现金元素。

const IOS_PLAY_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg>'
const IOS_PAUSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="7.4" y="5.2" width="3.4" height="13.6" rx="1.2"/><rect x="13.2" y="5.2" width="3.4" height="13.6" rx="1.2"/></svg>'
// dock 中央大胶囊里的播放/暂停（参考图：两根粗圆角竖条，居中无其它元素）
const IOS_PLAY_LG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8.4 4.6v14.8L19.8 12z"/></svg>'
const IOS_PAUSE_LG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><rect x="6.8" y="4.4" width="3.9" height="15.2" rx="1.6"/><rect x="13.3" y="4.4" width="3.9" height="15.2" rx="1.6"/></svg>'
const IOS_IC = {
  home: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 10.9 12 4.3l7.6 6.6V19a1.1 1.1 0 0 1-1.1 1.1h-3.7v-5.3H9.2v5.3H5.5A1.1 1.1 0 0 1 4.4 19z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3.6 7h12M3.6 12h9M3.6 17h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m19.5 19.5-3.4-3.4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.2 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9H4.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1A1.8 1.8 0 1 1 7.9 4.5l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4V3.3a1.8 1.8 0 1 1 3.6 0V3.4a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M3.4 7h11.2M3.4 12h8.4M3.4 17h5.6"/><path d="M17.2 12.9v6.4"/><circle cx="19.9" cy="19.9" r="1.35" fill="currentColor" stroke="none"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5.4v13.2M5.4 12h13.2"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.8h3c1.5 0 2.9.8 3.7 2l4.4 6.6c.8 1.2 2.2 2 3.7 2H21"/><path d="m18.6 15.2 2.4 1.9-2.4 1.9"/><path d="M3 17.4h3c1.5 0 2.9-.8 3.7-2l.6-.9"/><path d="M12.9 8.9l.9-1c.8-1.2 2.2-2 3.7-2H21"/><path d="m18.6 3 2.4 1.9-2.4 1.9"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 7.5 12l7 6.5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>',
  playCircle: '<span class="ios-miniplay"><svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><path d="M9 5.4v13.2L19.4 12z"/></svg></span>',
  heart: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.2s-7.4-4.6-7.4-10A4.14 4.14 0 0 1 12 7.9a4.14 4.14 0 0 1 7.4 2.3c0 5.4-7.4 10-7.4 10z"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 7h11M3.5 12h8M3.5 17h6"/><path d="M17 13.6v6.2"/><circle cx="19.4" cy="19.4" r="1.4" fill="currentColor" stroke="none"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.4h.01M12 12h.01M12 18.6h.01"/></svg>',
}

// ── 同源音源接口：/api/* 由 orange-music-api 提供（与 PWA 同域，无 CORS）──
const iosCache = new Map()
async function iosApi(path, ttl = 5 * 60 * 1000) {
  const hit = iosCache.get(path)
  if (hit && Date.now() - hit.at < ttl) return hit.data
  try {
    const r = await fetch(path, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    const j = await r.json()
    iosCache.set(path, { at: Date.now(), data: j })
    return j
  } catch { return null }
}
const iosChart = (type = 'hot') => iosApi(`/api/charts?type=${type}`, 15 * 60 * 1000)
const iosSearch = (q, limit = 30) => iosApi(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, 5 * 60 * 1000)

// iOS 侧的曲目来自服务端 /api/*，没有 key / pending。缺了 key 封面就永远补不上
// （coverHtml 的 data-ck 是空串，hydrateCovers 找不到对应曲目），所以这里统一补齐。
function iosNormTrack(x) {
  if (!x) return x
  const source = x.source || x.platform || 'wy'
  const id = String(x.id || '')
  const key = x.key || (id ? `${source}:${id}` : `${source}:${x.title || ''}|${x.artist || ''}`)
  return { ...x, source, key, pending: x.pending || { source, id } }
}
// 「只听正式发行版」在 iOS 的唯一入口：所有 /api/* 曲目都经过这里。
// 过去只有 Windows 的搜索链路接了 filterOfficial，iOS 端完全没接上，
// 所以设置里的开关怎么改都看不出效果。
const iosNormList = (list) => (Array.isArray(list) ? filterOfficial(list.map(iosNormTrack)) : [])

// 沉浸电台：主题词 → 点击时按主题搜索并整组播放（不依赖易限流的个性化接口）
const IOS_RADIO = [
  { id: 'study', name: '一起学习', q: '轻音乐' },
  { id: 'drive', name: '开车必听', q: '车载 流行' },
  { id: 'sleep', name: '一起睡大觉', q: '助眠 钢琴' },
  { id: 'night', name: '夜跑节奏', q: '夜跑 电子' },
  { id: 'hk', name: '港风劲曲', q: '粤语 经典' },
  { id: 'folk', name: '民谣时光', q: '民谣' },
  { id: 'rock', name: '摇滚现场', q: '摇滚' },
  { id: 'pure', name: '纯音乐', q: '纯音乐' },
]

function iosHashNum(str, base, span) {
  let h = 0
  for (const ch of String(str || '')) h = (h * 31 + ch.charCodeAt(0)) % 100003
  return base + (h % span)
}

function iosSourceName() {
  return String(S.iosSource || S.page?.title || '').trim() || '私人推荐'
}
function iosNowPlayingOpen() {
  const el = $('#nowPlaying')
  return !!el && !el.hidden
}
// 播放页 / 抽屉 / 当前分页的快照。取链要 2~5 秒，期间用户很可能切到别的页面；
// 用它在 playTrack 成功时判断「用户有没有中途切走」，切走了就不再把播放页抢回来。
function iosViewSig() {
  return [
    iosNowPlayingOpen() ? 'np' : 'no',
    iosDrawerOpen() ? 'dr' : '',
    S.iosView || '', S.section || '',
    S.page?.kind || '', S.page?.id || S.libTab || '',
  ].join('|')
}
let iosDrawerState = false
// 在中央播放胶囊上「上滑=下一首 / 下滑=上一首」；用时间戳挡住手势末尾的 click
let iosDockSwipeAt = 0
function bindIosDockSwipe() {
  const bar = $('#tabbar')
  if (!bar || bar.dataset.swipe === '1') return
  bar.dataset.swipe = '1'
  let y0 = 0, x0 = 0, t0 = 0
  bar.addEventListener('touchstart', (e) => {
    const t = e.touches[0]
    y0 = t.clientY; x0 = t.clientX; t0 = Date.now()
  }, { passive: true })
  bar.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]
    if (!t) return
    const dy = t.clientY - y0
    const dx = t.clientX - x0
    if (Date.now() - t0 > 800) return
    if (Math.abs(dy) < 28 || Math.abs(dy) <= Math.abs(dx)) return
    iosDockSwipeAt = Date.now()
    if (dy < 0) next(1)
    else next(-1)
  }, { passive: true })
}
function iosDrawerOpen() { return iosDrawerState }
// 抽屉必须挂在 body 上：留在 .main 里会被播放页（fixed, z-index 40）整块盖住，
// 表现就是「点了只有变暗、看不到抽屉」。
// 抽屉是独立容器（#iosDrawer），不放在 main 里：
// main 被播放页（fixed z-index 40）覆盖，抽屉留在里面会被整块盖住。
function iosMountDrawer() {
  if (!IS_IOS) return
  const d = $('#iosDrawer')
  if (!d) return
  if (!d.dataset.ready) { d.innerHTML = iosHomeHtml(); d.dataset.ready = '1' }
}
function iosSetDrawer(on) {
  iosDrawerState = !!on
  document.documentElement.classList.toggle('drawer-open', iosDrawerState)
  const mask = $('#iosDrawerMask')
  if (mask) mask.hidden = !iosDrawerState
  const d = $('#iosDrawer')
  if (d) {
    if (iosDrawerState) {
      d.innerHTML = iosHomeHtml(); paintDynamics(d)
      d.hidden = false
      requestAnimationFrame(() => d.classList.add('open'))
    } else {
      d.classList.remove('open')
      setTimeout(() => { if (!iosDrawerState) d.hidden = true }, 260)
    }
  }
  iosRenderNav()
}

// 首页数据：三个聚合入口并行拉，页面秒开后再补
// 私人推荐 = 网易云个性化歌单曲目 + QQ 热歌；热歌熟悉 = QQ 巅峰榜 + 网易云热歌榜；
// 新鲜探索 = 网易云推荐新音乐 + QQ 新歌榜 + 网易云新歌榜。全部由服务端混排去重。
let iosFeedBusy = false
async function iosLoadFeed() {
  if (iosFeedBusy) return
  iosFeedBusy = true
  try {
    const [hot, rise, rec, rank, fresh, pls] = await Promise.all([
      iosChart('hot'), iosChart('rise'),
      // 私人推荐：每次进入重新抽 6 首（服务端池子缓存 10 分钟，抽样在后端做，打开很快）
      iosApi('/api/recommend?n=6', 0),
      iosApi('/api/rank', 20 * 60 * 1000),
      iosApi('/api/new', 20 * 60 * 1000),
      iosApi('/api/playlists?n=6', 20 * 60 * 1000),
    ])
    if (pls?.list?.length) S.iosPlaylists = pls.list
    S.iosHot = iosNormList(hot?.tracks || S.iosHot || [])
    S.iosRise = iosNormList(rise?.tracks || S.iosRise || [])
    if (rec?.tracks?.length) S.iosRec = iosNormList(rec.tracks)
    if (rank?.tracks?.length) S.iosRank = iosNormList(rank.tracks)
    if (fresh?.tracks?.length) S.iosNew = iosNormList(fresh.tracks)
    if (!S.iosRec) S.iosRec = S.iosHot
    if (!S.iosRank) S.iosRank = S.iosRise
    if (!S.iosNew) S.iosNew = S.iosRise
    if (S.iosHot.length && !S.iosSource) S.iosSource = '私人推荐'
    iosSeedStationCovers()
    // 预取首屏封面：进 Music 页时列表已经有图，不用一行一行现取
    try { S.core?.covers?.prefetchCovers?.([...(S.iosRec || []), ...(S.iosNew || [])].slice(0, 14), 14) } catch { /* 无核心 */ }
    if (IS_IOS && (S.section === 'home' || S.section === 'hall')) render()
    if (IS_IOS && iosDrawerOpen()) { const d = $('#iosDrawer'); if (d) { d.innerHTML = iosHomeHtml(); paintDynamics(d) } }
  } finally { iosFeedBusy = false }
}

// 沉浸电台封面：进抽屉就有图（用已加载榜单里的真实封面按主题稳定取），不额外打接口。
// 之后后台按主题搜一次，换成「真的属于这个主题」的封面。
function iosSeedStationCovers() {
  const pool = [...(S.iosNew || []), ...(S.iosRec || []), ...(S.iosHot || [])]
    .filter((t) => t && cachedCover(t))
  if (!pool.length) return
  const map = S.iosStnCover instanceof Map ? S.iosStnCover : new Map()
  for (const r of IOS_RADIO) {
    if (map.get(r.id)) continue
    const idx = iosHashNum(r.id, 0, pool.length)
    const url = cachedCover(pool[idx])
    if (url) map.set(r.id, url)
  }
  S.iosStnCover = map
}

// dock 中央胶囊的外圈进度环：周长按 176×52、圆角 26 算好，写死比每次量 DOM 稳。
const DOCK_RING_PERIMETER = 2 * (176 + 52) - 8 * 26 + 2 * Math.PI * 26

function iosRenderNav() {
  const inPlayer = iosNowPlayingOpen()
  const drawer = iosDrawerOpen()
  // 播放队列键不再显示未读红点（用户要求）
  const inMusic = !!S.iosView && !inPlayer   // 在 Music / 乐库 分页页（播放页被收起）
  const t = S.current
  // Music / 乐库 分页页里：中央不再是纯播放胶囊，而是「当前播放」小卡（封面 + 歌名 + 歌手），
  // 文字过长时左右滚动；点小卡任意处返回播放页，点右侧播放/暂停键只切换播放状态。
  let center
  if (inMusic && t) {
    center = `<button class="ios-dock-np" data-ios-open aria-label="返回播放页">
        <span class="ios-dock-np-cv">${coverHtml(t)}</span>
        <span class="ios-dock-np-meta">
          <b class="ios-dock-np-title"><span>${esc(t.title || '未在播放')}</span></b>
          <i class="ios-dock-np-artist"><span>${esc(t.artist || '')}</span></i>
        </span>
      </button>`
  } else {
    center = `<button class="ios-dock-play" data-ios-toggle aria-label="${S.playing ? '暂停' : '播放'}">
        <svg class="dock-ring" viewBox="0 0 180 56" preserveAspectRatio="none" aria-hidden="true">
          <rect class="dock-ring-bg" x="2" y="2" width="176" height="52" rx="26" vector-effect="non-scaling-stroke"></rect>
          <rect class="dock-ring-fg" id="dockRingFg" x="2" y="2" width="176" height="52" rx="26" vector-effect="non-scaling-stroke"
                stroke-dasharray="${DOCK_RING_PERIMETER.toFixed(1)}"
                stroke-dashoffset="${DOCK_RING_PERIMETER.toFixed(1)}"></rect>
        </svg>
        <span class="dock-ico">${S.playing ? IOS_PAUSE_LG : IOS_PLAY_LG}</span>
      </button>`
  }
  $('#tabbar').innerHTML = `
    <button class="ios-dock-key${drawer ? ' on' : ''}" data-ios-drawer aria-label="音乐库">${IOS_IC.home}</button>
    ${center}
    <button class="ios-dock-key" data-ios-queue aria-label="播放列表">
      ${IOS_IC.queue}
    </button>`
  const bar = $('#tabbar')
  if (bar) bar.classList.toggle('in-player', inPlayer)
  if (inMusic && t) iosInitDockNpMarquee()
  iosPaintDockRing()
}

// Music / 乐库 分页页里的「当前播放」小卡：文字过长时左右滚动显示（前后滚动）。
function iosInitDockNpMarquee() {
  const el = $('#tabbar')
  if (!el) return
  el.querySelectorAll('.ios-dock-np-title, .ios-dock-np-artist').forEach((box) => {
    const inner = box.querySelector('span')
    if (!inner) return
    box.classList.remove('scroll')
    inner.style.removeProperty('--scroll')
    // 等一帧量出真实溢出再决定是否滚动
    requestAnimationFrame(() => {
      const over = inner.scrollWidth - box.clientWidth
      if (over > 2) {
        inner.style.setProperty('--scroll', `${-over}px`)
        box.classList.add('scroll')
      }
    })
  })
}

// 逐字渐变：--sung 由 CSS transition 补间（4Hz 进度事件也能看起来连续）。
// 换句那一帧必须让 --sung 瞬间归零，否则会从上一句的 100% 平滑倒退回第一个字。
function iosSetSung(el, pct, tag) {
  if (!el) return
  const p = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`
  if (el.dataset.sungTag !== String(tag || '')) {
    el.dataset.sungTag = String(tag || '')
    el.classList.add('lyric-jump')
    el.style.setProperty('--sung', '0%')
    requestAnimationFrame(() => {
      el.classList.remove('lyric-jump')
      el.style.setProperty('--sung', p)
    })
    return
  }
  el.style.setProperty('--sung', p)
}

// 歌词详情页跟随播放：高亮当前行 + 演唱染色 + 居中滚动// 歌词详情页跟随播放：高亮当前行 + 演唱染色 + 居中滚动
function iosSyncLyricsPage(pos) {
  if (!iosLyricsPageOpen) return
  const box = $('#iosLyBody')
  if (!box) return
  const lines = S.lyrics?.lines || []
  if (!lines.length) return
  let idx = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].time <= pos + 90) idx = i
  const rows = box.querySelectorAll('.ly-row')
  if (box.dataset.on !== String(idx)) {
    box.dataset.on = String(idx)
    rows.forEach((r, i) => r.classList.toggle('on', i === idx))
    const on = rows[idx]
    if (on) box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight / 2 + on.offsetHeight / 2)
  }
  const on = rows[idx]
  if (on) {
    const start = Number(lines[idx]?.time) || 0
    const end = Number(lines[idx + 1]?.time) || (start + 4000)
    const p = Math.max(0, Math.min(1, (pos - start) / Math.max(400, end - start)))
    const m = on.querySelector('.ly-main')
    if (m) iosSetSung(m, p * 100, `ly|${S.lyrics?.key}|${idx}`)
    // 距离当前行越远越暗（向上/向下渐暗）
    rows.forEach((r, i) => {
      const d = Math.abs(i - idx)
      r.style.opacity = d === 0 ? '1' : d === 1 ? '.55' : d === 2 ? '.32' : '.18'
    })
  }
  // 进度条同步
  const seek = $('#iosLySeek')
  if (seek) {
    const a = $('#previewAudio')
    const dur = Number(S.current?.durationMs) || (a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
    if (dur > 0 && !SEEKING) {
      seek.value = String(Math.round(Math.min(1, pos / dur) * 1000))
      seek.style.setProperty('--p', `${((pos / dur) * 100).toFixed(2)}%`)
    }
  }
}

// 当前歌词行的「染色」进度：跟 Windows 精简模式一致，按本行演唱百分比填色
function iosPaintLyricSung(pos) {
  if (!IS_IOS) return
  const box = $('#npLyrics')
  if (!box) return
  const lines = S.lyrics?.lines || []
  if (!lines.length || box.dataset.on == null) return
  const on = box.querySelector('.lyric-line.on')
  if (!on) return
  const i = Number(box.dataset.on) || 0
  const start = Number(lines[i]?.time) || 0
  const end = Number(lines[i + 1]?.time) || (start + 4000)
  const p = Math.max(0, Math.min(1, (pos - start) / Math.max(400, end - start)))
  iosSetSung(on, p * 100, `np|${S.lyrics?.key}|${i}`)
}

// 把播放进度画到 dock 胶囊外圈
function iosPaintDockRing() {
  const fg = document.getElementById('dockRingFg')
  if (!fg) return
  const a = $('#previewAudio')
  const dur = Number(S.current?.durationMs) || (a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
  const pos = Number(S.positionMs) || 0
  const p = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0
  fg.setAttribute('stroke-dashoffset', String(DOCK_RING_PERIMETER * (1 - p)))
}

// ── 歌词详情页（点击播放页歌词区进入）──────────────
let iosTlyricOn = true   // 翻译默认开：外文歌自动显示中文
let iosLyricsPageOpen = false
function iosOpenLyrics() {
  iosLyricsPageOpen = true
  const el = $('#iosLyricsPage')
  if (!el) return
  el.hidden = false
  el.classList.add('open')
  iosRenderLyricsPage()
}
function iosCloseLyrics() {
  iosLyricsPageOpen = false
  const el = $('#iosLyricsPage')
  if (!el) return
  el.classList.remove('open')
  setTimeout(() => { if (!iosLyricsPageOpen) el.hidden = true }, 220)
}
function iosRenderLyricsPage() {
  const el = $('#iosLyricsPage')
  if (!el) return
  const t = S.current
  const lines = S.lyrics?.lines || []
  const trans = S.lyrics?.tlyric || []
  const uni = new Map(trans.map((x) => [Math.round(x.time), x.text]))
  const pos = Number(S.positionMs) || 0
  let idx = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].time <= pos + 90) idx = i
  const body = lines.length
    ? lines.map((l, i) => {
      const tr = uni.get(Math.round(l.time))
      return `<div class="ly-row${i === idx ? ' on' : ''}" data-ly="${i}">
        <p class="ly-main">${esc(l.text || '')}</p>
        ${tr && iosTlyricOn ? `<p class="ly-tr">${esc(tr)}</p>` : ''}
      </div>`
    }).join('')
    : (S.lyrics?.text
      ? `<div class="ly-empty">${esc(S.lyrics.text.split('\n').slice(0, 40).join('\n'))}</div><div class="ly-empty">这首没有带时间轴的同步歌词</div>`
      : '<div class="ly-empty">暂时没有找到同步歌词</div>')
  el.innerHTML = `<div class="ly-head">
      <button class="ly-x" data-ios-lyclose aria-label="关闭">✕</button>
      <span class="ly-cover">${t ? coverHtml(t) : ''}</span>
      <span class="ly-meta"><b>${esc(t?.title || '未在播放')}</b><i>${esc(t?.artist || '')}</i></span>
      <button class="ly-like${t && (S.favorites || []).some((x) => x.key === t.key) ? ' on' : ''}" data-ios-lylike aria-label="喜欢">♥</button>
    </div>
    <div class="ly-body" id="iosLyBody">${body}</div>
    <div class="ly-seek-wrap">
      <input class="ly-seek" id="iosLySeek" type="range" min="0" max="1000" step="1" value="0" aria-label="播放进度">
    </div>
    <div class="ly-bar">
      <div class="ly-ctl">
        <button class="ly-btn" data-ios-lyprev aria-label="上一首">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 5h2.2v14H7z"/><path d="M18.6 5v14L9.2 12z"/></svg>
        </button>
        <button class="ly-btn play" data-ios-toggle aria-label="播放/暂停">
          ${S.playing
            ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="7" y="4.8" width="3.6" height="14.4" rx="1.4"/><rect x="13.4" y="4.8" width="3.6" height="14.4" rx="1.4"/></svg>'
            : '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8.4 4.6v14.8L19.8 12z"/></svg>'}
        </button>
        <button class="ly-btn" data-ios-lynext aria-label="下一首">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M14.8 5h2.2v14h-2.2z"/><path d="M5.4 5v14L14.8 12z"/></svg>
        </button>
      </div>
      <span class="ly-gap"></span>
      <button class="ly-toggle${iosTlyricOn ? ' on' : ''}" data-ios-lytr>译<i>${iosTlyricOn ? 'on' : 'off'}</i></button>
    </div>`
  const box = $('#iosLyBody')
  const on = box?.querySelector('.ly-row.on')
  if (box && on) box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight / 2 + on.offsetHeight / 2)
  // 进度条：拖动直接定位
  const sk = $('#iosLySeek')
  if (sk) {
    sk.oninput = (e) => {
      const a = $('#previewAudio')
      const dur = Number(S.current?.durationMs) || (a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
      const v = Number(e.target.value)
      e.target.style.setProperty('--p', `${(v / 10).toFixed(2)}%`)
      if (!dur) return
      const ms = (v / 1000) * dur
      S.positionMs = ms
      try { if (a) a.currentTime = ms / 1000 } catch { /* ignore */ }
    }
  }
  // 点击歌词行 → 跳转到该行时间，并同步底部进度条（拖动歌词即定位）
  const lyBody = $('#iosLyBody')
  if (lyBody) {
    lyBody.onclick = (e) => {
      const row = e.target.closest('.ly-row')
      if (!row || S.lyrics?.loading) return
      const idx = Number(row.dataset.ly)
      const time = Number(S.lyrics?.lines?.[idx]?.time) || 0
      iosSeekTo(time)
    }
  }
}

// 全局跳转：按毫秒定位当前曲播放进度（歌词行点击 / 进度条拖动共用）
function iosSeekTo(ms) {
  const a = $('#previewAudio')
  const dur = Number(S.current?.durationMs) || (a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
  if (!dur) return
  const m = Math.max(0, Math.min(dur, ms))
  S.positionMs = m
  S.lastSeekAt = Date.now()
  try { if (a) a.currentTime = m / 1000 } catch { /* ignore */ }
  native.seek(m).catch(() => {})
  renderProgress()
}

// ── Music / 乐库 页（替代原来的侧边抽屉）──────────
let iosMusicTab = 'music'
function iosMusicTabsHtml(active) {
  return `<header class="ios-mtabs">
    <button class="ios-mback" data-ios-go="player" aria-label="返回播放页">‹</button>
    <button class="ios-mtab${active === 'music' ? ' on' : ''}" data-ios-mtab="music">Music</button>
    <button class="ios-mtab${active === 'lib' ? ' on' : ''}" data-ios-mtab="lib">乐库</button>
    <span class="ios-mtabs-gap"></span>
    <button class="ios-msearch" data-ios-search aria-label="搜索">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m19.5 19.5-3.4-3.4"/></svg>
    </button>
  </header>`
}
function iosMusicPageHtml() {
  if (!S.iosHot && !S.iosRise) iosLoadFeed()
  const rec = (S.iosRec || []).slice(0, 6)
  const fresh = (S.iosNew || S.iosRise || [])
  const covers = rec.map((x) => cachedCover(x)).filter(Boolean)
  const stnCover = S.iosStnCover instanceof Map ? S.iosStnCover : new Map()
  const card = (title, sub, color, img) => `<button class="mc-card" data-ios-${title === '私人推荐' ? 'rec' : 'fresh'}">
      <span class="mc-imgs">${(img || []).slice(0, 2).map((u) => `<i data-blur="${esc(u)}"></i>`).join('') || '<i class="ph"></i>'}</span>
      <b>${title}</b><em style="color:${color}">${sub}</em>
    </button>`
  return `<div class="ios-page ios-music">
    ${iosMusicTabsHtml('music')}
    <div class="mc-row">
      ${card('私人推荐', 'Daily Songs', '#3ddc84', covers.slice(0, 2))}
      ${card('新鲜探索', 'New Songs', '#9b7bff', fresh.slice(0, 2).map((x) => cachedCover(x)).filter(Boolean))}
    </div>
    <button class="mc-listen" data-ios-go="home" aria-label="听你想听">${IOS_IC.menu}<span>听你想听</span><i>›</i></button>
    <div class="mc-sec"><b>偶遇心动单曲</b><span class="mc-more" data-ios-fresh2>换一批 ›</span></div>
    <div class="mc-list">${rec.map((x, i) => `<button class="mc-row-item" data-ios-mplay="${i}">
        <span class="mc-cv">${coverHtml(x)}</span>
        <span class="mc-meta"><b>${esc(x.title || '')}</b><i>${esc(x.artist || '')}</i></span>
        <span class="mc-heart">♡</span>
      </button>`).join('') || '<div class="ios-empty">正在取推荐…</div>'}</div>
    <div class="mc-sec"><b>你的私荐歌单</b><span class="mc-more" data-ios-plrefresh>换一批 ›</span></div>
    <div class="pl-grid">${(S.iosPlaylists || []).slice(0, 6).map((p) => `
      <button class="pl-card" data-ios-plopen="${esc(p.id)}">
        <span class="pl-cv"${p.cover ? ` data-blur="${esc(p.cover)}"` : ''}></span>
        <b>${esc(p.name)}</b>
        <i>${p.count ? p.count + ' 首' : ''}</i>
      </button>`).join('') || '<div class="ios-empty">正在取你的私荐歌单…</div>'}</div>
  </div>`
}

// 乐库分类：与 Windows 乐馆「歌单广场」完全同一套 41 个分类，每类推荐 3 个真实歌单。
// 旧版是 5 个手写大类 × 3 个搜索词（点进去只是搜单曲），既不对齐 Windows 也没有歌单实体。
const IOS_LIB_CATS = Object.freeze([
  '华语', '流行', '摇滚', '民谣', '电子', '说唱', '古风', 'ACG', '轻音乐', '影视', '治愈', '欧美',
  '国语', '粤语', '韩语', '日语', '英语', '小语种', 'R&B', '爵士', '古典', '乡村', '拉丁', '嘻哈',
  '经典', '网络歌曲', 'KTV热歌', '儿歌', '伤感', '安静', '快乐', '励志', '甜蜜', '睡前', '学习',
  '运动', '开车', '约会', '夜晚', '校园', '高品质', '推荐',
])
const iosLibCatCache = new Map()
const iosLibCatBusy = new Set()

function iosLibCardsHtml(cat) {
  const list = iosLibCatCache.get(cat)
  if (!list) {
    return '<span class="lib-card ph"><span class="lib-cv"></span><i>正在取歌单…</i></span>'.repeat(3)
  }
  if (!list.length) return '<div class="ios-empty">这个分类暂时没取到歌单</div>'
  return list.slice(0, 3).map((p) => `
      <button class="lib-card" data-ios-plopen="${esc(p.id)}">
        <span class="lib-cv"${p.cover ? ` data-blur="${esc(p.cover)}"` : ''}></span>
        <i>${esc(p.name)}</i>
      </button>`).join('')
}

// 分批（并发 2）按分类取歌单，每批回来只更新对应块，不整页重绘 ——
// 41 个分类同时打网易云搜索会直接 405「操作频繁」，并发压到 2 后命中率明显更高。
function iosLoadLibrary() {
  const todo = IOS_LIB_CATS.filter((c) => !iosLibCatCache.has(c) && !iosLibCatBusy.has(c))
  if (!todo.length) return
  let cur = 0
  const worker = async () => {
    while (cur < todo.length) {
      const cat = todo[cur++]
      const slot = IOS_LIB_CATS.indexOf(cat)
      iosLibCatBusy.add(cat)
      let list = []
      try {
        const j = await iosApi(`/api/search/playlist?q=${encodeURIComponent(cat)}&limit=3`, 30 * 60 * 1000)
        list = (j?.list || []).slice(0, 3)
      } catch { /* 限流时空数组，下次进入会重试 */ }
      iosLibCatCache.set(cat, list)
      iosLibCatBusy.delete(cat)
      const host = document.querySelector(`[data-libcat="${slot}"]`)
      if (host) { host.innerHTML = iosLibCardsHtml(cat); paintDynamics(host) }
    }
  }
  for (let i = 0; i < 2 && i < todo.length; i++) worker()
}

function iosLibraryShowHtml() {
  setTimeout(() => { try { iosLoadLibrary() } catch { /* 忽略 */ } }, 0)
  return `<div class="ios-page ios-music">
    ${iosMusicTabsHtml('lib')}
    ${IOS_LIB_CATS.map((cat, gi) => `
      <section class="lib-block">
        <div class="lib-head"><b>${esc(cat)}</b><span>3 个歌单</span></div>
        <div class="lib-cards" data-libcat="${gi}">${iosLibCardsHtml(cat)}</div>
      </section>`).join('')}
  </div>`
}

// 抽屉一打开就后台把几个推荐源的前几首直链取好：用户点「私人推荐 / 热歌熟悉 /
// 新鲜探索」时直链已命中缓存，playTrack 不再 await 取链 → 点下即出声。
// 只取 6 首、并发由核心层控制，不会打爆同源 /api/url。
function iosPrefetchForPlay(lists = []) {
  if (!S.core?.sources?.prefetchTracks) return
  const seen = new Set()
  const rows = []
  for (const l of lists) {
    for (const t of (Array.isArray(l) ? l : []).slice(0, 6)) {
      if (!t?.key || seen.has(t.key) || t.streams?.length) continue
      seen.add(t.key); rows.push(t)
    }
  }
  if (rows.length) {
    try { S.core.sources.prefetchTracks(rows, { limit: 6, priorityKey: rows[0].key }) } catch { /* 核心未就绪 */ }
  }
}

// ── 抽屉：听你想听// ── 抽屉：听你想听 ────────────────────────────────
function iosHomeHtml() {
  if (!S.iosHot && !S.iosRise) iosLoadFeed()
  // 侧栏可见即预取，覆盖「点歌要等 2~4 秒取链」的问题
  try { iosPrefetchForPlay([S.iosRec || S.iosHot, S.iosRank || S.iosRise, S.iosNew]) } catch { /* 忽略 */ }
  // 侧边栏：听你想听（四宫格）+ 进入 Music / 乐库。数量与来源按用户要求删除。
  const quad = [
    ['rec', '私人推荐', '♪', true],
    ['charts', '热歌熟悉', '◍', false],
    ['fresh', '新鲜探索', '◭', false],
    ['fav', '我喜欢的', '♥', false],
  ]
  return `<header class="ios-head">
      <h1>听你想听</h1>
      <span class="ios-head-tools">
        <button class="ios-round" data-ios-settings aria-label="设置">${IOS_IC.gear}</button>
        <button class="ios-ava" data-ios-go="mine" data-av-slot aria-label="我的">${avatarImgHtml()}</button>
      </span>
    </header>
    <div class="ios-quad">${quad.map(([k, t, ico]) => {
      // 图标默认灰色，只有「当前正在播的来源」或按下时才高亮
      const on = String(S.iosSource || '') === t && !!S.current
      return `
      <button class="ios-qc${on ? ' on' : ''}" data-ios-${k}>
        <span class="ios-qc-ico">${ico}</span>
        ${on ? `<span class="ios-qc-corner">${S.playing ? '❚❚' : '▶'}</span>` : ''}
        <span class="ios-qc-t">${t}</span>
      </button>`
    }).join('')}
    </div>
    <h2 class="ios-sec-h">沉浸电台</h2>
    <div class="ios-stations">${IOS_RADIO.map((r) => {
      const hue = iosHashNum(r.name, 8, 40)
      const ppl = (iosHashNum(r.name + 'p', 42, 900) / 10).toFixed(1)
      const img = (S.iosStnCover instanceof Map ? S.iosStnCover.get(r.id) : '') || ''
      return `<button class="ios-stn" data-ios-radio="${esc(r.id)}">
        <span class="ios-stn-bg"${img ? ` data-blur="${esc(img)}"` : ''} data-hue="${hue}"></span>
        <span class="ios-stn-shade"></span>
        <span class="ios-stn-txt"><b>${esc(r.name)}</b><em>${ppl}w 人在听</em></span>
      </button>`
    }).join('')}</div>`
}

// Mine 页「新建歌单」：直接落盘一个空歌单，不依赖「先选歌再建」的 S.pickKeys，
// 也不因 S.cloud=false 被 mergeIntoPlaylist 的「核心未就绪」挡住。
async function iosCreatePlaylist() {
  let name = ''
  try { name = String(await askText('新建歌单', '给歌单起个名字') || '').trim() } catch { return }
  if (!name) return
  const list = { id: `pl-${Date.now()}`, name: name.slice(0, 40), platform: '自建', tracks: [], createdAt: Date.now() }
  try {
    if (S.core?.repo?.setState) await S.core.repo.setState(S.core.repo.keys.playlist(list.id), list)
  } catch { /* 离线也能建，至少保留在内存里 */ }
  S.playlists = [list, ...(Array.isArray(S.playlists) ? S.playlists : [])]
  try { render() } catch { /* ignore */ }
  toast(`已创建「${list.name}」`)
}

// ── 我的 ─────────────────────────────────────────
function iosMineHtml() {
  const name = readDisplayName() || (S.session?.user?.name || '我的音乐')
  const mine = (S.playlists || []).filter((p) => !p.fav)
  const hours = Math.max(1, Math.round((S.recent || []).length * 3.2 + (S.favorites || []).length * 0.8))
  // 账号信息与 Windows 端同源：都来自云端 auth 的 identity / session，
  // 登录同一账号即自动同步 喜欢 / 歌单 / 播放记录。
  // 账号掩码已按需求移除：Mine 身份卡只显示昵称 + 同步状态
  const syncState = S.localTest ? '已登录 · 本地测试（数据仅存本机）'
    : (S.session && !S.anonSession) ? (S.cloud ? '已登录 · 云端同步' : '已登录 · 等待同步') : (S.anonSession ? '匿名会话 · 点这里重新登录' : '未登录 · 点这里登录')
  const ent = (label, list, count) => `<button class="ios-ent" data-ios-lib="${label}">
      <span class="ios-ent-cover">${list?.[0] ? coverHtml(list[0]) : '<span class="ios-ent-ph">♪</span>'}</span>
      <span class="ios-ent-row"><b>${label.replace('播放', '')} ${count}</b>${IOS_IC.playCircle}</span>
    </button>`
  return `<div class="ios-page ios-mine">
    <header class="ios-head">
      <button class="ios-round" data-ios-go="player" aria-label="返回">${IOS_IC.back}</button>
      <h1>我的</h1>
      <span class="ios-head-tools">
        <button class="ios-round" data-ios-settings aria-label="设置">${IOS_IC.gear}</button>
      </span>
    </header>

    <section class="ios-card ios-idcard" data-ios-login role="button" tabindex="0">
      <button class="ios-idcard-ava" data-avatar data-av-slot aria-label="更换头像">${avatarImgHtml()}</button>
      <div class="ios-idcard-meta">
        <b>${esc(name)}</b>
        <i>${esc(syncState)}</i>
      </div>
    </section>
    ${S.session ? `<div class="ios-account-bar">
      <button class="ios-account-btn" id="iosLogout">退出登录</button>
      <button class="ios-account-btn" id="iosSyncNow">立即同步</button>
    </div>` : ''}

    <div class="ios-ent-row3">
      ${ent('喜欢', S.favorites, S.favorites.length)}
      ${ent('最近播放', S.recent, S.recent.length)}
      ${ent('本地', S.localTracks, S.localTracks.length)}
    </div>

    <div class="ios-plhead">
      <b>自建歌单</b><span>${mine.length}</span>
      <span class="ios-plhead-tools">
        <button class="ios-plimport" data-ios-plimport aria-label="导入歌单">导入歌单</button>
      </span>
    </div>
    <div class="ios-plist">
      ${mine.slice(0, 5).map((pl) => `<button class="ios-plrow" data-playlist="${esc(pl.id)}">
        <span class="ios-plrow-cv">${pl.cover ? `<img src="${esc(pl.cover)}" alt="">` : '<span class="ios-ent-ph">♪</span>'}</span>
        <span class="ios-plrow-meta"><b>${esc(pl.name)}</b><i>${(pl.tracks || []).length} 首</i></span>
      </button>`).join('') || '<div class="ios-empty">还没有自建歌单</div>'}
      <button class="ios-plrow tool" data-ios-plnew>
        <span class="ios-plrow-cv ph ai">+</span>
        <span class="ios-plrow-meta"><b>新建歌单</b></span>
      </button>
    </div>
  </div>`
}

// ── 音乐库列表页（喜欢 / 最近播放 / 本地）──────────
function iosLibSource() {
  const k = S.iosLib
  const view = (a) => filterOfficial(Array.isArray(a) ? a : [])
  if (k === 'like') return { title: '我喜欢的', list: view(S.favorites) }
  if (k === 'recent') return { title: '最近播放', list: view(S.recent) }
  if (k === 'local') return { title: '本地歌曲', list: view(S.localTracks) }
  return { title: '', list: [] }
}

// 进入「喜欢 / 最近播放」子页时自动载入：每次都拉一次云端状态，
// 另一台设备刚收藏的歌也能马上出现。本地歌曲受浏览器沙箱限制不能自动读盘，
// 由空态里的「导入本地音频」按钮在用户手势内选文件。
let iosLibBusy = false
function iosLoadLibData(kind) {
  if (kind === 'local' || iosLibBusy || !S.cloud) return
  iosLibBusy = true
  syncUserState().catch(() => {}).finally(() => {
    iosLibBusy = false
    if (S.iosLib === kind) render()
  })
}
function iosLibPageHtml() {
  const { title, list } = iosLibSource()
  return `<div class="ios-page">
    <header class="ios-head">
      <button class="ios-round" data-ios-libback aria-label="返回">${IOS_IC.back}</button>
      <h1>${esc(title)}</h1>
      <span class="ios-head-tools">
        <button class="ios-round" data-ios-playlib aria-label="播放全部">${IOS_IC.playCircle}</button>
      </span>
    </header>
    ${list.length ? `<div class="ios-q-list ios-lib-list">${list.map((x, i) => `
      <div class="ios-q-row${x.key === S.current?.key ? ' on' : ''}">
        <button class="ios-q-pick" data-ios-libplay="${i}">
          <span class="ios-q-cv">${coverHtml(x)}</span>
          <span class="ios-q-meta"><b>${esc(x.title || '')}</b><i>${esc(x.artist || '')}</i></span>
        </button>
      </div>`).join('')}</div>` : `<div class="ios-empty ios-lib-empty">
        <b>${S.iosLib === 'local' ? '还没有导入本地音频' : S.iosLib === 'recent' ? '还没有播放记录' : '还没有喜欢的歌'}</b>
        <span>${S.iosLib === 'local' ? '浏览器不允许自动读取本机文件，点下面的按钮选择音频' : '去 Music 页挑一首，回来就能看到'}</span>
        <button class="btn small" data-ios-libact="${S.iosLib === 'local' ? 'import' : 'music'}">${S.iosLib === 'local' ? '导入本地音频' : '去听歌'}</button>
      </div>`}
  </div>`
}

// ── 队列 / 更多（底部升起的 sheet）────────────────
let iosSheetKind = ''
function iosSheetOpen() { const el = $('#iosSheet'); return !!el && !el.hidden }

function iosQueueSheetHtml() {
  const t = S.current
  const list = S.queue || []
  // 当前曲理论上一定在队列里（playTrack 会自动追加）。但恢复上次播放 / 云端同步回来的
  // 队列可能和 S.current 不同步，这时把它放在列表首位，保证打开播放列表必能看到「正在播放」。
  const rows = (t?.key && !list.some((x) => x.key === t.key)) ? [t, ...list] : list
  return `<div class="ios-sheet-card">
    <div class="ios-q-hero">
      <span class="ios-q-hero-bg"${t ? ` data-blur="${esc(cachedCover(t) || t.cover || '')}"` : ''} data-hue="${iosHashNum(t?.title || '', 10, 30)}"></span>
      <span class="ios-q-hero-shade"></span>
      <span class="ios-q-hero-txt"><b>${esc(t?.title || '还没有播放')}</b><i>${esc(t?.artist || '')}</i></span>
      <button class="ios-sheet-x" data-ios-sheet-close aria-label="关闭">×</button>
    </div>
    <div class="ios-q-head">
      <b>播放列表</b>
      <span class="ios-q-head-tools">
        <button class="ios-mode-btn" data-ios-mode aria-label="播放模式：${esc(iosModeLabel())}" title="${esc(iosModeLabel())}">${iosModeIcon()}</button>
        <button data-ios-sheet-close aria-label="收起">${IOS_IC.more}</button>
      </span>
    </div>
    <div class="ios-q-list">${rows.map((x) => {
      const now = x.key === t?.key
      // 跳转用 key 而不是下标：列表首位可能插入了不在队列里的当前曲，下标会整体错位。
      return `<div class="ios-q-row${now ? ' on' : ''}"${now ? ' data-ios-now="1"' : ''}>
      <button class="ios-q-pick" data-ios-jump="${esc(x.key || '')}">
        <span class="ios-q-cv">${coverHtml(x)}</span>
        <span class="ios-q-meta"><b>${esc(x.title || '')}</b><i>${now ? '<em class="ios-q-nowdot"></em>正在播放 · ' : ''}${esc(x.artist || '')}</i></span>
      </button>
    </div>`
    }).join('') || '<div class="ios-empty">队列为空，去左侧抽屉挑一首</div>'}</div>
  </div>`
}

// 音质图标：自动 / 无损 / 高品质 / 标准 / 流畅，用同一枚「波形」图标 + 角标区分
function iosQualityIcon() {
  const abbr = { auto: '自动', lossless: 'SQ', hq: 'HQ', sq: '标准', lq: '流畅' }[S.quality] || '自动'
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15.2 8.2 8.4l3.6 5.2 2.6-3.4 5.6 6"/></svg><i class="ios-q-tag">${esc(abbr)}</i>`
}

// 播放模式：顺序 / 单曲循环 / 随机（默认顺序，选择跟随记录）
function iosModeLabel() {
  return S.mode === 'single' ? '单曲循环' : S.mode === 'shuffle' ? '随机播放' : '顺序播放'
}
function iosModeIcon() {
  const d = S.mode === 'single'
    ? '<path d="M4 8h13l-2.4-2.4"/><path d="M20 8v3.2"/><path d="M20 16H7l2.4 2.4"/><path d="M4 16v-3.2"/><text x="12" y="15" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none">1</text>'
    : S.mode === 'shuffle'
      ? '<path d="M4 6.5h3.4l9.2 11H20"/><path d="M4 17.5h3.4l2.6-3.1"/><path d="M17.4 3.9 20 6.5l-2.6 2.6"/><path d="M17.4 14.9 20 17.5l-2.6 2.6"/>'
      : '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h9"/><path d="m16.4 15.4 2.4 1.6-2.4 1.6"/>'
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
}
function iosCycleMode() {
  const order = ['order', 'single', 'shuffle']
  const i = order.indexOf(S.mode)
  const next = order[(i + 1) % order.length] || 'order'
  setPlayMode(next)
  iosSheetRender()
  iosRenderNav()
}

function iosMoreSheetHtml() {
  const t = S.current
  const liked = !!(t && (S.favorites || []).some((x) => x.key === t.key))
  const rows = [
    ['artist', '歌手', t?.artist || '—'],
    ['album', '专辑', t?.album || '—'],
    ['quality', '音质', iosQualityLabel()],
    ['speed', '倍速播放', S.rate && Number(S.rate) !== 1 ? `${S.rate}x` : '正常'],
    ['timer', '定时关闭', S.sleepMin ? `${S.sleepMin} 分钟` : '未开启'],
    ['lyric', '歌词', S.lyrics?.lines?.length ? '已匹配' : '暂无'],
    ['like', liked ? '取消喜欢' : '喜欢这首歌', ''],
  ]
  return `<div class="ios-sheet-card ios-more-card">
    <div class="ios-more-head">
      <span class="ios-more-cv">${t ? coverHtml(t) : '<span class="ios-ent-ph">♪</span>'}</span>
      <span class="ios-more-meta"><b>${esc(t?.title || '还没有播放')}</b><i>${esc(t?.artist || '')}</i></span>
      <button class="ios-more-shuffle ios-mode-btn" data-ios-mode aria-label="播放模式：${esc(iosModeLabel())}" title="${esc(iosModeLabel())}">${iosModeIcon()}</button>
    </div>
    <div class="ios-more-tools">
      <button class="ios-mt" data-ios-mt="add"><span>${IOS_IC.plus}</span><i>添加到</i></button>
      <button class="ios-mt" data-ios-mt="timer"><span><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.4a8 8 0 1 0 0-16 8 8 0 0 0 0 16"/><path d="M12 8v4.6l3 1.8"/></svg></span><i>定时</i></button>
      <button class="ios-mt" data-ios-mt="quality"><span><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.4 8.4 9l3.4 5 2.6-3.4 5.6 5.8"/></svg></span><i>音质</i></button>
      <button class="ios-mt" data-ios-mt="speed"><span><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16.4a8 8 0 1 1 14 0"/><path d="M12 12l4-3"/></svg></span><i>倍速</i></button>
    </div>
    <div class="ios-more-rows">${rows.map(([k, label, val]) => `
      <button class="ios-mrow" data-ios-row="${k}">
        <span class="ios-mrow-ico">${iosRowIcon(k)}</span>
        <span class="ios-mrow-label">${label}</span>
        <span class="ios-mrow-val">${esc(val)}</span>
      </button>`).join('')}
    </div>
  </div>`
}

function iosRowIcon(k) {
  const d = {
    artist: 'M9 8.4a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 0 0-6.4 0M4.6 20c.9-3 3.6-4.6 7.4-4.6s6.5 1.6 7.4 4.6',
    album: 'M12 20.4a8.4 8.4 0 1 0 0-16.8 8.4 8.4 0 0 0 0 16.8M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8',
    timer: 'M12 20.4a8 8 0 1 0 0-16 8 8 0 0 0 0 16M12 8v4.6l3 1.8',
    quality: 'M4 16.4 8.4 9l3.4 5 2.6-3.4 5.6 5.8',
    speed: 'M5 16.4a8 8 0 1 1 14 0M12 12l4-3',
    lyric: 'M4.6 7h10M4.6 12h7M4.6 17h5M18 8.6v7.8',
    like: 'M12 20.2s-7.4-4.6-7.4-10A4.14 4.14 0 0 1 12 7.9a4.14 4.14 0 0 1 7.4 2.3c0 5.4-7.4 10-7.4 10z',
  }[k] || 'M12 20.4a8.4 8.4 0 1 0 0-16.8 8.4 8.4 0 0 0 0 16.8'
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
}

function iosQualityLabel() {
  const map = { auto: '自动', lossless: '无损', hq: '高品质', sq: '标准', lq: '流畅' }
  return map[S.quality] || '标准'
}
function iosCycleQuality() {
  const order = ['auto', 'lossless', 'hq', 'sq', 'lq']
  const i = Math.max(0, order.indexOf(S.quality))
  S.quality = order[(i + 1) % order.length]
  try { S.core?.quality?.setPref?.(S.quality) } catch { /* 忽略 */ }
  try { syncQualityLabels?.() } catch { /* 忽略 */ }
  iosSheetRender()
}
function iosCycleRate() {
  const order = [1, 1.25, 1.5, 2, 0.8]
  const cur = Number(S.rate) || 1
  const i = Math.max(0, order.indexOf(cur))
  S.rate = order[(i + 1) % order.length]
  const a = $('#previewAudio')
  if (a) a.playbackRate = S.rate
  iosSheetRender()
}
let iosSleepTimer = 0
function iosCycleSleep() {
  const order = [0, 15, 30, 60]
  const cur = Math.round(Number(S.sleepMin) || 0)
  const i = Math.max(0, order.indexOf(cur))
  const next = order[(i + 1) % order.length]
  S.sleepMin = next
  clearTimeout(iosSleepTimer)
  if (next) {
    iosSleepTimer = setTimeout(() => {
      if (S.playing) togglePlay()
      S.sleepMin = 0
      iosSheetRender()
    }, next * 60000)
  }
  iosSheetRender()
}

function iosSheetRender() {
  const el = $('#iosSheet'), mask = $('#iosMask')
  if (!el) return
  if (!iosSheetKind) { el.hidden = true; if (mask) mask.hidden = true; return }
  el.innerHTML = iosSheetKind === 'queue' ? iosQueueSheetHtml() : iosMoreSheetHtml()
  el.hidden = false
  if (mask) mask.hidden = false
  paintDynamics(el)
  if (iosSheetKind === 'queue') iosFocusQueueNow()
}

// 播放列表打开时把「正在播放」那一行滚到可视区中央。
// 以前只渲染不定位，队列一长用户看到的全是开头几首，当前曲藏在下面（截图里的现象）。
// 不用 scrollIntoView：它可能连带把整个页面/播放页一起滚走；只改列表自身的 scrollTop。
function iosFocusQueueNow() {
  const el = $('#iosSheet')
  if (!el || el.hidden || iosSheetKind !== 'queue') return
  const list = el.querySelector('.ios-q-list')
  const on = el.querySelector('.ios-q-row.on') || el.querySelector('[data-ios-now]')
  if (!list || !on) return
  const scroll = () => {
    const lr = list.getBoundingClientRect(), nr = on.getBoundingClientRect()
    const delta = (nr.top - lr.top) - (list.clientHeight / 2 - nr.height / 2)
    list.scrollTop = Math.max(0, list.scrollTop + delta)
  }
  scroll()
  // 入场动画 / 封面异步加载会改变行高，补两次校准，避免停在半行位置
  requestAnimationFrame(scroll)
  setTimeout(scroll, 260)
}
function iosSheetShow(kind) { iosSheetKind = kind; iosSheetRender() }
function iosSheetHide() { iosSheetKind = ''; iosSheetRender() }

// ── 私人推荐「无限续杯」────────────────────────────────────────────
// 规则：这批推荐只有 6 首；在最后一首「播完」或「上滑切下一首」时，
// 不停在末尾也不回卷，而是向服务端要 6 首没听过的全新推荐接在后面继续播。
// 去重键只用规范化歌名（和服务端 norm 同款），保证两端口径一致。
const REC_FLOW_KEY = 'orangemusic:recflow'
const omNorm = (s) => String(s || '').toLowerCase().replace(/[\s\-_·.()（）[\]【】「」《》,，、!！?？'"]/g, '')
const recKey = (t) => omNorm(t?.title)
let iosRecFlow = false
let iosRecSeen = new Set()
let iosRecBusy = false
function iosStartRecFlow(list) {
  iosRecFlow = true
  iosRecSeen = new Set((list || []).map(recKey).filter(Boolean))
  try { localStorage.setItem(REC_FLOW_KEY, '1') } catch { /* 隐私模式 */ }
}
function iosStopRecFlow() {
  iosRecFlow = false
  iosRecSeen = new Set()
  try { localStorage.removeItem(REC_FLOW_KEY) } catch { /* 隐私模式 */ }
}
function iosRestoreRecFlow() {
  try {
    if (localStorage.getItem(REC_FLOW_KEY) !== '1') return
    iosRecFlow = true
    iosRecSeen = new Set((S.queue || []).map(recKey).filter(Boolean))
  } catch { /* 隐私模式 */ }
}

// 拉一批全新的 6 首：服务端按 exclude 从池子里剔除已听过的，池子被听空会自动重建。
// 客户端再做一次去重，最多重试 3 次凑满 6 首。
async function iosRefreshRecFlow() {
  if (iosRecBusy) return false
  iosRecBusy = true
  try {
    // 把当前这批也记进已听集合：重启恢复后 seen 可能为空，否则会换回刚听过的歌
    for (const t of S.queue || []) { const k = recKey(t); if (k) iosRecSeen.add(k) }
    if (iosRecSeen.size > 300) iosRecSeen = new Set([...iosRecSeen].slice(-240))
    const exclude = [...iosRecSeen].slice(-90).join('||')
    const fresh = []
    for (let attempt = 0; attempt < 3 && fresh.length < 6; attempt++) {
      const q = new URLSearchParams({ n: '6', r: `${Date.now()}_${attempt}` })
      if (exclude) q.set('exclude', exclude)
      const j = await iosApi(`/api/recommend?${q.toString()}`, 0)
      for (const t of iosNormList(j?.tracks || [])) {
        const k = recKey(t)
        if (!k || iosRecSeen.has(k)) continue
        iosRecSeen.add(k)
        fresh.push(t)
        if (fresh.length >= 6) break
      }
      if (fresh.length >= 6) break
    }
    if (!fresh.length) { toast('暂时没取到新推荐，稍后再试'); return false }
    // 「刷新全新的 6 首」= 队列整体换掉，播放列表里始终只有这一批 6 首。
    S.queue = capQ(fresh.slice(0, 6))
    S.iosRec = S.queue.slice()
    S.iosSource = '私人推荐'
    try { S.core?.covers?.prefetchCovers?.(fresh, 6) } catch { /* 无封面核心 */ }
    // 自动续播：不抢播放页、不重复触发解锁，但必须是队列里已经存在的那一条
    playTrack(fresh[0], 0, { auto: true })
    toast('已换上 6 首全新的私人推荐')
    return true
  } catch { toast('网络不稳定，稍后再试'); return false }
  finally { iosRecBusy = false }
}

// 播放页 iOS 专属元素同步（标题 / 标签 / 喜欢态）
function iosSyncNp() {
  if (!IS_IOS) return
  const t = S.current
  const src = $('#iosNpSource')
  if (src) src.textContent = iosSourceName()
  const badges = $('#iosNpBadges')
  if (badges) {
    // 歌手已经单独一行显示在歌名下方，这里只留音质标签
    badges.innerHTML = t ? `<i>${esc(iosQualityLabel())}</i>` : ''
  }
  const tag = $('#iosNpTag')
  if (tag) {
    const who = String(t?.artist || '').trim()
    if (who) { tag.hidden = false; tag.textContent = Array.from(who).slice(0, 2).join('') }
    else tag.hidden = true
  }
  const lk = $('#iosNpLikeCount')
  if (lk) {
    const on = !!(t && (S.favorites || []).some((x) => x.key === t.key))
    lk.textContent = on ? '已喜欢' : '喜欢'
    $('#iosNpLike')?.classList.toggle('on', on)
  }
  // 播放页不再显示「自动音质」小字；音质仍可在操作行切换。
  const hint = $('#iosNpHint')
  if (hint) { hint.textContent = ''; hint.hidden = true }
  // 操作行里的音质按钮：图标 + 当前档位文字
  const qtag = $('#iosNpQualityTag')
  if (qtag) qtag.textContent = iosQualityLabel()
  const bar = $('#tabbar')
  if (bar) bar.classList.toggle('in-player', iosNowPlayingOpen())
}

function iosOpenPlayer() {
  const el = $('#nowPlaying')
  if (el) el.hidden = false
  // 回播放页必须清掉 Music / 乐库 分页标记，否则底层 #view 仍会渲染乐库页，
  // 后续收起播放页或整页重绘时会出现「播放页和乐库页叠在一起」的状态不一致。
  S.iosView = ''
  iosSetDrawer(false)
  // 打开播放页时顺手收掉可能残留的底部弹层（队列 / 更多）与其遮罩，
  // 否则遮罩（z-index 60）会盖在播放页（z 30）上，导致「切歌/上下滑/点队列都没反应」。
  try { iosSheetHide() } catch { /* 弹层未就绪 */ }
  try { updatePlayerBar() } catch { /* ignore */ }
  try { iosSyncNp() } catch { /* ignore */ }
  try { iosRenderNav() } catch (e) { console.warn('[iOS] renderNav', e && e.message) }
  try { renderProgress() } catch (e) { console.warn('[iOS] progress', e && e.message) }
  // 进播放页就要有歌词：以前只在 updatePlayerBar 里被动触发，
  // 恢复上次播放（没有触发换歌事件）时歌词区会一直是空的。
  try {
    renderLyrics()
    if (S.current && (!S.lyrics?.lines?.length) && !S.lyrics?.loading) loadLyricsFor(S.current)
  } catch { /* 歌词模块未就绪 */ }
}
// 从抽屉/我的里播放一组歌：整组入队 + 从头播
function iosPlayList(list, sourceName = '私人推荐') {
  if (!Array.isArray(list) || !list.length) return
  // 四宫格点歌必须「点下就收起抽屉」：以前只靠 playTrack 起播成功后那句 iosOpenPlayer()，
  // 取链慢 / 失败时永远走不到 → 抽屉一直盖着（用户反馈「偶发没收起侧边栏」）。
  // 改在点击的同步栈里立刻收起并回到播放页，完全不依赖异步结果。
  iosSetDrawer(false)
  const np = $('#nowPlaying'); if (np) np.hidden = false
  S.iosView = ''
  S.iosSource = sourceName
  const rows = iosNormList(list)
  S.queue = capQ(rows)
  // 只有「私人推荐」这一组启用无限续杯；其它列表（电台 / 歌单 / 榜单）都按普通队列播
  if (sourceName === '私人推荐') iosStartRecFlow(rows)
  else iosStopRecFlow()
  playTrack(S.queue[0], 0)
  iosRenderNav()
}
function iosOpenMusic(view = 'music') {
  const np = $('#nowPlaying')
  if (np) np.hidden = true
  iosCloseLyrics()
  iosSetDrawer(false)
  iosSheetHide()
  S.page = null
  S.section = 'home'
  S.iosView = view
  render()
  iosRenderNav()
}

function iosGoto(tab, keepLib = false) {
  if (tab === 'player') {
    iosOpenPlayer()
    return
  }
  if (tab === 'home' || tab === 'hall') {
    iosSetDrawer(true)
    return
  }
  const np = $('#nowPlaying')
  if (np) np.hidden = true
  iosSheetHide()
  iosSetDrawer(false)
  S.page = null
  // 从 Mine 点「喜欢 / 最近播放 / 本地」进来时 S.iosLib 是刚设好的目标子页，
  // 不能无条件清空（旧实现把它清成 ''，导致三个入口点了永远停在 Mine 首页）。
  if (!keepLib) S.iosLib = ''
  if (tab === 'mine') S.section = 'library'
  else if (tab === 'search') S.section = 'search'
  else if (tab === 'settings') { S.section = 'settings'; S.iosSetTab = 'settings' }
  render()
  iosRenderNav()
}

// 启动：直接进播放页；有上次的歌就续上（用户要求「进来就播上次那首」）
// 播放页歌词区：轻点进歌词详情页，下滑切下一首（对应用户 «点击进入歌词页 / 下滑切歌»）
function bindNpGestures() {
  // 以前只绑在「歌词那一列」上，于是在封面/转盘区域上下滑完全没反应
  // （用户反馈的「下滑上一首失效」）。现在整页都能滑，只跳过滚动歌词区、
  // 按钮行和播放条 —— 那句「歌词能滑」其实是在滚歌词，不该顺手切歌。
  const np = document.getElementById('nowPlaying')
  if (!np || np.dataset.npGesture === '1') return
  np.dataset.npGesture = '1'
  let y0 = 0, x0 = 0, t0 = 0, moved = false, fromScroll = false
  const skipSwipe = (el) => !!(el && el.closest && el.closest('#npLyrics, .np-ios-actions, .np-bar, .ios-sheet, button, input, textarea, select'))
  np.addEventListener('touchstart', (e) => {
    const t = e.touches[0]
    if (!t) return
    fromScroll = skipSwipe(e.target)
    y0 = t.clientY; x0 = t.clientX; t0 = Date.now(); moved = false
  }, { passive: true })
  np.addEventListener('touchmove', (e) => {
    const t = e.touches[0]
    if (!t) return
    if (Math.abs(t.clientY - y0) > 12 || Math.abs(t.clientX - x0) > 12) moved = true
  }, { passive: true })
  np.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]
    if (!t) return
    const dy = t.clientY - y0
    const dx = t.clientX - x0
    if (Date.now() - t0 > 800) return
    // 上滑 → 下一首；下滑 → 上一首（与底部 dock 手势一致）
    if (!fromScroll && Math.abs(dy) > 46 && Math.abs(dy) > Math.abs(dx)) {
      next(dy < 0 ? 1 : -1)
      return
    }
    // 轻点歌词 / 封面 → 进歌词页
    if (!moved && e.target.closest && e.target.closest('.np-lyric-col, .np-stage')) iosOpenLyrics()
  }, { passive: true })
  // 鼠标环境点歌词区也能进歌词页；但刚点完歌曲列表（播放页刚盖上来）的那一下不算，
  // 否则「点歌 → 页面切到播放页 → 同一下点击落在歌词区」会直接跳进歌词页。
  const col = np.querySelector('.np-lyric-col')
  if (col) {
    col.addEventListener('click', () => {
      if ('ontouchstart' in window) return
      if (Date.now() - (window.__omLastTrackAt || 0) < 600) return
      iosOpenLyrics()
    })
  }
}

function iosBoot() {
  if (!IS_IOS) return
  // ★ 关键：每一步各自兜底。以前 iosOpenPlayer() 一旦抛错，后面的 bindIosDockSwipe /
  //   bindNpGestures / iosLoadFeed 会被一并跳过 —— 手势全失效、首页无歌，
  //   表现正是「未在播放 + 上下滑/切歌/队列/点页面全没反应」。
  //   现在先绑手势、先拉数据，最后再开播放页，任何一步失败都不影响其它步。
  // 应用用户对「锁屏接管」的选择：关掉的人重开软件也不该再被注册卡片
  // 锁屏 / 控制中心接管默认开启（设置里已不提供开关）
  try { native.setMediaSession?.(true) } catch { /* 无宿主 */ }
  try { iosRestoreRecFlow() } catch (e) { console.warn('[iOS] recFlow', e && e.message) }
  try { iosMountDrawer() } catch (e) { console.warn('[iOS] drawer', e && e.message) }
  try { bindIosDockSwipe() } catch (e) { console.warn('[iOS] dockSwipe', e && e.message) }
  try { bindNpGestures() } catch (e) { console.warn('[iOS] npGestures', e && e.message) }
  try { iosLoadFeed() } catch (e) { console.warn('[iOS] feed', e && e.message) }
  try { iosOpenPlayer() } catch (e) { console.warn('[iOS] openPlayer', e && e.message) }
  // 「启动时恢复上次播放」必须真正生效：过去这里无条件读 S.resume 并自动 play，
  // 关掉开关照样续上，还会在没有用户手势的情况下触发播放（iOS Safari 必定拒绝）。
  if (!S.settings.resumeLast) { S.resume = null; return }
  const t = S.current || S.resume?.track
  if (!t) return
  if (!S.current) {
    S.current = { ...t, streams: [] }
    if (S.resume?.queue?.length) S.queue = capQ(S.resume.queue).map((x) => ({ ...x, streams: [] }))
    S.positionMs = 0
    try { updatePlayerBar() } catch { /* ignore */ }
  }
  try { iosSyncNp(); iosRenderNav() } catch { /* ignore */ }
  // 用户要求：进软件就回到上次那首并「自动续播」。iOS 没有用户手势时可能拒绝播放授权，
  // 所以用 noSkip 安全尝试：成功就直接播；被拒就停在这首（不跳歌、不报错），点播放即可续上。
  try {
    if (S.current && !S.playing) {
      playTrack(S.current, 0, { noSkip: true }).catch(() => { /* 授权被拒：忽略 */ })
    }
  } catch { /* ignore */ }
}

document.addEventListener('click', (e) => {
  if (!IS_IOS) return
  const q = (sel) => e.target.closest(sel)

  if (q('[data-ios-sheet-close]') || q('#iosMask')) { iosSheetHide(); return }
  if (q('#iosDrawerMask')) { iosSetDrawer(false); return }
  if (q('[data-ios-drawer]')) {
    // dock 首页键只做一件事：切到 Music 分页。不做「再点一次回播放页」的 toggle，
    // 避免在抽屉/播放页残留状态下行为不一致；回播放页由 Music 页左上 ‹ 负责。
    iosOpenMusic('music')
    return
  }
  // Music / 乐库 页
  const mtab = q('[data-ios-mtab]')
  if (mtab) { iosOpenMusic(mtab.dataset.iosMtab); return }
  // 设置页「设置 / 关于」两个卡片切换
  const setTab = q('[data-ios-settab]')
  if (setTab) { S.iosSetTab = setTab.dataset.iosSettab; render(); return }
  if (q('[data-ios-search]')) { iosCloseLyrics(); iosGoto('search'); return }
  const mplay = q('[data-ios-mplay]')
  if (mplay) {
    const list = S.iosRec || []
    const i = Number(mplay.dataset.iosMplay)
    if (list[i]) { S.queue = capQ(list); S.iosSource = '私人推荐'; iosStartRecFlow(list); playTrack(list[i], i) }
    else toast('推荐还没准备好，稍后再试')
    return
  }
  if (q('[data-ios-fresh2]')) {
    // 「偶遇心动单曲」渲染的是 S.iosRec（/api/recommend），旧实现却去刷新 S.iosNew（/api/new），
    // 所以点了「换一批」永远还是原来那几首。改回同一数据源并带随机参数绕开各级缓存。
    // 带上已听过的曲目，避免「换一批」换回刚听过的歌；续杯时也不会重复
    const excl = iosRecFlow ? [...iosRecSeen].slice(-90).join('||') : ''
    const url = `/api/recommend?n=6&exclude=${encodeURIComponent(excl)}&r=${Date.now()}`
    iosApi(url, 0).then((j) => {
      if (j?.tracks?.length) {
        S.iosRec = iosNormList(j.tracks)
        if (iosRecFlow) S.iosRec.forEach((t) => { const k = recKey(t); if (k) iosRecSeen.add(k) })
        try { S.core?.covers?.prefetchCovers?.(S.iosRec.slice(0, 6), 6) } catch { /* 无核心 */ }
        iosOpenMusic('music'); toast('已换一批')
      } else toast('暂时没取到新推荐，稍后再试')
    }).catch(() => toast('网络不稳定，稍后再试'))
    return
  }
  // 你的私荐歌单：点开就整单播放
  const plopen = q('[data-ios-plopen]')
  if (plopen) {
    const id = plopen.dataset.iosPlopen
    iosApi(`/api/playlist?id=${encodeURIComponent(id)}`, 30 * 60 * 1000).then((j) => {
      const list = iosNormList(j?.tracks || [])
      if (!list.length) return toast('这个歌单暂时取不到曲目')
      S.iosView = ''
      iosPlayList(list, j?.name || '私荐歌单')
    }).catch(() => toast('网络不稳定，稍后再试'))
    return
  }
  if (q('[data-ios-plrefresh]')) {
    iosApi(`/api/playlists?n=8&fresh=1&r=${Date.now()}`, 0).then((j) => {
      if (j?.list?.length) { S.iosPlaylists = j.list; iosOpenMusic('music'); toast('已换一批') }
    }).catch(() => toast('网络不稳定，稍后再试'))
    return
  }
  const libq = q('[data-ios-libq]')
  if (libq) {
    const key = libq.dataset.iosLibq
    iosSearch(key, 30).then((j) => {
      const list = iosNormList(j?.list || [])
      if (list.length) iosPlayList(list, key); else toast(`「${key}」暂时取不到曲目`)
    }).catch(() => toast('网络不稳定，稍后再试'))
    return
  }
  // 歌词详情页
  if (q('[data-ios-lyclose]')) { iosCloseLyrics(); return }
  if (q('[data-ios-lytr]')) { iosTlyricOn = !iosTlyricOn; iosRenderLyricsPage(); return }
  if (q('[data-ios-lynext]')) { next(1); return }
  if (q('[data-ios-lyprev]')) { next(-1); return }
  if (q('[data-ios-lylike]')) { toggleLike(); iosRenderLyricsPage(); iosSyncNp(); return }
  const go = q('[data-ios-go]')
  if (go) { iosGoto(go.dataset.iosGo); return }
  // 播放/暂停 要先于 open 判定：Music/乐库 分页里的小卡「播放键」嵌在带 data-ios-open 的小卡内，
  // 点播放键应切换播放而非返回播放页。
  if (q('[data-ios-toggle]')) {
    // 刚才在胶囊上做过上下滑手势：这一下 click 是手势的尾巴，不能再当成播放/暂停
    if (Date.now() - iosDockSwipeAt < 420) return
    ;(window.__omToggle || (() => {}))()
    return
  }
  if (q('[data-ios-open]')) { iosOpenPlayer(); return }
  // 播放页左上 ≡ ：召出「听你想听」左侧抽屉（与旧版一致）
  if (q('[data-ios-opendrawer]')) { iosSetDrawer(true); return }
  if (q('[data-ios-queue]')) { iosSetDrawer(false); iosSheetShow('queue'); return }
  if (q('[data-ios-more]')) { iosSheetShow('more'); return }
  if (q('[data-ios-login]')) {
    // 点头像 = 更换头像，交给全局 [data-avatar] 委托；不要误触发登录 / 已登录提示
    if (e.target.closest('[data-avatar]')) return
    if (S.session) { S.identity && toast('已登录：' + (readDisplayName() || '')); }
    else openLoginSheet()
    return
  }
  if (q('[data-ios-libback]')) { S.iosLib = ''; render(); return }
  if (q('[data-ios-playlib]')) {
    const { list } = iosLibSource()
    if (list.length) { iosPlayList(list, iosLibSource().title); }
    else toast('这里还没有歌')
    return
  }
  const libPlay = q('[data-ios-libplay]')
  if (libPlay) {
    const { title, list } = iosLibSource()
    const i = Number(libPlay.dataset.iosLibplay)
    if (list[i]) { S.queue = capQ(list); S.iosSource = title; playTrack(list[i], i) }
    return
  }

  if (q('[data-ios-rec]')) { iosPlayList(S.iosRec || S.iosHot || [], '私人推荐'); return }
  if (q('[data-ios-charts]')) { iosPlayList(S.iosRank || S.iosRise || [], '热歌熟悉'); return }
  if (q('[data-ios-fresh]')) { iosPlayList(S.iosNew || S.iosRise || [], '新鲜探索'); return }
  if (q('[data-ios-fav]')) {
    if ((S.favorites || []).length) iosPlayList(S.favorites, '我喜欢的')
    else { S.iosLib = 'like'; iosGoto('mine') }
    return
  }
  const radio = q('[data-ios-radio]')
  if (radio) {
    const r = IOS_RADIO.find((x) => x.id === radio.dataset.iosRadio)
    if (!r) return
    // 点电台立刻回播放页并收起侧栏（用户要求），曲目在后台取，取到就播
    iosSetDrawer(false)
    S.iosView = ''
    iosOpenPlayer()
    iosSearch(r.q, 30).then((j) => {
      const list = iosNormList(j?.list || [])
      // 顺手把这个主题第一张真实封面记下来，下次进抽屉不用再等
      const c = list.find((x) => x.cover) || null
      if (c) {
        const map = S.iosStnCover instanceof Map ? S.iosStnCover : new Map()
        map.set(r.id, c.cover)
        S.iosStnCover = map
      }
      if (list.length) iosPlayList(list, r.name)
      else toast(`「${r.name}」暂时取不到曲目`)
    }).catch(() => toast(`「${r.name}」网络不稳定，稍后再试`))
    return
  }
  if (q('[data-ios-settings]')) { iosGoto('settings'); return }

  const lib = q('[data-ios-lib]')
  if (lib) {
    const key = lib.dataset.iosLib
    S.iosLib = key === '喜欢' ? 'like' : key === '最近播放' ? 'recent' : 'local'
    iosGoto('mine', true)
    iosLoadLibData(S.iosLib)
    return
  }
  const libAct = q('[data-ios-libact]')
  if (libAct) {
    if (libAct.dataset.iosLibact === 'import') orangeLoadLocal()
    else iosOpenMusic('music')
    return
  }

  const jump = q('[data-ios-jump]')
  if (jump) {
    const jk = jump.dataset.iosJump
    const t = (S.queue || []).find((x) => x.key === jk) || (S.current?.key === jk ? S.current : null)
    if (t) {
      iosSheetHide()
      // 队列里点歌要「立刻」响：先用预取好的直链，没预取到再回源
      if (!t.streams?.length) { try { S.core?.sources?.applyPrefetched?.(t) } catch { /* 无预取 */ } }
      playTrack(t)
    }
    return
  }
  const del = q('[data-ios-qdel]')
  if (del) {
    S.queue.splice(Number(del.dataset.iosQdel), 1)
    iosSheetRender(); iosRenderNav(); return
  }
  if (q('[data-ios-qclear]')) { S.queue = S.current ? [S.current] : []; iosSheetRender(); iosRenderNav(); return }
  if (q('[data-ios-mode]')) { iosCycleMode(); return }
  if (q('[data-ios-mode-shuffle]')) { iosCycleMode(); return }
  // 自建歌单「新建歌单」：旧代码调用的 openPlaylistCreate 从未定义，typeof 恒 false
  // → 点了完全没反应。改成直接创建，离线也能建。
  if (q('[data-ios-plnew]')) { iosCreatePlaylist(); return }
  // 头部「导入歌单」：复用平台歌单解析弹层（QQ / 网易云 / 酷狗 / 酷我 / 文本 / JSON）
  if (q('[data-ios-plimport]')) {
    const sh = $('#importSheet')
    if (sh) {
      sh.hidden = false
      const inp = $('#importInput')
      if (inp) setTimeout(() => { try { inp.focus() } catch { /* ignore */ } }, 60)
    }
    return
  }

  const row = q('[data-ios-row]')
  if (row) {
    const k = row.dataset.iosRow
    const t = S.current
    if (k === 'artist' && t?.artist) { iosSheetHide(); openArtistPage(t.artist) }
    else if (k === 'album' && t?.album) { iosSheetHide(); openAlbumPage(t.album) }
    else if (k === 'quality') iosCycleQuality()
    else if (k === 'speed') iosCycleRate()
    else if (k === 'timer') iosCycleSleep()
    else if (k === 'like') { toggleLike(); iosSheetRender(); iosSyncNp() }
    return
  }
  const mt = q('[data-ios-mt]')
  if (mt) {
    const k = mt.dataset.iosMt
    if (k === 'add') {
      if (!S.current?.key) return toast('先播放一首歌')
      // 以「添加到」按钮本身为锚点，让歌单列表在按钮附近弹出（不再默认到右上角）
      openPickSheet([S.current.key], mt)
    } else if (k === 'timer') iosCycleSleep()
    else if (k === 'quality') iosCycleQuality()
    else if (k === 'speed') iosCycleRate()
    return
  }
  if (q('#iosNpMenu') || q('#iosNpQueue')) { iosSheetShow('queue'); return }
  if (q('[data-ios-quality]')) { iosCycleQuality(); iosRenderNav(); return }
  if (q('#iosNpMore')) { iosSheetShow('more'); return }
  if (q('#iosNpSearch')) { iosGoto('search'); return }
  if (q('#iosNpLike')) { toggleLike(); iosSyncNp(); return }
  // 兜底：列表行若因「动态渲染后没重新绑定 onclick」而点不动，用委托兜住。
  // 已绑定的行会在自身 onclick 里 stopPropagation，不会重复触发；playRowByKey 另有 450ms 去重。
  const iplay = q('[data-play]')
  if (iplay && iplay.dataset.play && !iplay.closest('#npqList, .npq-row, #npQueuePanel')) {
    playRowByKey(iplay.dataset.play); return
  }
})


function hallHtml() {
  let body = ''
  if (S.hallTab === '歌单广场') {
    // 歌单广场自己聚合（QQ / 网易云 / 酷狗 多品类），不再重复跑一遍「推荐歌单」请求
    body = hallPlazaHtml()
  } else if (S.hallTab === '歌手') {
    hallNeedDiscover()
    // 同步兜底：本机落盘 / 内置名录毫秒级上屏，首次启动也不会出现「正在取歌手名单…」
    if (!S.artistDir?.length && S.core?.discover?.peekArtistDirectory) {
      try { S.artistDir = S.core.discover.peekArtistDirectory() || [] } catch { /* noop */ }
    }
    loadArtistDir()
    const q = String(S.artistQuery || '').trim().toLowerCase()
    const filtered = S.artistSex !== 'all' || !!S.artistLetter || !!q
    const hot = filtered ? [] : (S.discover.artists || []).slice(0, 10)
    const hotNames = new Set(hot.map((a) => a.name))
    // ★ 只从「带 sex / initial 的权威名录」里筛，绝不把没有性别/字母的热门歌手混进来。
    //   搜索时忽略分类与字母，方便直接按名字 / 别名找到人。
    let dir = [...(S.artistDir || [])]
    if (q) dir = dir.filter((a) => String(a.name || '').toLowerCase().includes(q)
      || (a.alias || []).some((x) => String(x).toLowerCase().includes(q)))
    else {
      if (S.artistSex !== 'all') dir = dir.filter((a) => a.sex === S.artistSex)
      if (S.artistLetter) dir = dir.filter((a) => a.initial === S.artistLetter)
    }
    dir = dir.filter((a) => !hotNames.has(a.name))
    const letters = S.core?.discover?.ARTIST_LETTERS || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    // 按拼音首字母分组：鞠婧祎直接在 J 组可见，不用在近千个平铺名字里翻找
    const groups = letters.map((L) => ({ L, items: dir.filter((a) => a.initial === L) })).filter((g) => g.items.length)
    const other = dir.filter((a) => !letters.includes(a.initial))
    if (other.length) groups.push({ L: '#', items: other })
    const nameBtn = (a) => `<button class="orange-art-name" data-artist="${esc(a.name)}" title="${esc(a.name)}">${esc(a.name)}</button>`
    body = `<div class="orange-filter">
        <div class="chip-row"><span class="orange-art-count">共 ${dir.length} 位歌手</span>${SEX_TABS.map(([k, l]) => `<button class="chip ${S.artistSex === k ? 'on' : ''}" data-artsex="${k}">${l}</button>`).join('')}
          <input id="artistSearchInput" class="orange-art-search" placeholder="搜索歌手名" value="${esc(S.artistQuery || '')}" autocomplete="off">
          <button class="btn small" id="refreshArtistsBtn" title="重新拉取各平台最新歌手名录">刷新</button></div>
        <div class="chip-row letters">${letters.map((l) => `<button class="chip ${S.artistLetter === l ? 'on' : ''}" data-artletter="${l}" title="按 ${l} 筛选，再点一次取消">${l}</button>`).join('')}</div>
      </div>
      ${hot.length ? `<div class="orange-art-top">${hot.map((a, i) => `<button class="orange-art-hot" data-artist="${esc(a.name)}" title="${esc(a.name)}">
          <span class="orange-art-ava">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(a.name)}">♪</span>`}<i>${i + 1}</i></span>
          <b>${esc(a.name)}</b>
        </button>`).join('')}</div>` : ''}
      ${groups.length
        ? `<div class="orange-art-groups">${groups.map((g) => `<div class="orange-art-group"><div class="orange-art-letter">${g.L}</div>
             <div class="orange-art-list">${g.items.map(nameBtn).join('')}</div></div>`).join('')}</div>`
        : `<div class="empty">${S.artistBusy ? '正在取歌手名单…' : (q ? `没有匹配「${esc(S.artistQuery)}」的歌手` : '这个筛选下没有取到歌手，换个分类或首字母试试。')}
             <button class="btn small mt8" id="retryArtistsBtn">重新获取</button></div>`}`
  } else if (S.hallTab === '专辑') {
    const albums = new Map()
    for (const t of allChartTracks()) {
      if (!t.album) continue
      if (!albums.has(t.album)) albums.set(t.album, { key: t.album, title: t.album, artist: t.artist, cover: t.cover || '' })
    }
    const list = [...albums.values()]
    body = list.length
      ? `<div class="section-head compact"><div><h2>榜上专辑</h2><p>由今日榜单曲目汇总，按曲目归属去重</p></div></div>
         <div class="grid">${list.map((a) => `<button class="card" data-album="${esc(a.title)}" data-albumartist="${esc(a.artist || '')}"><div class="cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(a.title)}">▤</span>`}</div><div class="card-title">${esc(a.title)}</div><div class="card-sub">${esc(a.artist)}</div></button>`).join('')}</div>`
      : '<div class="empty">正在汇总榜单专辑…稍后再看，或先去首页的今日榜单点开一个榜。</div>'
  } else if (S.hallTab === '电台') {
    if (S.core && !S.radioBusy) warmRadio(100)
    const upd = S.radioAt ? new Date(S.radioAt).toTimeString().slice(0, 5) : '后台更新中'
    body = `<div class="section-head compact"><div><h2>电台</h2><p>${RADIO_STATIONS.length} 个频道 · 每台 100 首 · 后台自动刷新 · 最后更新 ${upd}</p></div>
        <button class="btn small" id="refreshRadioBtn">立即刷新</button></div>
      ${ccGrid(RADIO_STATIONS.map(radioChartOf))}`
  }
  S.batchTracks = []
  return `<div class="orange-hall">${head('乐馆', '歌单广场 · 歌手 · 专辑 · 电台')}${tabsHtml(HALL_TABS, S.hallTab, 'hall')}<div class="mt8">${body}</div></div>`
}

function searchHtml() {
  const hots = S.core ? S.core.charts.hotSearches(10) : HOT_SEARCHES
  const isSongs = S.searchTab === '单曲'
  const isPlaylists = S.searchTab === '歌单'
  const results = isSongs ? S.searchResults
    : isPlaylists ? S.playlists.map((x) => ({ key: x.id, title: x.name, artist: `${x.tracks?.length || 0} 首` }))
      : []
  const entities = S.searchTab === '歌手' ? searchArtistCards()
    : S.searchTab === '专辑' ? searchAlbumCards() : []
  S.batchTracks = isSongs ? results : []
  const body = (isSongs || (isPlaylists && !IS_IOS))
    ? rowsHtml(results, isSongs ? { selectable: true } : {})
    : (isPlaylists && IS_IOS)
      ? ((S.searchPlaylists || []).length
        ? `<div class="pl-grid">${S.searchPlaylists.map((x) => `
            <button class="pl-card" data-ios-plopen="${esc(x.id)}">
              <span class="pl-cv"${x.cover ? ` data-blur="${esc(x.cover)}"` : ''}></span>
              <b>${esc(x.name)}</b>
              <i>${x.count ? x.count + ' 首' : ''}${x.creator ? ' · ' + esc(x.creator) : ''}</i>
            </button>`).join('')}</div>`
        : '<div class="empty">没有搜到相关歌单</div>')
      : entities.length
        ? `<div class="grid rec-grid entity-grid">${entities.map((x) => entityCardHtml(x, S.searchTab === '歌手' ? 'artist' : 'album', `${x.count} 首 · 点击查看全部作品`)).join('')}</div>`
        : '<div class="empty">先搜索一个关键词，再从「歌手 / 专辑」里点进去看完整曲目。</div>'
  const inner = `
    <div class="search-panel"><input class="field big" id="searchInput" placeholder="搜索歌曲 / 歌手 / 专辑" value="${esc(S.query || '')}">
    <div id="searchStatus" class="hint">${S.searchResults.length ? `找到 ${S.searchResults.length} 首可播放曲目` : '结果只来自已获授权的音源'}</div></div>
    <div class="section-head compact"><div><h2>热搜榜</h2><p>由各大榜单标签自动生成</p></div></div>
    <div class="chip-row">${hots.map((h) => `<button class="chip hot" data-hot="${esc(h)}">${esc(h)}</button>`).join('')}</div>
    <div class="section-head compact"><div><h2>搜索结果</h2></div></div>
    ${tabsHtml(SEARCH_TABS, S.searchTab, 'search')}
    ${isSongs ? listActionsHtml(S.batchTracks, { selectable: true }) : ''}
    <div class="mt16">${body}</div>`
  // iOS：顶部就是「返回 + 搜索框 + 取消」，不再用桌面端的大标题（用户要求可返回、输入框变短）
  if (IS_IOS) {
    return `<div class="ios-page ios-search">
      <header class="ios-search-head">
        <button class="ios-sback" data-ios-go="player" aria-label="返回播放页">‹</button>
        <input class="ios-sinput" id="searchInput" placeholder="搜索歌曲 / 歌手 / 专辑" value="${esc(S.query || '')}">
        <button class="ios-scancel" data-ios-go="player">取消</button>
      </header>
      <div id="searchStatus" class="hint ios-sstatus">${S.searchResults.length ? `找到 ${S.searchResults.length} 首可播放曲目` : ''}</div>
      <div class="ios-search-body">${inner}</div>
    </div>`
  }
  return `${head('搜索', '多源并行聚合 · 单曲按发行时间从新到旧排列')}${inner}`
}

// ---- 我的：总览（收藏 / 本地 / 最近播放 / 听歌报告） ----
let SEEKING = false   // 进度条拖动中：暂停自动刷新滑块
let eventsAt = 0
async function loadEvents(force = false) {
  if (!S.core) return S.events || []
  if (!force && S.events && Date.now() - eventsAt < 30000) return S.events
  try { S.events = await S.core.repo.recentEvents(400) } catch { S.events = S.events || [] }
  eventsAt = Date.now()
  return S.events
}

const msHuman = (ms) => {
  const m = Math.round((ms || 0) / 60000)
  return m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`
}

// 听歌报告：只用本机 / 云端已有的播放事件，不额外上报任何东西。
function reportStats(events = []) {
  const byKey = new Map(allTracks().map((t) => [t.key, t]))
  const plays = events.filter((e) => e.kind === 'play')
  const byArtist = new Map()
  let ms = 0
  const dayKeys = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    dayKeys.push(d.toISOString().slice(0, 10))
  }
  const days = new Map(dayKeys.map((k) => [k, 0]))
  for (const e of plays) {
    const t = byKey.get(e.track_key)
    if (t) {
      ms += t.durationMs || 0
      const a = t.artist || '未知艺人'
      byArtist.set(a, (byArtist.get(a) || 0) + 1)
    }
    const d = String(e.created_at || '').slice(0, 10)
    if (days.has(d)) days.set(d, days.get(d) + 1)
  }
  const top = [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const max = Math.max(1, ...days.values())
  return {
    plays: plays.length, ms, top,
    days: dayKeys.map((k) => ({ label: k.slice(5).replace('-', '/'), n: days.get(k) || 0, pct: Math.round(((days.get(k) || 0) / max) * 100) })),
  }
}

async function overviewHtml() {
  const r = reportStats(await loadEvents())
  S.batchTracks = S.favorites
  const who = S.session?.user?.name || '离线试用'
  return `
    <div class="ov-hero">
      <div class="ov-avatar"><span class="cover-fallback" data-hue="350">♥</span></div>
      <div class="ov-meta">
        <h2>${esc(who)}</h2>
        <p>${S.session ? `云端同步 · ${esc(S.device)}` : '离线试用 · 数据仅存本机'} · 收藏 ${S.favorites.length} 首 · 最近播放 ${S.recent.length} 首</p>
        <div class="btn-row">
          <button class="btn primary small" id="ovPlayFav">▶ 播放我喜欢</button>
          <button class="btn small" data-libjump="本地歌曲">⇩ 本地歌曲</button>
          <button class="btn small" id="ovImport">导入歌单</button>
        </div>
      </div>
    </div>
    <div class="stat-row">
      <button class="stat" data-libjump="我喜欢"><b>${S.favorites.length}</b><span>收藏</span></button>
      <button class="stat" data-libjump="最近播放"><b>${S.recent.length}</b><span>最近播放</span></button>
      <button class="stat" data-libjump="自建歌单"><b>${S.playlists.filter((p) => !p.fav).length}</b><span>自建歌单</span></button>
      <button class="stat" data-libjump="本地歌曲"><b>${S.localTracks.length}</b><span>本地歌曲</span></button>
    </div>
    <div class="section-head compact"><div><h2>听歌报告</h2><p>累计 ${r.plays} 次播放 · 约 ${msHuman(r.ms)}</p></div><button class="btn small" id="ovRefresh">刷新</button></div>
    <div class="report">
      <div class="report-days">
        <div class="report-cap">近 7 天播放次数</div>
        <div class="day-bars">${r.days.map((d) => `<div class="day-bar"><i data-bar="${d.pct}"></i><em>${d.label}</em><b>${d.n || ''}</b></div>`).join('')}</div>
      </div>
      <div class="report-top">
        <div class="report-cap">最常听的歌手</div>
        ${r.top.length
          ? r.top.map(([name, n], i) => `<div class="top-line"><span class="rank">${i + 1}</span><b>${esc(name)}</b><span class="cnt">${n} 次</span></div>`).join('')
          : '<div class="hint">还没有播放记录，听几首之后这里会自动统计。</div>'}
      </div>
    </div>
    <div class="section-head compact"><div><h2>最近播放</h2><p>最近 ${Math.min(6, S.recent.length)} 首 · 点行内 ▶ 续播</p></div><button class="btn small" data-libjump="最近播放">查看全部 ›</button></div>
    ${rowsHtml(S.recent.slice(0, 6))}`
}

// ── Windows · 音乐库（喜欢 / 最近播放 / 本地歌曲 / 试听列表）──
const ORANGE_LIB_TITLE = { '我喜欢': '喜欢', '最近播放': '最近播放', '本地歌曲': '本地歌曲', '试听列表': '试听列表' }
const orangeEmptyHtml = (text, btns = []) => `<div class="orange-empty">
  <span class="orange-empty-ico">
    <svg viewBox="0 0 64 64" width="104" height="104" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="7" y="7" width="50" height="50" rx="5"/>
      <path d="M15.5 7v50"/>
      <circle cx="37" cy="33" r="12.5"/>
      <circle cx="37" cy="33" r="2.2" fill="currentColor" stroke="none"/>
      <path d="M44.5 25.5a14 14 0 0 1 0 15"/>
      <path d="M48.5 21.5a19 19 0 0 1 0 23"/>
    </svg>
  </span>
  <p>${esc(text)}</p>
  ${btns.length ? `<div class="orange-empty-btns">${btns.map((b) => `<button class="orange-empty-btn" ${b.id ? `id="${b.id}"` : ''}>${b.act || ''}${esc(b.label)}</button>`).join('')}</div>` : ''}
</div>`

const orangeTrackRow = (t, i, { heart = false, tags = true } = {}) => {
  // 列表里不再显示「精品伴奏 / 无损 / 全景声」这类随机小标签，
  // 也不再在歌名后挂一个小圆播放标识（用户反馈太杂、会看成可点按钮）。
  indexTracks([t])
  const on = S.favorites.some((x) => x.key === t.key)
  const playing = S.current?.key && S.current.key === t.key
  const picking = !!S.orangePicking
  return `<div class="orange-tr${playing ? ' playing' : ''}${picking ? ' picking' : ''}" data-key="${esc(t.key)}">
    ${picking ? `<span class="orange-tr-pick"><input type="checkbox" data-pick="${esc(t.key)}" ${S.picked.has(t.key) ? 'checked' : ''} aria-label="选择 ${esc(t.title)}"></span>` : ''}
    <div class="orange-tr-cover">${coverHtml(t)}<button class="orange-tr-play" data-play="${esc(t.key)}" title="播放" aria-label="播放 ${esc(t.title)}"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg></button><span class="orange-tr-eq"><i></i><i></i><i></i></span></div>
    <div class="orange-tr-main">
      <div class="orange-tr-title"><span class="orange-tr-name">${esc(t.title)}</span></div>
      <div class="orange-tr-artist" data-artist="${esc(t.artist || '')}" title="搜索该歌手">${esc(t.artist || '未知艺人')}</div>
    </div>
    <div class="orange-tr-acts">
      ${heart ? `<button class="orange-tr-heart${on ? ' on' : ''}" data-rowheart="${esc(t.key)}" title="${on ? '取消喜欢' : '喜欢'}" aria-label="喜欢">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>
      </button>` : ''}
      <button class="orange-tr-act" data-rowmore="${esc(t.key)}" title="更多" aria-label="更多"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg></button>
    </div>
    <div class="orange-tr-album${playing ? ' on' : ''}"${t.albumName ? ` data-album="${esc(t.albumName)}" data-albumartist="${esc(t.artist || '')}" title="搜索该专辑"` : ''}>${esc(t.albumName || (playing ? t.title : ''))}</div>
    <div class="orange-tr-time">${t.durationMs ? mmss(t.durationMs) : '--:--'}</div>
  </div>`
}

// ── 个人主页（点顶栏头像进入）─────────────────────────────────────────
// 按需求只保留「我喜欢 / 创建的歌单」：视频、关注数、会员与勋章标识、上传的视频全部去掉。
// 账号身份一律取 auth.js 的 accountView()（落盘档案是唯一真源），session.user 只作兜底。
// 以前各处各读 S.session.user，SDK 会话结构一变就出现「已互绑却显示未绑定」「已登录却显示未登录」。
// 昵称读取：本机自定义名 → 本机缓存 → 云端 user_state/profile → 云端账户信息。
// 以前只读本机两处，缓存一清 / 换设备 / 重装就「用户名偶尔丢失」。
// 从云端恢复时顺手回写本机（自愈），下次启动不必再等云同步。
function persistDisplayName(v) {
  try { localStorage.setItem('orangemusic:profile:name', v) } catch { /* 隐私模式忽略 */ }
  // 只补 name，不标 nameCustom：避免把 SDK 自动名当成用户自定义昵称锁死
  try { S.core?.auth?.saveIdentity?.({ name: v }) } catch { /* noop */ }
}
function readDisplayName() {
  const a = S.core?.auth?.accountView?.() || {}
  if (a.nameCustom && a.name) return a.name
  try {
    const v = localStorage.getItem('orangemusic:profile:name')
    if (v) return v
  } catch { /* 隐私模式忽略 */ }
  // 云端 user_state/profile：改名时随 repo.setState 写入，跨设备最可靠
  const cloudName = String(S.profile?.name || '').trim()
  if (cloudName) { persistDisplayName(cloudName); return cloudName }
  // 云端账户信息 / SDK 会话：最后的兜底
  const acctName = String(a.name || '').trim()
  if (acctName) { persistDisplayName(acctName); return acctName }
  return ''
}

// 全应用唯一的显示名：侧栏 / 首页问候 / 账号按钮都走这里，杜绝「侧栏是 12、首页还是数字 ID」。
function displayName() {
  if (!S.session) return '未登录'
  const u = S.session.user || {}
  return readDisplayName() || String(u.name || u.email || u.phone || u.phone_number || '').trim() || '我的'
}
// 局部刷新名字标签，不整页重绘（避免打断滚动位置 / 播放条 / 正在输入的表单）。
// 改名、云端资料回来、跨设备昵称同步后都调它，做到「实时同步」。
function syncNameLabels() {
  const who = displayName()
  const b = $('#sideUserName'); if (b) b.textContent = who
  const h = $('#homeGreet'); if (h) h.textContent = `Hi ${S.session ? who : '朋友'} 今日为你推荐`
  const acc = $('#accountBtn'); if (acc && S.session) acc.textContent = who
  refreshAvatarDom()   // 默认头像按账号生成，改名不影响图案；这里只做头像槽位局部刷新
}
function orangeProfileHtml() {
  const u = S.session?.user || {}
  const acct = (S.core?.auth?.accountView?.() || {})
  const email = acct.email || String(u.email || '').trim()
  const phone = acct.phone || String(u.phone_number || u.phone || '').replace(/^\+?86[\s-]?/, '').replace(/\D/g, '')
  const name = readDisplayName() || (email ? email.split('@')[0] : '') || phone || '我的账号'
  const av = avatarSrc()
  const mine = S.playlists.filter((p) => !p.fav)
  const tab = S.profileTab === 'pl' ? 'pl' : 'like'
  const tracks = S.favorites
  S.batchTracks = tab === 'like' ? tracks : []
  const ava = avatarImgHtml()
  const cam = `<i class="prof-ava-cam"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 8.6h2.9l1.3-1.9h6.4l1.3 1.9h2.9a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H4.6a1.4 1.4 0 0 1-1.4-1.4V10a1.4 1.4 0 0 1 1.4-1.4z"/><circle cx="12" cy="14" r="3.2"/></svg></i>`
  const body = tab === 'pl'
    ? (mine.length
      ? `<div class="prof-pls">${mine.map((p) => `<button class="prof-pl" data-playlist="${esc(p.id)}">
          <span class="prof-pl-cover">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : '<span class="cover-fallback" data-hue="200">♪</span>'}</span>
          <span class="prof-pl-txt"><b>${esc(p.name)}</b><i>${p.tracks?.length || 0} 首</i></span>
        </button>`).join('')}</div>`
      : '<div class="empty">还没有创建歌单</div>')
    : (tracks.length
      ? `<div class="orange-tlist">${tracks.map((t, i) => orangeTrackRow(t, i, { heart: true, tags: false })).join('')}</div>`
      : '<div class="empty">还没有喜欢的歌</div>')
  // ── 账号绑定：邮箱 ↔ 手机号 验证后合并为同一账户 ──
  // 已绑定状态只看落盘档案：SDK 的 session.user 经常只带 email，手机号会「凭空消失」。
  const emailBound = acct.emailBound || !!email
  const phoneBound = acct.phoneBound || !!phone
  const bf = S.bindFlow
  const bindRow = (kind) => {
    const bound = kind === 'email' ? emailBound : phoneBound
    const shown = kind === 'email' ? (acct.maskedEmail || email) : (acct.maskedPhone || phone)
    return `<div class="set-row"><div><b>${kind === 'email' ? '邮箱' : '手机号'}</b><small>${esc(shown || '未绑定')}</small></div>
      ${bound ? '<span class="pill">已绑定</span>' : `<button class="btn small" data-bindstart="${kind}">绑定</button>`}</div>`
  }
  const bindFlowHtml = !bf ? '' : bf.err
    ? `<div class="set-row"><div><b>绑定未完成</b><small>${esc(bf.err)}</small></div><button class="btn small" data-bindcancel>关闭</button></div>`
    : bf.step === 'code'
      ? `<div class="set-row">
          <div><b>输入验证码</b><small>已发送到 ${esc(bf.target)}（以最新一条短信 / 邮件为准）</small></div>
          <div class="field-row"><input class="field" id="bindCode" placeholder="验证码" inputmode="numeric" maxlength="8"><button class="btn small" data-bindconfirm>确认绑定</button><button class="btn small" data-bindcancel>取消</button></div>
          ${bf.tip ? `<small class="hint">${esc(bf.tip)}</small>` : ''}
        </div>`
      : `<div class="set-row">
          <div><b>输入${bf.kind === 'email' ? '邮箱' : '手机号'}</b><small>验证通过后与当前账户合并，之后两种方式登录同一账户</small></div>
          <div class="field-row"><input class="field" id="bindTarget" placeholder="${bf.kind === 'email' ? 'you@example.com' : '11 位手机号'}" inputmode="${bf.kind === 'email' ? 'email' : 'numeric'}" maxlength="${bf.kind === 'email' ? 120 : 11}"><button class="btn small" data-bindsend>发送验证码</button><button class="btn small" data-bindcancel>取消</button></div>
          ${bf.tip ? `<small class="hint">${esc(bf.tip)}</small>` : ''}
        </div>`
  const keepOn = S.core?.auth?.keepLoginEnabled?.() !== false
  const bindHtml = `<div class="set-group prof-bind">
    <h3>账号绑定</h3>
    ${bindRow('email')}
    ${bindRow('phone')}
    ${bindFlowHtml}
    <div class="set-row prof-keep">
      <div><b>登录保持</b><small>开启后 7 天内打开软件都无需重新登录；关闭后下次启动需要重新登录</small></div>
      <button class="switch${keepOn ? ' on' : ''}" id="keepLoginSwitch" role="switch" aria-checked="${keepOn ? 'true' : 'false'}" aria-label="登录保持"><i></i></button>
    </div>
  </div>`
  return `<div class="orange-lib prof-page">
    <div class="prof-hero">
      <button class="prof-ava" data-avatar="1" data-av-slot title="点击更换头像" aria-label="更换头像">${ava}${cam}</button>
      <div class="prof-meta">
        <button class="prof-name" data-open-name="1" title="点击修改用户名" aria-label="修改用户名">${esc(name)}<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.2-10.2a2 2 0 0 0-2.8-2.8L5.2 17.2 4 20z"/><path d="M13.8 7.6l2.6 2.6"/></svg></button>
        <div class="prof-stats"><span><b>${S.favorites.length}</b>喜欢</span><span><b>${mine.length}</b>创建歌单</span></div>
      </div>
    </div>
    ${bindHtml}
    <div class="orange-tabs prof-tabs">
      <button class="orange-tab2${tab === 'like' ? ' on' : ''}" data-proftab="like">我喜欢<i>${S.favorites.length}</i></button>
      <button class="orange-tab2${tab === 'pl' ? ' on' : ''}" data-proftab="pl">创建的歌单<i>${mine.length}</i></button>
    </div>
    ${body}
  </div>`
}

// ── 登录面板：邮箱 / 手机号验证码（首次登录自动注册）─────────────────────
let authMode = 'email'
function openLoginSheet() {
  const sheet = $('#loginSheet')
  if (!sheet) return
  sheet.hidden = false
  const err = $('#loginErr')
  if (err) err.textContent = ''
  const out = $('#logoutBtn')
  if (out) out.hidden = !S.session
  if (!S.cloud) { if (err) err.textContent = '云服务未加载，当前为离线试用'; return }
  setAuthMode(authMode)
}

function setAuthMode(mode) {
  authMode = mode === 'phone' ? 'phone' : 'email'
  document.querySelectorAll('#loginSeg .seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.authmode === authMode))
  const lab = $('#loginTargetLabel'), inp = $('#loginTarget')
  if (lab) lab.textContent = authMode === 'email' ? '邮箱地址' : '手机号'
  if (inp) {
    inp.placeholder = authMode === 'email' ? 'you@example.com' : '11 位手机号'
    inp.inputMode = authMode === 'email' ? 'email' : 'numeric'
    inp.maxLength = authMode === 'email' ? 120 : 11
    inp.value = ''
  }
  if ($('#sendTip')) $('#sendTip').textContent = ''
  if ($('#otp')) $('#otp').value = ''
}

function bindAuthSheet() {
  document.querySelectorAll('#loginSeg .seg-btn').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.authmode) })
  const send = $('#sendCodeBtn')
  if (send) {
    send.onclick = async () => {
      if (!S.core) return
      const err = $('#loginErr')
      if (err) err.textContent = ''
      send.disabled = true
      try {
        const target = String($('#loginTarget').value || '').trim()
        const r = await S.core.auth.sendCode(authMode === 'email' ? { email: target } : { phone: target })
        const tip = $('#sendTip')
        if (tip) tip.textContent = r.isExistingUser ? '验证码已发送，请查收（以最新一条短信 / 邮件为准）' : '验证码已发送（首次登录自动建号）'
        // 重发后旧验证码立即作废：清空输入框，避免用户把旧短信里的码再填一遍（这正是「验证码已失效」的高频根因）
        const otp = $('#otp')
        if (otp) { otp.value = ''; otp.focus() }
        let n = 60
        const tick = () => {
          if (!document.body.contains(send)) return
          if (n <= 0) { send.disabled = false; send.textContent = '重新发送'; return }
          send.textContent = `已发送 ${n}s`
          n -= 1
          setTimeout(tick, 1000)
        }
        send.textContent = '已发送 60s'
        tick()
      } catch (e) {
        if (err) err.textContent = e.message
        send.disabled = false
        send.textContent = '发送验证码'
      }
    }
  }
  const submit = $('#submitCodeBtn')
  if (submit) {
    submit.onclick = async () => {
      if (!S.core) return
      const err = $('#loginErr')
      if (err) err.textContent = ''
      submit.disabled = true
      try {
        const res = await S.core.auth.submitCode($('#otp').value)
        await afterLogin(res)
        submit.disabled = false
      } catch (e) {
        if (err) err.textContent = e.message
        submit.disabled = false
      }
    }
  }
}

// 登录成功：切到云端 → 把本机数据并上云端 → 拉回云端状态。
// 「每个用户自动注册」= 验证码登录即建号；本机已有的歌单不会因为登录而丢掉。
async function afterLogin(res) {
  S.session = await S.core.auth.session()
  S.anonSession = isAnonSession(S.session)
  S.core.cloud.setLocalOnly(!S.session || S.anonSession)
  // 把登录身份直接写进 session.user：账号页的「手机号 / 邮箱」才能立即显示为已绑定，
  // 不会停留在「已登录却显示未绑定」的矛盾状态。
  try {
    const u = (S.session && S.session.user) || {}
    const target = String(res?.target || '')
    // 邮箱的本地部分可能全是数字（如 378542725@qq.com），只能按 kind 判断，
    // 以前用「6 位以上数字」猜手机号，会把纯数字邮箱误写进 phone 字段。
    if (target && res?.kind === 'phone') u.phone = target.replace(/\D/g, '')
    else if (target) u.email = target.trim()
    if (res?.user) Object.assign(u, res.user)
    const me = await S.core.auth.fetchMe()
    if (me) Object.assign(u, me, { phone: me.phone || me.phone_number || u.phone || '' })
    if (S.session) S.session.user = u
    S.identity = S.core.auth.loadIdentity() || S.identity || {}
  } catch { /* 拉不到不影响登录 */ }
  await migrateLocalToCloud()
  await syncUserState()
  $('#loginSheet').hidden = true
  toast(S.session ? '已登录：歌单 / 收藏会同步到腾讯云' : '登录状态未恢复，请重试')
  renderNav()
  render()
}

async function migrateLocalToCloud() {
  if (!S.session || !S.core) return
  const r = S.core.repo
  const prefix = 'orangemusic:v1:state:'
  const localKeys = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (k.startsWith(prefix)) localKeys.push(k.slice(prefix.length))
    }
  } catch { return }
  let uploaded = 0
  for (const key of localKeys) {
    try {
      const cloudVal = await r.getState(key)
      if (cloudVal != null) continue          // 云端已有：以云端为准，不覆盖
      const localVal = JSON.parse(localStorage.getItem(prefix + key) || 'null')
      if (localVal == null) continue
      await r.setState(key, localVal)
      uploaded += 1
    } catch { /* 单条失败跳过，别挡住登录 */ }
  }
  if (uploaded) toast(`已把本机 ${uploaded} 项数据上传到云端`)
}

// ── 头像：本机裁剪成 256×256 后存 user_state.profile（跨端同步，不依赖对象存储）──
let avatarDraft = null
function openAvatarSheet() {
  if (!S.session) { openLoginSheet(); return }
  avatarDraft = null
  if ($('#avatarErr')) $('#avatarErr').textContent = ''
  paintAvatarPreview(avatarSrc())
  const sheet = $('#avatarSheet')
  if (sheet) sheet.hidden = false
}

function paintAvatarPreview(src) {
  const img = $('#avatarPreview'), empty = $('#avatarEmpty')
  if (!img) return
  if (src) { img.src = src; img.hidden = false; if (empty) empty.hidden = true }
  else { img.removeAttribute('src'); img.hidden = true; if (empty) empty.hidden = false }
}

function bindAvatarSheet() {
  const pick = $('#avatarPick'), file = $('#avatarFile')
  if (!pick || !file) return
  const choose = () => file.click()
  pick.onclick = choose
  pick.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose() } }
  const btn = $('#avatarChoose')
  if (btn) btn.onclick = choose
  file.onchange = async () => {
    const f = file.files && file.files[0]
    file.value = ''
    if (!f) return
    try {
      avatarDraft = await imageToAvatar(f)
      paintAvatarPreview(avatarDraft)
      if ($('#avatarErr')) $('#avatarErr').textContent = ''
    } catch (e) { if ($('#avatarErr')) $('#avatarErr').textContent = e.message }
  }
  const reset = $('#avatarReset')
  if (reset) reset.onclick = () => { avatarDraft = ''; paintAvatarPreview(avatarSrc()) }
  const close = $('#closeAvatarBtn')
  if (close) close.onclick = () => { $('#avatarSheet').hidden = true }
  const save = $('#avatarSave')
  if (save) save.onclick = saveAvatar
}

// ── 用户名修改：最多 20 个「字符」（Unicode 码点，emoji 算 1 个），不限符号 ──
// 三处同时落盘：本机 localStorage（离线可用）、身份档案（重启不被 SDK 自动名覆盖）、
// 云端 user_state.profile（跨端同步）。任一失败都不阻塞本机立即生效。
const nameChars = (v) => Array.from(String(v ?? ''))
function syncNameCount() {
  const el = $('#nameCount')
  if (el) el.textContent = String(nameChars($('#nameInput')?.value || '').length)
}
function openNameSheet() {
  if (!S.session) { openLoginSheet(); return }
  const sheet = $('#nameSheet')
  if (!sheet) return
  const input = $('#nameInput')
  if (input) input.value = readDisplayName() || ''
  if ($('#nameErr')) $('#nameErr').textContent = ''
  syncNameCount()
  sheet.hidden = false
  setTimeout(() => { try { input?.focus(); input?.select?.() } catch { /* noop */ } }, 0)
}
async function saveDisplayName() {
  const raw = String($('#nameInput')?.value || '')
  const v = nameChars(raw.trim()).slice(0, 20).join('')
  const err = $('#nameErr')
  if (!v) { if (err) err.textContent = '用户名不能为空'; return }
  if (err) err.textContent = ''
  const now = Date.now()
  try { localStorage.setItem('orangemusic:profile:name', v) } catch { /* 隐私模式忽略 */ }
  try { localStorage.setItem('orangemusic:profile:nameAt', String(now)) } catch { /* 隐私模式忽略 */ }
  try { S.core?.auth?.saveDisplayName?.(v) } catch { /* noop */ }
  if (S.session) S.session.user = { ...(S.session.user || {}), name: v }
  S.profile = { ...(S.profile || {}), name: v, nameUpdatedAt: now }
  // 本机立即生效：先关弹窗、刷新侧栏与页面，不等网络
  const sheet = $('#nameSheet')
  if (sheet) sheet.hidden = true
  renderNav()
  render()
  syncNameLabels()   // 首页问候语 / 账号按钮与侧栏同步，不依赖整页重绘
  // 改名自动同步到云端两处：user_state/profile（跨设备可靠兜底）+ 账户信息 /v1/user/me。
  // 放后台并行执行，失败静默；离线 / 未登录时本机改名照常生效。
  const writes = []
  if (S.session && S.core?.repo) writes.push(S.core.repo.setState(S.core.repo.keys.profile, S.profile))
  if (S.session && S.core?.auth?.updateAccountName) writes.push(S.core.auth.updateAccountName(v))
  if (writes.length) Promise.allSettled(writes).catch(() => {})
}
function bindNameSheet() {
  const sheet = $('#nameSheet')
  if (!sheet) return
  const input = $('#nameInput')
  if (input) {
    input.oninput = () => {
      const cs = nameChars(input.value)
      if (cs.length > 20) input.value = cs.slice(0, 20).join('')
      syncNameCount()
      if ($('#nameErr')) $('#nameErr').textContent = ''
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveDisplayName() }
      if (e.key === 'Escape') { e.preventDefault(); sheet.hidden = true }
    }
  }
  sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) sheet.hidden = true })
  const close = $('#closeNameBtn')
  if (close) close.onclick = () => { sheet.hidden = true }
  const save = $('#saveNameBtn')
  if (save) save.onclick = () => saveDisplayName()
}

// 居中裁成正方形再缩到 256，转 JPEG：40KB 左右，塞进 user_state 完全够用。
function imageToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || '')) return reject(new Error('请选择图片文件'))
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('图片读取失败'))
    fr.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('这张图片解不开，换一张试试'))
      img.onload = () => {
        try {
          const size = 256
          const c = document.createElement('canvas')
          c.width = size
          c.height = size
          const g = c.getContext('2d')
          const k = Math.min(img.width || size, img.height || size)
          const sx = ((img.width || size) - k) / 2
          const sy = ((img.height || size) - k) / 2
          g.drawImage(img, sx, sy, k, k, 0, 0, size, size)
          resolve(c.toDataURL('image/jpeg', 0.86))
        } catch (e) { reject(new Error('图片处理失败：' + e.message)) }
      }
      img.src = String(fr.result)
    }
    fr.readAsDataURL(file)
  })
}

async function saveAvatar() {
  const btn = $('#avatarSave')
  const err = $('#avatarErr')
  if (err) err.textContent = ''
  if (btn) btn.disabled = true
  try {
    const next = avatarDraft === null ? (S.profile?.avatar || '') : avatarDraft
    const now = Date.now()
    S.profile = { ...(S.profile || {}), avatar: next, avatarUpdatedAt: now }
    // 先写本机时间戳，再写云端：断网时本机仍是「最后上传」，下次联网由 syncUserState 自动补推
    writeAvatarLocal(next, now)
    if (S.session) await S.core.repo.setState(S.core.repo.keys.profile, S.profile)
    $('#avatarSheet').hidden = true
    renderNav()
    render()
    toast('头像已更新')
  } catch (e) {
    if (err) err.textContent = e.message
  } finally {
    if (btn) btn.disabled = false
  }
}

// 首页 banner 的问候语按时段变化（原来是写死的「夜深了」）
function greetOf(hour = new Date().getHours()) {
  if (hour < 5) return { title: '夜深了', a: '这个点还醒着', b: '来点音乐 陪你安静一会儿~' }
  if (hour < 9) return { title: '早上好', a: '早起的耳朵有福了', b: '来点轻快的 唤醒今天吧~' }
  if (hour < 12) return { title: '上午好', a: '阳光正好', b: '挑几首顺耳的 边听边忙吧~' }
  if (hour < 14) return { title: '中午好', a: '午后缓一缓', b: '来首舒缓的 歇一会儿吧~' }
  if (hour < 18) return { title: '下午好', a: '状态有点低？', b: '来点节奏 把精神提起来~' }
  if (hour < 22) return { title: '晚上好', a: '一天收尾了', b: '听点喜欢的 把心情放平~' }
  return { title: '夜深了', a: '尝试来点儿音乐', b: '提提神吧~' }
}

// ── 试听列表：记录「听过的专辑 / 歌单」（不是单曲）────────────────────────
// 用户要的形态：听了 乐馆-电台-抖音神曲-樱花草 → 试听列表出现「抖音神曲」歌单；
// 听了 乐馆-深度睡眠-沉寂心灵 → 出现「深度睡眠」歌单。电台按用户习惯也归为「歌单」展示。
// 来源以 S.queueFrom（点歌那一刻的列表）为准：播放成功时用户往往已翻到别的页面，S.page 不可靠。
function trialContainerFromQueue() {
  const q = S.queueFrom || {}
  const id = String(q.id || '')
  const name = String(q.name || '').trim()
  if (!id || !name) return null
  if (id.startsWith('radio:')) return { kind: 'playlist', name, artist: '', cover: q.cover || '', open: { type: 'radio', id: id.slice(6) } }
  if (id.startsWith('rec:')) return { kind: 'playlist', name, artist: '', cover: q.cover || '', open: { type: 'rec', id: id.slice(4) } }
  if (id.startsWith('playlist:')) return { kind: 'playlist', name, artist: '', cover: q.cover || '', open: { type: 'playlist', id: id.slice(9) } }
  if (id.startsWith('album:')) return { kind: 'album', name, artist: String(q.artist || ''), cover: q.cover || '', open: { type: 'album', id: name, artist: q.artist || '' } }
  return null   // 榜单 / 搜索 / 首页推荐 / 相似单曲等不属于「专辑或歌单」，不记录
}

function trialContainerOf(page) {
  const src = page?.source
  const name = String(page?.title || '').trim()
  if (!src || !name) return null
  if (src.type === 'album') {
    const artist = String(src.artist || '')
    return { kind: 'album', name, artist, cover: page.cover || '', open: { type: 'album', id: name, artist } }
  }
  if (src.type === 'playlist' || src.type === 'rec' || src.type === 'radio') {
    return { kind: 'playlist', name, artist: '', cover: page.cover || '', open: { type: src.type, id: src.id } }
  }
  return null
}

function trialListHtml() {
  const items = S.trialList.items || []
  return `<div class="section-head compact"><div><h2>听过的专辑与歌单</h2><p>播放过的整张专辑 / 整个歌单都会收进来，点卡片继续听</p></div></div>
    <div class="grid rec-grid">${items.map((c) => `
      <button class="card" data-trialopen="${esc(c.key)}" title="${esc(c.name)}">
        <div class="cover">${c.cover ? `<img src="${esc(c.cover)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-fallback" data-hue="${hueOf(c.name)}">${c.kind === 'album' ? '▤' : '♫'}</span>`}</div>
        <div class="card-title">${esc(c.name)}</div>
        <div class="card-sub">${c.kind === 'album' ? `专辑${c.artist ? ' · ' + esc(c.artist) : ''}` : '歌单'} · ${new Date(c.at || Date.now()).toLocaleDateString()}</div>
      </button>`).join('')}</div>`
}

function openTrialItem(key) {
  const c = (S.trialList.items || []).find((x) => x.key === key)
  if (!c) return toast('记录已失效')
  const o = c.open || {}
  if (o.type === 'album') return openAlbumPage(o.id, o.artist)
  if (o.type === 'playlist') return openMyPlaylist(o.id)
  if (o.type === 'rec') return openRecommendPlaylist(o.id)
  if (o.type === 'radio') return openRadio(`radio:${o.id}`)
  toast('找不到来源，已无法打开')
}

function clearTrialList() {
  S.trialList.items = []
  try { localStorage.removeItem('orangemusic:trialList') } catch { /* noop */ }
  if (S.cloud) saveTrial().catch(() => {})
  renderNav()
  render()
  toast('已清空试听记录')
}

function orangeLibraryHtml() {
  if (S.libTab === '个人主页' && S.session) return orangeProfileHtml()
  const tab = ORANGE_LIB_TITLE[S.libTab] ? S.libTab : '我喜欢'
  const title = ORANGE_LIB_TITLE[tab]
  let tracks = tab === '我喜欢' ? S.favorites
    : tab === '最近播放' ? S.recent
      : tab === '本地歌曲' ? S.localTracks : []
  // 试听列表改版：展示「听过的专辑 / 歌单」卡片（电台按用户习惯也归为歌单），不再是单曲列表
  const isTrial = tab === '试听列表'
  // 播放历史（最近播放）按时间筛选：今天 / 近 7 天 / 近 30 天
  if (tab === '最近播放' && S.libRange !== 'all') {
    const from = S.libRange === 'today'
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : Date.now() - (S.libRange === '7d' ? 7 : 30) * 86400000
    tracks = tracks.filter((t) => t.playedAt && t.playedAt >= from)
  }
  // 筛选：按喜欢状态
  if (S.libFilter === 'liked') tracks = tracks.filter((t) => S.favorites.some((x) => x.key === t.key))
  if (S.libFilter === 'unliked') tracks = tracks.filter((t) => !S.favorites.some((x) => x.key === t.key))
  // 列表内搜索（标题 / 歌手 / 专辑）
  const lq = S.libQuery.trim().toLowerCase()
  if (lq) tracks = tracks.filter((t) => `${t.title} ${t.artist} ${t.albumName || ''}`.toLowerCase().includes(lq))
  S.batchTracks = tracks
  const sub = S.orangeTab && S.orangeTabOf === tab ? S.orangeTab : ''
  const tabs = tab === '我喜欢'
    ? [{ n: '歌曲', c: tracks.length }, { n: '歌单', c: S.playlists.length }, { n: '专辑', c: new Set(S.favorites.map((t) => t.albumName).filter(Boolean)).size }]
    : tab === '最近播放'
      ? [{ n: '歌曲', c: tracks.length }]
      : tab === '本地歌曲'
        ? [{ n: '本地歌曲', c: tracks.length }]
        : []
  const activeTab = sub || tabs[0]?.n || ''
  const primary = !tabs.length || activeTab === tabs[0].n
  const tabHtml = tabs.length ? `<div class="orange-tabs">${tabs.map((t) => `<button class="orange-tab2${t.n === activeTab ? ' on' : ''}" data-orangetab="${esc(t.n)}">${esc(t.n)}<i>${t.c}</i></button>`).join('')}</div>` : ''
  const toolsHtml = `<div class="orange-lib-tools">
      ${S.libSearchOpen ? `<input class="la-search-input orange-lib-search" id="libSearchInput" placeholder="搜索列表内歌曲" value="${esc(S.libQuery)}">` : ''}
      <button class="orange-lib-searchbtn" data-libtool="search" title="搜索列表"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m19.5 19.5-3.4-3.4"/></svg>搜索</button>
      <button class="orange-lib-ico" data-libtool="history" title="播放历史（按时间筛选）"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/></svg></button>
      <button class="orange-lib-ico" data-libtool="filter" title="筛选（按喜欢状态）"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 5.4h16.8l-6.6 7.6v6.2l-3.6-1.8v-4.4z"/></svg></button>
    </div>`
  const headRight = toolsHtml
  const actionRow = isTrial
      ? `<div class="orange-lib-actions">
          <span class="la-count">共 ${(S.trialList.items || []).length} 个</span>
          <span class="la-flex"></span>
          <button class="orange-pill danger" data-trialclear>清空记录</button>
          ${headRight}
        </div>`
      : S.orangePicking
      ? `<div class="orange-lib-actions batch-bar">
          <button class="orange-pill" data-batch="play">${BATCH_ICO.play}播放</button>
          <button class="orange-pill" data-batch="add">${BATCH_ICO.add}添加</button>
          <button class="orange-pill danger" data-batch="del">${BATCH_ICO.del}删除</button>
          <span class="la-flex"></span>
          <button class="orange-pill" data-batch="toggle">退出批量操作</button>
        </div>`
      : `<div class="orange-lib-actions">
          <button class="orange-pill" data-batch="play"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8.6 5.2v13.6L19.4 12z"/></svg>播放</button>
          <button class="orange-pill" data-batch="toggle"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>批量</button>
          ${headRight}
        </div>`
  const withHeart = tab !== '本地歌曲'
  const listHead = `<div class="orange-thead${S.orangePicking ? ' picking' : ''}">
      ${S.orangePicking
        ? `<span class="orange-th-pick"><input type="checkbox" data-pickall ${S.picked.size >= tracks.length && tracks.length ? 'checked' : ''} aria-label="全选"></span>
           <span class="orange-th-sum">全选<i>|</i>已选中 ${S.picked.size} 首</span><span></span><span class="orange-th">专辑</span><span class="orange-th">时长</span>`
        : `<span></span>
           <span class="orange-th orange-th-song">歌名 / 歌手<i class="orange-sort">⇅</i></span>
           <span></span>
           <span class="orange-th">专辑</span><span class="orange-th">时长</span>`}
    </div>`
  const body = isTrial
    ? ((S.trialList.items || []).length
      ? trialListHtml()
      : orangeEmptyHtml('还没有试听记录', [{ id: 'orangeDemoGo', label: '去音乐馆逛逛' }]))
    : !primary
    ? orangeEmptyHtml('暂无内容')
    : tracks.length
      ? `${listHead}<div class="orange-tlist${S.orangeView === 'compact' ? ' compact' : ''}">${tracks.map((t, i) => orangeTrackRow(t, i, { heart: withHeart, tags: false })).join('')}</div>`
      : tab === '本地歌曲'
        ? orangeEmptyHtml('没有本地歌曲', [{ id: 'orangeLocalAdd', label: '添加', act: '＋ ' }])
        : tab === '最近播放'
          ? orangeEmptyHtml('还没有播放记录')
          : orangeEmptyHtml('还没有收藏歌曲')
  return `<div class="orange-lib">
    <h1 class="orange-lib-title">${esc(title)}</h1>
    ${tabHtml}
    ${actionRow}
    ${body}
  </div>`
}

async function orangeLoadLocal() {
  try {
    const files = await native.pickAudioFiles()
    if (!files?.length) return
    S.localTracks = files.map((f) => ({
      key: normKey(f.title, f.artist), title: f.title, artist: f.artist,
      license: 'user-owned', licenseUrl: 'local://user-owned',
      streams: [{ url: f.path, quality: f.lossless ? 'lossless' : 'hq' }],
    }))
    render(); toast(`已添加 ${S.localTracks.length} 首本地歌曲`)
  } catch (e) { toast(`本地音频：${e.message}`) }
}

async function libraryHtml() {
  if (IS_WIN) return orangeLibraryHtml()
  const bar = `${head('我的音乐', '收藏 · 最近播放 · 自建歌单 · 本地歌曲 · 听歌报告')}${tabsHtml(LIBRARY_TABS, S.libTab, 'library')}`
  if (S.libTab === '总览') return bar + await overviewHtml()

  let tracks = []
  if (S.libTab === '我喜欢') tracks = S.favorites
  if (S.libTab === '最近播放') tracks = S.recent
  if (S.libTab === '本地歌曲') {
    try {
      tracks = (await native.pickAudioFiles()).map((f) => ({
        key: normKey(f.title, f.artist), title: f.title, artist: f.artist,
        license: 'user-owned', licenseUrl: 'local://user-owned',
        streams: [{ url: f.path, quality: f.lossless ? 'lossless' : 'hq' }],
      }))
      S.localTracks = tracks
    } catch (e) { toast(`本地音频：${e.message}`) }
  }
  if (S.libTab === '已购') tracks = []
  S.batchTracks = S.libTab === '已购' ? [] : tracks
  // 自建歌单：卡片式入口，点进去是统一的歌曲列表页；收藏的平台歌单单独一组
  const minePl = S.playlists.filter((p) => !p.fav)
  const favPl = S.playlists.filter((p) => p.fav)
  const playlistCards = S.libTab === '自建歌单'
    ? `${minePl.length
      ? `<div class="grid rec-grid">${minePl.map(myPlaylistHtml).join('')}</div>`
      : '<div class="empty">还没有自建歌单。在歌曲列表里点「＋ 添加到歌单」新建，或用「导入歌单」粘贴分享链接。</div>'}
      ${favPl.length ? `<div class="section-head compact"><div><h2>收藏歌单</h2><p>${favPl.length} 个 · 点星标取消收藏</p></div></div>
        <div class="grid rec-grid">${favPl.map(favPlaylistHtml).join('')}</div>` : ''}`
    : ''
  return `${bar}
    ${S.libTab === '自建歌单' ? playlistCards : `${listActionsHtml(S.batchTracks)}
    ${S.libTab === '已购' ? '<div class="empty">暂无已购内容。本应用不内置任何付费曲库；已购音频请通过「本地歌曲」导入。</div>' : rowsHtml(tracks)}`}`
}

// 通用列表页：榜单曲目 / 自建歌单 / 推荐歌单 / 歌手热歌都用它，带批量操作与勾选。
function listPageHtml() {
  const p = S.page
  const raw = p.tracks || []
  // 歌单内搜索：只过滤当前列表（标题 / 歌手 / 专辑），不影响其他页面
  const q = (S.pageQuery || '').trim().toLowerCase()
  const tracks = q ? raw.filter((t) => `${t.title} ${t.artist} ${t.albumName || t.album || ''}`.toLowerCase().includes(q)) : raw
  S.batchTracks = tracks
  const cover = p.cover || (tracks[0] ? cachedCover(tracks[0]) : '')
  const mine = p.source?.type === 'playlist'
  // 批量「删除」只给自建歌单 / 收藏歌单；乐馆里的推荐歌单、榜单不给（按需求：除下载外只有播放 + 添加）
  const canDel = mine || !!p.source?.fav
  // 异步补齐会改 tracks，副标题里的「N 首」以当前实际行数为准，避免文案和列表对不上。
  const sub = String(p.sub || '').replace(/前 \d+ 首/g, `前 ${raw.length} 首`).replace(/\d+ 首/g, `${raw.length} 首`)
  return `${pageBar(pageCrumb(p.from))}
    <div class="detail-hero">
      <div class="detail-cover">${cover
        ? `<img src="${esc(cover)}" alt="">`
        : `<span class="cover-fallback" data-hue="${hueOf(p.title)}">▤</span>`}</div>
      <div class="detail-meta">
        <h1>${esc(p.title)}</h1>
        <p>${esc(sub)}</p>
        ${listActionsHtml(tracks, { selectable: true, del: canDel, search: true, favpl: p.source?.type === 'rec' ? p.source.id : null })}
      </div>
    </div>
    ${p.loading ? '<div class="loading">正在载入曲目…</div>' : ''}
    ${!p.loading && !tracks.length
      ? (q
        ? `<div class="empty">没有匹配「${esc(S.pageQuery)}」的歌曲<div class="btn-row center mt16"><button class="btn small" data-clearsearch>清除搜索</button></div></div>`
        : `<div class="empty">${mine
          ? '这个歌单还是空的。在任意歌曲列表点「＋」就能加进来。'
          : p.source?.type === 'chart'
            ? '该榜单暂时取不到曲目，可点「重新载入」再试一次'
            : '这个歌单暂时取不到公开曲目（可能已下架或版权受限）'}
          <div class="btn-row center mt16">
            <button class="btn small" data-retry>重新载入</button>
            ${mine ? '' : '<button class="btn small" data-batch="searchchart">按标题检索授权音源</button>'}
          </div></div>`)
      : rowsHtml(tracks, { selectable: true, removable: mine })}`
}

// ---- 导航 ----
// 统一历史栈：goto / 打开榜单、歌单、歌手、专辑、全部榜单 都先压栈；
// 「返回」= 回上一页，「前进」= 退回后可再进（标准浏览器语义）。
const navSnap = () => ({ section: S.section, page: S.page, hallTab: S.hallTab, libTab: S.libTab, searchTab: S.searchTab, category: S.category })
function pushHist() {
  _hist.push(navSnap())
  if (_hist.length > 60) _hist.shift()
  _fwd = []
}
function syncNavBtns() {
  const b = $('#tbBack'), f = $('#tbFwd')
  if (b) { b.disabled = !_hist.length; b.classList.toggle('off', !_hist.length) }
  if (f) { f.disabled = !_fwd.length; f.classList.toggle('off', !_fwd.length) }
}
function goBack() {
  if (!_hist.length) return
  _fwd.push(navSnap())
  Object.assign(S, _hist.pop())
  S.picked.clear()
  S.pickMode = false
  S.orangePicking = false
  render()
  markActive()
}
function goFwd() {
  if (!_fwd.length) return
  _hist.push(navSnap())
  Object.assign(S, _fwd.pop())
  S.picked.clear()
  S.pickMode = false
  S.orangePicking = false
  render()
  markActive()
}

function goto(section, opts = {}) {
  pushHist()
  S.page = null
  S.picked.clear()
  S.pickMode = false
  S.pageQuery = ''
  S.section = section
  Object.assign(S, opts)
  render()
  markActive()
}

function back() {
  // 页面内「‹ 返回」与 Esc 统一走历史栈；没有历史时退回所属大区
  if (_hist.length) return goBack()
  S.picked.clear()
  S.pickMode = false
  const from = ['home', 'hall', 'search'].includes(S.page?.from) ? S.page.from : 'hall'
  S.page = null
  S.section = from
  render()
  markActive()
}

const pageCrumb = (from) => (from === 'home' ? '首页' : from === 'search' ? '搜索' : '乐馆')

// 去重合并：同一首歌（歌名 + 歌手）只留一条，优先保留已有播放候选的那条。
function mergeTracks(...lists) {
  const map = new Map()
  for (const t of lists.flat()) {
    if (!t?.title) continue
    const k = normKey(t.title, t.artist)
    const hit = map.get(k)
    if (!hit || (t.streams?.length || 0) > (hit.streams?.length || 0)) map.set(k, t)
  }
  return [...map.values()]
}

// 歌手 / 专辑聚合：保留 initial 里用户已经看到的曲目，再补足池子命中的，最多 cap 首。
// 关键：initial 永远排在前面且不被 slice 切掉——否则池子返回更多歌时会把用户见过的歌（如
// 聚合前就显示在列表里的那首）挤掉，表现为「聚合后歌曲变少 / 某首歌不见」。
function mergeKeepInitial(initial = [], hits = [], cap = 100) {
  const seen = new Set()
  const out = []
  for (const t of initial) {
    if (!t?.title) continue
    const k = normKey(t.title, t.artist)
    if (seen.has(k)) continue
    seen.add(k); out.push(t)
    if (out.length >= cap) return out
  }
  for (const t of hits) {
    if (!t?.title) continue
    const k = normKey(t.title, t.artist)
    if (seen.has(k)) continue
    seen.add(k); out.push(t)
    if (out.length >= cap) return out
  }
  return out
}

// 歌手 / 专辑的完整曲目清单页：先把手上已有的结果秒上屏，再后台按名称聚合到 100 首。
// ★ 修正「乐馆检索只出 1 首」：旧实现只走 genrePool.poolTracks（网易云 / QQ 通用搜索），
//   这两个接口经常被风控返回空，于是页面只剩 initial 里的 1 首；而搜索页走的是
//   sources.searchAll（波点 / 网易云双通道 / 酷我 / QQ 多源聚合），同关键词能出 34 首。
//   现在两条通道并行、谁先回来谁先上屏：searchAll 为主，曲风池作为补充扩展。
async function openArtistPage(name) {
  if (!S.core || !name) return toast('歌手信息缺失')
  const match = (t) => artistIn(t.artist, name)
  const own = S.searchResults.filter(match)
  const known = allChartTracks().filter(match)
  const initial = sortByNewest(mergeTracks(own, known))
  openListPage({
    title: name,
    sub: `${initial.length} 首 · 正在聚合该歌手全部作品…`,
    cover: artistPhoto(name) || (initial[0] ? cachedCover(initial[0]) : ''),
    tracks: initial, loading: !initial.length,
    from: S.section === 'search' ? 'search' : 'hall',
    source: { type: 'artist', id: name },
  })
  const stillHere = () => S.page?.source?.type === 'artist' && S.page.source.id === name
  let applied = -1
  const apply = (rows, loose = false) => {
    if (!stillHere()) return
    let hits = (rows || []).filter(match)
    // 搜索通道本就是按歌手名召回的：歌手字段写法不同时按标题兜底，最后才整体放宽
    if (!hits.length && loose) {
      const low = String(name).toLowerCase()
      hits = (rows || []).filter((t) => artistIn(t.artist, name) || String(t.title || '').toLowerCase().includes(low))
    }
    if (!hits.length && loose) hits = rows || []
    // 保留 initial 里用户已经看到的曲目，再补足命中的；最多 100 首，initial 永不被切掉。
    const list = mergeKeepInitial(initial, sortByNewest(hits), 100)
    S.page.loading = false
    S.page.sub = `${list.length} 首 · 按发行时间从新到旧`
    if (list.length <= applied) return
    applied = list.length
    S.page.tracks = list
    // 歌手页头部用「歌手照片」而非某首歌的专辑封面（检索结果以歌手照片为封面）
    S.page.cover = artistPhoto(name) || (list[0] ? cachedCover(list[0]) : S.page.cover)
    render()
  }
  const jobs = [
    S.core.sources.searchAll(name).catch(() => []).then((rows) => { if (rows?.length) apply(rows, true) }),
    S.core.genrePool.poolTracks(name, { size: 100, deep: true }).catch(() => []).then((rows) => { if (rows?.length) apply(rows) }),
  ]
  // 6s 预算（略大于 searchAll 的 5.2s 上限）：网络再慢也立刻把「正在聚合…」换成实际数量；
  // 后台结果继续渐进补齐。searchAll 通常在第一批回来后 1~2s 就 resolve，不会真等满 6s。
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 6000))])
  if (stillHere()) {
    S.page.loading = false
    S.page.sub = `${(S.page.tracks || []).length} 首 · 按发行时间从新到旧`
    render()
  }
}

async function openAlbumPage(name, artist) {
  if (!S.core || !name) return toast('专辑信息缺失')
  // 用来源曲目的歌手一起判定，避免同名专辑（很多歌手都有叫「小城」的专辑）混到一起。
  const match = artist
    ? (t) => albumIn(t.album, name) && artistIn(t.artist, artist)
    : (t) => albumIn(t.album, name)
  const own = S.searchResults.filter(match)
  const known = allChartTracks().filter(match)
  const initial = sortByNewest(mergeTracks(own, known))
  openListPage({
    title: name,
    sub: `${initial.length} 首 · 正在聚合整张专辑…`,
    cover: initial[0] ? cachedCover(initial[0]) : '',
    tracks: initial, loading: !initial.length,
    from: S.section === 'search' ? 'search' : 'hall',
    source: { type: 'album', id: name, artist: artist || '' },
  })
  // 与歌手页同策略：4.5s 预算内先出结果，后台补全再渐进上屏，杜绝长时间「正在聚合…」
  const stillHere = () => S.page?.source?.type === 'album' && S.page.source.id === name
  let applied = -1
  const apply = (rows) => {
    if (!stillHere()) return
    let hits = (rows || []).filter(match)
    if (hits.length === 0) hits = (rows || []).filter((t) => albumIn(t.album, name))  // 兜底：仅按专辑名
    const list = mergeKeepInitial(initial, sortByNewest(hits), 100)
    S.page.loading = false
    S.page.sub = `${list.length} 首 · 按发行时间从新到旧`
    if (list.length <= applied) return
    applied = list.length
    S.page.tracks = list
    S.page.cover = list[0] ? cachedCover(list[0]) : S.page.cover
    render()
  }
  // 与歌手页同修正：专辑名也走搜索主通道 + 曲风池补充，避免通用搜索被风控时只剩 1 首
  const q = artist ? `${name} ${artist}` : name
  const jobs = [
    S.core.sources.searchAll(q).catch(() => []).then((rows) => { if (rows?.length) apply(rows) }),
    S.core.genrePool.poolTracks(name, { size: 100, deep: true }).catch(() => []).then((rows) => { if (rows?.length) apply(rows) }),
  ]
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 6000))])
  if (stillHere()) {
    S.page.loading = false
    S.page.sub = `${(S.page.tracks || []).length} 首 · 按发行时间从新到旧`
    render()
  }
}

// 列表页取不到数据时的重试
function retryPage() {
  const p = S.page
  if (!p?.source) return render()
  if (p.source.type === 'chart') return openChartDetail(p.source.id)
  if (p.source.type === 'radio') return openRadio(`radio:${p.source.id}`)
  if (p.source.type === 'rec') return openRecommendPlaylist(p.source.id)
  if (p.source.type === 'playlist') return openMyPlaylist(p.source.id)
  if (p.source.type === 'artist') return openArtistPage(p.source.id)
  if (p.source.type === 'album') return openAlbumPage(p.source.id, p.source.artist)
  render()
}

function openAllCharts() {
  pushHist()
  S.page = { kind: 'allcharts', from: 'home' }
  S.picked.clear()
  S.pickMode = false
  render()
  markActive()
}

// 侧栏「巅峰榜 / 飙升榜」：进入整榜页（section 直接换成 peak / rise，render 里有对应分支）
function openOrangeChart(section) {
  if (!ORANGE_CP_CHARTS[section]) return
  pushHist()
  cpTriedAt.clear()   // 重新进入就立刻重试，不受冷却期限制
  S.page = null
  S.picked.clear()
  S.pickMode = false
  S.section = section
  render()
  markActive()
}

// 打开通用列表页；数据是元数据也行，播放时再按 songmid/hash 取链。
// 从「全部榜单」进来的会记住上一页，返回时回到原榜单页而不是首页。
// 音源预加载：列表上屏后，后台把前 5 首的直链先解析好（并发 2，失败也不打扰用户）。
// 这样点歌基本是「秒开」，而不是每次都等 2~8 秒的取链。
let prefTimer = 0
function schedulePrefetch(tracks, limit = 8) {
  if (!Array.isArray(tracks) || !tracks.length || !S.core?.sources?.prefetchTracks) return
  clearTimeout(prefTimer)
  prefTimer = setTimeout(() => {
    try { S.core.sources.prefetchTracks(tracks, { limit }) } catch { /* 预取失败不影响正常播放 */ }
  }, 180)
}

function openListPage(p) {
  const prev = S.page
  pushHist()
  S.page = { kind: 'list', from: 'hall', back: prev?.kind === 'allcharts' ? prev : null, ...p }
  S.picked.clear()
  S.pickMode = false
  S.pageQuery = ''
  render()
  markActive()
  schedulePrefetch(S.page.tracks)
}

async function openChartDetail(id) {
  if (isRadioId(id)) return openRadio(id)
  const c = S.core?.charts.findChart(id)
  if (!c) return toast('榜单不存在')
  const cached = S.chartTracks.get(id) || []
  const filled = S.core?.chartTracks?.chartKind(id) === 'fill'
  openListPage({
    title: c.name,
    sub: `${c.genre} · ${filled ? '同类型精选 · 按全网热度排序' : '榜单实时同步'}`,
    cover: cached[0] ? cachedCover(cached[0]) : '',
    tracks: cached,
    loading: !cached.length,
    from: S.section === 'home' || S.page?.from === 'home' ? 'home' : 'hall',
    source: { type: 'chart', id, chart: c },
  })
  if (cached.length >= CHART_MAX) return
  // 首页只预热了十几首，这里补齐到整榜（最多 300 首）
  const tracks = await S.core.chartTracks.chartTracks(c, { limit: CHART_MAX }).catch(() => [])
  if (tracks.length > (S.chartTracks.get(id)?.length || 0)) { S.chartTracks.set(id, tracks); S.chartAt.set(id, Date.now()); bumpChartPool() }
  const list = tracks.length ? tracks : cached
  if (S.page?.source?.type === 'chart' && S.page.source.id === id) {
    S.page.tracks = list
    S.page.cover = list[0] ? cachedCover(list[0]) : ''
    S.page.loading = false
    const fill = S.core.chartTracks.chartKind(id) === 'fill'
    if (list.length) S.page.sub = `${c.genre} · ${fill ? '同类型精选' : '实时同步'} · 前 ${list.length} 首`
    render()
  }
}

// 整榜播放（最多前 300 首）
async function playChart(id) {
  if (isRadioId(id)) return playRadio(id)
  const c = S.core?.charts.findChart(id)
  if (!c) return
  let tracks = S.chartTracks.get(id) || []
  if (tracks.length < CHART_MAX) {
    if (!tracks.length) toast(`正在载入「${c.name}」…`)
    const full = await S.core.chartTracks.chartTracks(c, { limit: CHART_MAX }).catch(() => [])
    if (full.length > tracks.length) { S.chartTracks.set(id, full); tracks = full; bumpChartPool() }
  }
  if (!tracks.length) return toast(`「${c.name}」暂无可播放曲目（需网络中转）`)
  playList(tracks, 0, `「${c.name}」`)
}

async function openMyPlaylist(id) {  const pl = S.playlists.find((p) => p.id === id)
  if (!pl) return
  const tracks = (pl.tracks || []).map((t) => (t.matched || t)).filter((t) => t?.title)
  openListPage({
    title: pl.name, sub: `自建歌单 · ${tracks.length} 首 · ${S.session ? '云端同步' : '仅存本机'}`,
    cover: tracks[0] ? cachedCover(tracks[0]) : '', tracks, from: 'hall',
    source: { type: 'playlist', id },
  })
}

// 收藏 / 取消收藏：写入 repo（云端或本机），侧栏「收藏歌单」分组即时更新。
async function toggleFavPlaylist(plId) {
  if (!S.core) return toast('核心未就绪')
  const cur = favRecOf(plId)
  if (cur) {
    try { await S.core.repo.delState(S.core.repo.keys.playlist(cur.id)).catch(() => {}) } catch { /* 云端删不掉也继续 */ }
    try { localStorage.removeItem(`orangemusic:v1:state:playlist:${cur.id}`) } catch { /* 隐私模式 */ }
    S.playlists = S.playlists.filter((p) => p.id !== cur.id)
    renderNav()
    syncFavButtons()
    if (S.section === 'hall' && !S.page) render()
    return toast(`已取消收藏「${cur.name}」`)
  }
  const pl = S.discover?.playlists?.find((p) => p.id === plId)
    || S.plaza.find((p) => p.id === plId)
    || (S.discover?.plaza || []).find((p) => p.id === plId)
  if (!pl) return toast('歌单信息已失效，请在歌单广场重新收藏')
  const rec = {
    id: `fav-${pl.id}`, name: pl.title, fav: true, platform: pl.platform || '平台歌单',
    cover: pl.cover || '', tracks: [], createdAt: Date.now(),
    ref: {
      id: pl.id, pid: pl.pid, source: pl.source, title: pl.title, cover: pl.cover || '',
      platform: pl.platform || '', creator: pl.creator || '', playCount: pl.playCount || 0,
      desc: pl.desc || '', reason: pl.reason || '', tags: pl.tags || [],
    },
  }
  try {
    await S.core.repo.setState(S.core.repo.keys.playlist(rec.id), rec)
    S.playlists.push(rec)
    renderNav()
    syncFavButtons()
    if (S.section === 'hall' && !S.page) render()
    toast(`已收藏「${pl.title}」`)
  } catch (e) { toast(`收藏失败：${e.message}`) }
}

// 只刷新已渲染的星标，不整页重绘（避免收藏后列表滚回顶部）
function syncFavButtons() {
  document.querySelectorAll('[data-favpl]').forEach((b) => {
    const on = !!favRecOf(b.dataset.favpl)
    b.classList.toggle('on', on)
    b.title = on ? '取消收藏' : '收藏歌单'
    b.setAttribute('aria-label', b.title)
    if (b.classList.contains('fav-wide')) b.textContent = on ? '已收藏' : '收藏歌单'
    else b.innerHTML = favStarSvg(on)
  })
}

// 打开收藏的歌单：优先用当前 discover 缓存里的新数据，缓存没有就用收藏时存下的 ref。
function openFavPlaylist(recId) {
  const rec = S.playlists.find((p) => p.id === recId)
  if (!rec) return
  const ref = rec.ref
  if (!ref?.pid) return toast(`「${rec.name}」缺少平台信息，无法载入`)
  const live = S.discover?.playlists?.find((p) => p.id === ref.id)
    || S.plaza.find((p) => p.id === ref.id)
    || (S.discover?.plaza || []).find((p) => p.id === ref.id)
  // fav: true → 这一页来自侧栏「收藏歌单」，批量条里才给「删除」（乐馆里的同名推荐歌单不给）
  openRecommendPlaylist(ref.id, live || ref, { fav: true })
}

async function openRecommendPlaylist(id, plArg = null, opts = {}) {
  // 歌单卡可能来自「首页推荐」或「乐馆歌单广场」（后者在 S.plaza 里），两处都要能查到
  const pl = plArg
    || S.discover.playlists.find((p) => p.id === id)
    || S.plaza.find((p) => p.id === id)
    || (S.discover.plaza || []).find((p) => p.id === id)
  if (!pl || !S.core) return
  openListPage({ title: pl.title, sub: '正在载入曲目…', cover: pl.cover, tracks: [], loading: true, from: 'hall', source: { type: 'rec', id, fav: !!opts.fav } })
  try {
    const rows = await S.core.discover.playlistTracks(pl, 0)
    let tracks = rows.map(rowToTrack)
    if (!S.page?.source || S.page.source.id !== id) return
    // 先把上游曲目上屏：哪怕只有 10 首也立刻可看可播，不等后面的补齐请求。
    S.page.tracks = tracks
    S.page.sub = `${pl.platform || ''} · ${tracks.length} 首`
    S.page.cover = pl.cover || (tracks[0] ? cachedCover(tracks[0]) : '')
    S.page.loading = false
    render()
    // 曲目是异步补进来的（打开时 tracks 为空，openListPage 那次预取扑了个空），
    // 这里必须补一次直链预取：否则点歌要现等 2~4 秒取链，iOS 手势窗口早就过期。
    schedulePrefetch(tracks)
  } catch (e) {
    if (S.page?.source?.id === id) { S.page.loading = false; render() }
    toast(`歌单读取失败：${e.message}`)
  }
}

// 平台元数据行 → 可播放 track（播放时才解析链接）
const rowToTrack = (r) => makeTrack({
  title: r.name || r.title, artist: r.singer || r.artist, album: r.album || '',
  durationMs: r.durationMs || 0, cover: r.cover || '',
  license: 'third-party', licenseUrl: 'auto-discovered',
  tags: r.tags || [],
  pending: {
    source: r.source, id: String(r.songmid || r.id || ''), name: r.name || r.title,
    singer: r.singer || r.artist, albumName: r.album || '', durationMs: r.durationMs || 0,
    picId: r.picId || '',
  },
})

// ---- 设置 ----
const APP_VERSION = '1.0.0'
const fmtBytes = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const lsSize = () => {
  try { return Object.keys(localStorage).reduce((n, k) => n + k.length + (localStorage.getItem(k) || '').length, 0) } catch { return 0 }
}
// 用独立 class：app.css 里有两套全局 .switch（label 式 vs「登录保持」按钮式）互相覆盖，
// 导致这两个开关的轨道/滑块尺寸与颜色一直错乱。ios-toggle 自带完整样式，零冲突。
const switchHtml = (id, on) => `<label class="ios-toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`

// 切换「只听正式发行版」后立刻重算 iOS 各列表，避免必须重启才见效。
function iosApplyOfficialOnly(on) {
  const refilter = (a) => iosNormList(Array.isArray(a) ? a : [])
  for (const k of ['iosRec', 'iosRank', 'iosNew', 'iosHot', 'iosRise']) S[k] = refilter(S[k])
  S.searchResults = refilter(S.searchResults)
  if (!on) { iosCache.clear(); iosLibCatCache.clear(); iosLoadFeed() }
  render()
}

// 更新检查结果卡片（成功 / 失败 / 已是最新）
const updateResultHtml = (u) => {
  if (!u) return ''
  const sz = u.asset?.size && S.core?.updater ? S.core.updater.sizeText(u.asset.size) : ''
  if (!u.ok) {
    return `<div class="set-row"><div><b>检查失败</b><small>${esc(u.error || '未知错误')}</small></div><span class="pill">${esc(u.repo || '')}</span></div>`
  }
  if (!u.hasUpdate) {
    return `<div class="set-row"><div><b>已是最新版本</b><small>${esc(u.repo)} · 最新 ${esc(u.latest || APP_VERSION)}${u.publishedAt ? ` · ${esc(String(u.publishedAt).slice(0, 10))}` : ''}</small></div><span class="pill accent">${esc(u.current)}</span></div>`
  }
  return `<div class="upd-card">
    <div class="upd-head"><b>发现新版本 ${esc(u.latest)}</b><span class="pill accent">当前 ${esc(u.current)}</span></div>
    ${u.name ? `<p class="upd-name">${esc(u.name)}</p>` : ''}
    ${u.notes ? `<pre class="upd-notes">${esc(u.notes)}</pre>` : ''}
    <div class="btn-row">
      ${u.asset ? `<a class="btn small primary" href="${esc(u.asset.url)}" target="_blank" rel="noopener">获取 ${esc(u.asset.name)}${sz ? ` · ${sz}` : ''}</a>` : ''}
      <a class="btn small" href="${esc(u.pageUrl)}" target="_blank" rel="noopener">打开发布页</a>
    </div>
    <p class="upd-hint">获取后退出应用，用新 exe 覆盖原文件即可。收藏 / 歌单 / 播放记录在 %APPDATA%\\橙子音乐，不受影响。</p>
  </div>`
}

function settingsHtml() {
  S.batchTracks = []
  const s = S.settings
  const upCfg = S.core?.updater?.readCfg?.() || { repo: '', auto: true }
  // iOS 端把这一页拆成「设置 / 关于」两个卡片（参照 Music / 乐库 的顶部 tab），
  // 因此把内容分成 settingsBody（播放 / 音源 / 存储）与 aboutBody（版本 / 更新 / 声明）。
  // Windows 端仍把两段拼回同一页，外观完全不变。
  const settingsBody = `
  <div class="set-group">
    <h3>播放</h3>
    <div class="set-row">
      <div><b>音质偏好</b><small>${IS_IOS ? 'iOS 由服务端统一取该曲可用的最高音质（通常 320k MP3，取不到再降档）；这里的档位只影响多源候选的优先顺序，切换后会对当前曲重新取链' : '严格按所选档位取链；该档无可用源时从高到低自动回退。自动＝本曲最高可用音质，切换后当前曲目按新档位重新取链'}</small></div>
      <select class="quality-sel" id="setQuality">
        <option value="auto" ${S.quality === 'auto' ? 'selected' : ''}>自动</option>
        <option value="lossless" ${S.quality === 'lossless' ? 'selected' : ''}>无损</option>
        <option value="hq" ${S.quality === 'hq' ? 'selected' : ''}>高品质</option>
        <option value="sq" ${S.quality === 'sq' ? 'selected' : ''}>标准</option>
        <option value="lq" ${S.quality === 'lq' ? 'selected' : ''}>流畅</option>
      </select>
    </div>
    <div class="set-row">
      <div><b>播放模式</b><small>随机 / 顺序 / 单曲循环 / 列表循环</small></div>
      <select class="quality-sel" id="setMode">
        <option value="shuffle" ${S.mode === 'shuffle' ? 'selected' : ''}>随机播放</option>
        <option value="order" ${S.mode === 'order' ? 'selected' : ''}>顺序播放</option>
        <option value="single" ${S.mode === 'single' ? 'selected' : ''}>单曲循环</option>
        <option value="list" ${S.mode === 'list' ? 'selected' : ''}>列表循环</option>
      </select>
    </div>
    <div class="set-row"><div><b>启动时恢复上次播放</b><small>进入软件自动回到上次那首并续播（iOS 无手势被拒时停在该曲，点播放即可）；关闭后每次启动都是空白播放页</small><em class="set-state${s.resumeLast ? ' on' : ''}" id="setResumeState">${s.resumeLast ? '已开启' : '已关闭'}</em></div>${switchHtml('setResume', s.resumeLast)}</div>
    ${IS_IOS ? `<div class="set-row"><div><b>锁屏显示歌词</b><small>锁屏 / 控制中心卡片第一行显示「歌名 - 歌手」，第二行显示当前歌词并随播放逐句更新；歌词过长由系统截断或滚动</small></div>${switchHtml('setLockLyric', s.lockLyric !== false)}</div>` : ''}
    ${IS_IOS ? '' : `<div class="set-row"><div><b>紧凑列表</b><small>行高更小，一屏能看更多歌</small></div>${switchHtml('setCompact', s.compact)}</div>`}
    <div class="set-row"><div><b>只听正式发行版</b><small>自动排除伴奏、纯音乐、Remix / 电音版、Live、翻唱、试听片段，以及歌名与歌手对不上的曲目；关闭后恢复全部版本与音源</small><em class="set-state${isOfficialOnly() ? ' on' : ''}" id="setOfficialState">${isOfficialOnly() ? '已开启' : '已关闭'}</em></div>${switchHtml('setOfficialOnly', isOfficialOnly())}</div>
  </div>

  ${IS_WIN ? `<div class="set-group">
    <h3>外观与桌面</h3>
    <div class="set-row">
      <div><b>外观模式</b><small>浅色 / 深色 / 跟随系统（随系统切换自动改变皮肤）</small></div>
      <div class="btn-row">
        ${SCHEME_MODES.map((m) => `<button class="btn small${schemeMode === m.id ? ' primary' : ''}" data-scheme-set="${m.id}">${m.label}</button>`).join('')}
      </div>
    </div>
    <div class="set-row"><div><b>开机启动</b><small>登录 Windows 后自动启动橙子音乐</small></div>${switchHtml('setAutoStart', !!S.autoStart)}</div>
    <div class="set-row">
      <div><b>关闭按钮</b><small>点右上角关闭时做什么：每次询问 / 直接最小化到托盘（音乐继续播放）/ 直接退出软件</small></div>
      <select class="quality-sel" id="setCloseAction">
        <option value="ask">每次询问</option>
        <option value="tray">最小化到托盘</option>
        <option value="quit">退出软件</option>
      </select>
    </div>
    <div class="set-row"><div><b>关闭主面板</b><small>收起主界面，只保留精简播放器，音乐继续播放</small></div><button class="btn small" id="setMiniBtn">进入精简模式</button></div>
  </div>` : ''}

  <div class="set-group">
    <h3>音源</h3>
    <div class="set-row">
      <div><b>内置音乐引擎</b><small>${IS_IOS ? 'iOS 版由同源服务端取链：按「歌名+歌手」直接从波点/酷我出完整音频，再以网易云兜底。无需登录、无需会员、无需填地址。' : isWinHost() ? 'Windows 桌面版已内置完整引擎：按「歌名+歌手」直接从波点/酷我取完整音频，另含网易云解灰、酷狗、QQ 多源兜底。无需登录、无需会员、无需填地址或部署；三重校验（歌名/歌手/时长）杜绝错歌与试听片段。' : '网易云 + 酷狗 + QQ 多源直连；iOS 走你填写的边缘函数中转。'}</small></div>
      <span class="pill">${IS_IOS ? '服务端取链' : isWinHost() && getBuiltinApi() ? '运行中' : '已就绪'}</span>
    </div>
    ${IS_WIN && isWinHost() ? `<div class="set-row">
      <div><b>外部音乐 API 地址</b><small>可选进阶：默认用内置引擎即可。想多设备共用一个自部署服务时才填，取不到链会自动回退内置引擎。详见「音源与音质」页。</small></div>
      <div class="field-row"><input class="field" id="setMusicApiUrl" value="${esc(getMusicApiUrl())}" placeholder="http://127.0.0.1:3000" spellcheck="false"><button class="btn small" id="setMusicApiUrlSave">保存</button></div>
    </div>` : ''}
  </div>

  <div class="set-group">
    <h3>存储与数据</h3>
    <div class="set-row"><div><b>本机缓存占用</b><small>封面、榜单曲目、推荐结果都缓存在本机，清理后首次加载会慢一点</small></div><span class="pill">${fmtBytes(lsSize())}</span></div>
    <div class="set-row"><div><b>清理缓存</b><small>只删缓存，不动收藏 / 歌单 / 播放记录</small></div>
      <div class="btn-row">
        <button class="btn small" data-clear="covers">封面</button>
        <button class="btn small" data-clear="charts">榜单曲目</button>
        <button class="btn small" data-clear="rec">推荐结果</button>
      </div>
    </div>
    <div class="set-row"><div><b>清空播放记录</b><small>清空最近播放与听歌报告统计；同账号的其他设备同步后也会一起清空</small></div><button class="btn small" data-clear="history">清空</button></div>
  </div>`

  // 更新说明入口：iOS 端放到「关于」卡片里（Windows 端仍用独立的 aboutPageHtml）。
  const changelogRow = IS_IOS ? `
    <div class="set-row ios-about-changelog"><div><b>更新说明</b><small>查看最近 3 个版本的更新内容</small></div><button class="btn small" id="setChangelog">查看</button></div>` : ''

  const aboutBody = `
  <div class="set-group">
    <h3>关于</h3>
    ${changelogRow}
    <div class="set-row"><div><b>Orange Music · 橙子音乐 v${APP_VERSION}</b><small>iOS 网页 / PWA 版 · 与 Windows 桌面端同一份代码跨平台运行</small></div></div>
    <div class="set-row"><div><b>作者</b><small>12</small></div></div>
    <div class="set-row"><div><b>数据与隐私</b><small>不上报任何行为数据，不接入广告与统计 SDK；收藏、歌单、播放进度只写入你自己的账号或本机。</small></div></div>
    <div class="set-row"><div><b>音源合规</b><small>${IS_IOS ? 'iOS 版由同源服务端取链：按「歌名+歌手」直接从波点/酷我出完整音频，再以网易云兜底，不缓存音频、不转码、不存储任何音频内容。' : isWinHost() ? '桌面版内置完整音乐引擎（波点/酷我取链 + api-enhanced 解灰 + 酷狗/QQ 兜底），全部在本机运行、不依赖第三方托管服务；' : '内置「网易云 + 酷狗 + QQ」多源引擎（纯前端直连）；'}另可选接入公开放权音源（Jamendo / Free Music Archive / Musopen / CC0，需填入你自己的 API Key 后启用）与你自建的合法端点。不缓存音频、不转码、不存储任何音频内容。第三方平台音源责任由使用者自行承担，仅供个人学习测试。</small></div></div>
    <div class="set-row"><div><b>第三方声明</b><small>本项目基于以下开源与第三方组件构建，其版权与许可归各自所有者所有：${IS_IOS ? '运行环境 Safari / WebKit（系统自带）' : '运行框架 Electron、Chromium（BSD 等开源许可）'}；音乐引擎 @neteasecloudmusicapienhanced/api、@unblockneteasemusic/server 及各聚合音源网关（波点 / 酷我 / 酷狗 / QQ 等）；公开放权音源 Jamendo、Free Music Archive、Musopen、CC0 作品；封面与元数据来自各音乐平台公开接口。使用本项目即表示你理解并同意：音频内容版权归原作者与发行方所有，本项目仅提供个人学习用途的技术聚合，不对任何版权争议承担责任。</small></div></div>
    <div class="set-row"><div><b>开源许可</b><small>本项目源代码采用 <b>MIT 许可证</b>开源（见仓库根目录 LICENSE）：可自由使用、修改、二次开发与再发布，只需保留版权与许可声明。第三方组件与音频内容遵循各自许可与版权。</small></div></div>
    <div class="set-row"><div><b>参与改进</b><small>欢迎提交 Issue 或 Pull Request：<a class="repo-link" href="${esc(PROJECT_HOMEPAGE)}/issues" target="_blank" rel="noopener">${esc(PROJECT_HOMEPAGE)}/issues ↗</a></small></div></div>
    <div class="set-row"><div><b>开源组件</b><small>${IS_IOS ? '运行环境为 Safari / WebKit（系统自带），界面与业务代码为 MIT 开源。' : 'Electron / Chromium（BSD 等开源许可），界面与业务代码为 MIT 开源。'}</small></div></div>
    <div class="set-row"><div><b>项目主页</b><small>源码与版本发布托管在 GitHub：<a class="repo-link" href="${esc(PROJECT_HOMEPAGE)}" target="_blank" rel="noopener" title="在浏览器打开项目主页">${esc(PROJECT_HOMEPAGE)} ↗</a></small></div></div>
  </div>`
  // iOS：设置页拆成「设置 / 关于」两个卡片（tab 样式参照 Music / 乐库 页顶部），
  // 外层 .ios-page 控制底部留白，避免最后一行被 dock 压住。
  if (IS_IOS) {
    const at = S.iosSetTab === 'about' ? 'about' : 'settings'
    return `<div class="ios-page ios-setpage">
      <header class="ios-mtabs ios-set-tabs">
        <button class="ios-mback" data-ios-go="player" aria-label="返回播放页">‹</button>
        <button class="ios-mtab${at === 'settings' ? ' on' : ''}" data-ios-settab="settings">设置</button>
        <button class="ios-mtab${at === 'about' ? ' on' : ''}" data-ios-settab="about">关于</button>
        <span class="ios-mtabs-gap"></span>
      </header>
      ${at === 'about' ? aboutBody : settingsBody}
    </div>`
  }
  return `${head('设置', '播放 · 音源 · 存储 · 更新 · 关于')}${settingsBody}${aboutBody}`
}

// 关于：独立页面（不再弹窗）。包含版本 / 检查更新 / 自动检查 / 项目主页（一键打开超链）/ 隐私 / 音源合规 / 第三方声明 / 开源组件。
// 项目主页默认指向官方仓库；用户仍可在下方把「更新源」改成自己的 fork / 私有镜像。
const PROJECT_REPO = 'Huiiiii0118/OrangeMusic'
const PROJECT_HOMEPAGE = `https://github.com/${PROJECT_REPO}`
function aboutPageHtml() {
  const upCfg = (S.core?.updater?.config && S.core.updater.config()) || { repo: '', auto: false }
  const repo = String(upCfg.repo || '').trim()
  return `${head('关于', '版本 · 更新 · 数据与隐私')}
  <div class="set-page about-page">
  <div class="set-group">
    <h3>版本与更新</h3>
    <div class="set-row">
      <div><b>Orange Music · 橙子音乐 v${APP_VERSION}</b><small>Windows 单文件免安装 · iOS 网页 / PWA · 同一份代码</small></div>
      <button class="btn small" id="setUpdateCheck" ${S.updateBusy ? 'disabled' : ''}>${S.updateBusy ? '检查中…' : '检查更新'}</button>
    </div>
    ${updateResultHtml(S.update)}
    <div class="set-row"><div><b>自动检测更新</b><small>启动时自动检查；只在发现新版本时提示一次，接口不通就静默跳过</small></div>${switchHtml('setAutoUpdate', upCfg.auto)}</div>
    <div class="set-row"><div><b>更新内容</b><small>查看最近 3 个版本的更新说明</small></div><button class="btn small" id="setChangelog">查看</button></div>
    <div class="set-row">
      <div><b>项目主页</b><small>源码与版本发布都托管在 GitHub：<a class="repo-link" href="${esc(PROJECT_HOMEPAGE)}" target="_blank" rel="noopener" title="在浏览器打开项目主页">${esc(PROJECT_HOMEPAGE)} ↗</a></small></div>
      <div class="field-row upd-repo"><input class="field" id="setUpdRepo" value="${esc(repo || PROJECT_REPO)}" placeholder="owner/repo" spellcheck="false"><button class="btn small" id="setUpdRepoSave">保存更新源</button></div>
    </div>
  </div>
  <div class="set-group">
    <h3>关于</h3>
    <div class="set-row"><div><b>作者</b><small>12</small></div></div>
    <div class="set-row"><div><b>数据与隐私</b><small>不上报任何行为数据，不接入广告与统计 SDK；收藏、歌单、播放进度只写入你自己的账号或本机。</small></div></div>
    <div class="set-row"><div><b>音源合规</b><small>${isWinHost() ? '桌面版内置完整音乐引擎（波点/酷我取链 + api-enhanced 解灰 + 酷狗/QQ 兜底），全部在本机运行、不依赖第三方托管服务；' : '内置「网易云 + 酷狗 + QQ」多源引擎（纯前端直连）；'}另内置公开授权音源（Jamendo / Free Music Archive / Musopen / CC0）与你自己配置的合法端点。不缓存音频、不转码、不存储任何音频内容。第三方平台音源责任由使用者自行承担，仅供个人学习测试。</small></div></div>
    <div class="set-row"><div><b>第三方声明</b><small>本项目基于以下开源与第三方组件构建，其版权与许可归各自所有者所有：<br>· 运行框架：Electron、Chromium（BSD 等开源许可）；<br>· 音乐引擎：@neteasecloudmusicapienhanced/api、@unblockneteasemusic/server 及各聚合音源网关（波点 / 酷我 / 酷狗 / QQ 等），服务条款与内容版权归对应平台所有；<br>· 公开放权音源：Jamendo、Free Music Archive、Musopen、CC0 作品；<br>· 封面与元数据来自各音乐平台公开接口。<br>使用本项目即表示你理解并同意：音频内容版权归原作者与发行方所有，本项目仅提供个人学习用途的技术聚合，不对任何版权争议承担责任。</small></div></div>
    <div class="set-row"><div><b>开源许可</b><small>本项目源代码采用 <b>MIT 许可证</b>开源（见仓库根目录 LICENSE）：可自由使用、修改、二次开发与再发布，只需保留版权与许可声明。第三方组件与音频内容遵循各自许可与版权。</small></div></div>
    <div class="set-row"><div><b>参与改进</b><small>欢迎提交 Issue 或 Pull Request：<a class="repo-link" href="${esc(PROJECT_HOMEPAGE)}/issues" target="_blank" rel="noopener">${esc(PROJECT_HOMEPAGE)}/issues ↗</a></small></div></div>
    <div class="set-row"><div><b>开源组件</b><small>Electron / Chromium（BSD 等开源许可），界面与业务代码为 MIT 开源。</small></div></div>
  </div>
  </div>`
}

// 更新内容数据源：iOS 端的更新说明随站点一起发布（ios/RELEASE_NOTES/*.md → release-notes.json），
// 不再从 GitHub Releases 读取 —— GitHub 的 Release Notes 现在只描述 Windows 桌面端。
// 带时间戳查询参数跳过 SW / HTTP 缓存，保证每次打开都是最新的说明。
let _releaseNotesCache = null
let _releaseNotesCacheAt = 0
async function loadReleaseNotes() {
  const now = Date.now()
  if (_releaseNotesCache && now - _releaseNotesCacheAt < 60000) return _releaseNotesCache
  const res = await fetch(`./release-notes.json?t=${now}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const releases = Array.isArray(data?.releases) ? data.releases : []
  _releaseNotesCache = releases
  _releaseNotesCacheAt = now
  return releases
}

// 更新内容查看：同页面浮层，展示最近版本的更新说明（取自本地 release-notes.json）。
// opts.whatsNew=true 时只显示最新一版、标题改为「本次更新内容」，用于更新完成后弹出。
async function openChangelog(opts = {}) {
  const limit = opts.whatsNew ? 1 : (opts.limit || 3)
  const title = opts.title || (opts.whatsNew ? '本次更新内容' : '更新内容')
  let box = document.getElementById('omChangelog')
  if (!box) {
    box = document.createElement('div')
    box.id = 'omChangelog'
    box.className = 'om-changelog hidden'
    document.body.appendChild(box)
  }
  box.classList.remove('hidden')
  box.innerHTML = `<div class="om-cl-backdrop" data-close="1"></div>
    <div class="om-cl-card">
      <header class="om-cl-head"><b>${esc(title)}</b><button class="om-cl-close" data-close="1" aria-label="关闭">✕</button></header>
      <div class="om-cl-body"><div class="om-cl-loading">正在加载更新记录…</div></div>
    </div>`
  box.querySelectorAll('[data-close]').forEach((el) => { el.onclick = () => box.classList.add('hidden') })
  const body = box.querySelector('.om-cl-body')
  try {
    const releases = await loadReleaseNotes()
    if (!releases.length) { body.innerHTML = `<div class="om-cl-empty">暂无更新说明</div>`; return }
    body.innerHTML = releases.slice(0, limit).map((rel) => `
      <div class="om-cl-item">
        <div class="om-cl-meta"><span class="om-cl-ver">v${esc(String(rel.version || ''))}</span>${rel.date ? `<span class="om-cl-date">${esc(String(rel.date))}</span>` : ''}</div>
        <div class="om-cl-notes">${rel.notes ? esc(String(rel.notes)).replace(/\n/g, '<br>') : '（无说明）'}</div>
      </div>`).join('')
  } catch (e) {
    body.innerHTML = `<div class="om-cl-empty">获取更新记录失败：${esc(String(e?.message || e))}</div>`
  }
}
// 这样表单 id / 事件绑定跟弹窗时代完全一致，不用复制一份标记。
function sourcePageHtml() {
  const tpl = document.getElementById('sourceTpl')
  return `${head('音源与音质', '授权音源 · 聚合音源组 · 中转与榜单端点')}
  <div class="src-page">${tpl ? tpl.innerHTML : '<div class="empty">音源面板模板缺失</div>'}</div>`
}

// ---- 播放模式：顺序 / 单曲循环 / 随机（三种，带各自图标；点击自动切换）----
const MODE_META = {
  shuffle: { label: '随机播放', tip: '随机播放' },
  order: { label: '顺序播放', tip: '顺序播放' },
  single: { label: '单曲循环', tip: '单曲循环' },
  list: { label: '列表循环', tip: '列表循环' },   // 旧数据兼容：读出来归一化为顺序播放
}
const MODE_ORDER = ['shuffle', 'order', 'single', 'list']
// 用户指定的三种模式与切换顺序；图标与托盘「播放模式选择」展开项一致
const MODE_CYCLE = ['order', 'single', 'shuffle']
const MODE_ICON = {
  order: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h9"/><path d="m16.4 15.4 2.4 1.6-2.4 1.6"/></svg>',
  single: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-2.4-2.4"/><path d="M20 8v3.2"/><path d="M20 16H7l2.4 2.4"/><path d="M4 16v-3.2"/><text x="12" y="15" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>',
  shuffle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h3.4l9.2 11H20"/><path d="M4 17.5h3.4l2.6-3.1"/><path d="M17.4 3.9 20 6.5l-2.6 2.6"/><path d="M17.4 14.9 20 17.5l-2.6 2.6"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
}
function cyclePlayMode() {
  const i = MODE_CYCLE.indexOf(S.mode)
  setPlayMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] || 'order')
}

function syncModeUI() {
  if (!MODE_META[S.mode] || S.mode === 'list') S.mode = 'order'   // 旧「列表循环」归一化为顺序播放
  // 主界面两处「播放模式选择」按钮：图标 + 文字，点击自动切换（顺序 → 单曲 → 随机）
  for (const id of ['#modeBtn', '#npModeBtn']) {
    const b = $(id)
    if (!b) continue
    const m = MODE_META[S.mode]
    const ico = MODE_ICON[S.mode] || MODE_ICON.order
    const tgt = b.querySelector('.mico')
    const txt = b.querySelector('.mtxt')
    if (tgt) tgt.innerHTML = ico
    if (txt) txt.textContent = m.label
    b.title = `播放模式：${m.label}（点击切换）`
    b.dataset.tip = m.label
  }
  $('#modeMenu')?.querySelectorAll('.mm-item').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode))
  const a = $('#previewAudio')
  if (a) a.loop = S.mode === 'single'
}

function setPlayMode(m) {
  if (!MODE_META[m]) return
  S.mode = m
  saveSetting('mode', m)
  syncModeUI()
  toast(`播放模式：${MODE_META[m].label}`)
  // 托盘菜单里的播放模式图标跟着变
  try { pushTrayState() } catch { /* 无宿主 */ }
}

function openModeMenu(anchor) {
  const m = $('#modeMenu')
  if (!m || !anchor) return
  closeQualityMenu()
  syncModeUI()
  m.hidden = false
  const r = anchor.getBoundingClientRect()
  const w = m.offsetWidth || 128
  const h = m.offsetHeight || 180
  const cx = r.left + r.width / 2
  const left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8)
  m.style.setProperty('left', `${Math.round(left)}px`)
  m.style.setProperty('top', `${Math.round(Math.max(8, r.top - h - 10))}px`)
  m.style.setProperty('--mmx', `${Math.round(Math.min(Math.max(12, cx - left), w - 12))}px`)
}

const closeModeMenu = () => { const m = $('#modeMenu'); if (m) m.hidden = true }

function bindModeMenu() {
  const m = $('#modeMenu')
  if (!m || m.dataset.bound) return
  m.dataset.bound = '1'
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]')
    if (!b) return
    closeModeMenu()
    setPlayMode(b.dataset.mode)
  })
  document.addEventListener('click', (e) => {
    if (m.hidden) return
    if (e.target.closest('#modeMenu, #npModeBtn, #modeBtn')) return
    closeModeMenu()
  })
}

// 检查更新：手动点会绕过 10 分钟缓存并把结果留在设置页
async function runUpdateCheck(manual = false) {
  if (!S.core?.updater) return toast('核心未就绪，稍后再试')
  if (S.updateBusy) return
  S.updateBusy = true
  if (manual) render()
  try {
    const r = await S.core.updater.checkForUpdate({ force: manual })
    S.update = r
    if (manual) {
      if (!r.ok) toast(`检查失败：${r.error}`)
      else if (r.hasUpdate) toast(`发现新版本 ${r.latest}`)
      else toast('已是最新版本')
    }
  } catch (e) {
    S.update = { ok: false, error: e.message, current: APP_VERSION }
    if (manual) toast(`检查失败：${e.message}`)
  } finally {
    S.updateBusy = false
    if (S.section === 'settings' && !S.page) render()
  }
}

async function clearData(kind) {
  try {
    if (kind === 'covers') localStorage.removeItem('orangemusic:covers:v1')
    if (kind === 'charts') { localStorage.removeItem('orangemusic:charttracks:v1'); S.chartTracks.clear(); bumpChartPool() }
    if (kind === 'rec') { localStorage.removeItem('orangemusic:discover:v1'); S.discover = { playlists: [], artists: [] } }
    if (kind === 'history') {
      localStorage.removeItem('orangemusic:v1:events')
      S.recent = []
      S.events = []
      eventsAt = 0
      if (S.cloud) await saveRecent().catch(() => {})
    }
    toast(kind === 'history' ? '播放记录已清空' : '缓存已清理')
    render()
  } catch (e) { toast(`清理失败：${e.message}`) }
}


// 自动检测填的地址是否有效，并更新「运行中 / 不可用 / 未配置」徽标。
// Windows 桌面版默认由内置引擎接管（含解灰），音乐 API 地址是可选进阶项。
function refreshSourceBadges() {
  const apiBadge = $('#srcApiBadge')
  const relayBadge = $('#srcRelayBadge')
  const builtinBadge = $('#builtinBadge')
  const win = isWinHost()
  const builtinOn = getBuiltinApi()
  const set = (el, r) => {
    if (!el) return
    if (r.ok) { el.className = 'badge on'; el.textContent = '运行中'; el.title = '检测通过' }
    else if (r.why === '未填写') { el.className = 'badge muted'; el.textContent = '未配置'; el.title = '' }
    else { el.className = 'badge off'; el.textContent = '不可用'; el.title = r.why || '连接失败' }
  }
  // 内置引擎徽标：仅桌面版显示，开关决定运行/已关闭
  if (builtinBadge) {
    if (builtinOn) { builtinBadge.className = 'badge on'; builtinBadge.textContent = '运行中'; builtinBadge.title = '内置引擎已接管搜索/取链/解灰' }
    else { builtinBadge.className = 'badge muted'; builtinBadge.textContent = '已关闭'; builtinBadge.title = '当前走内置直连引擎' }
  }
  const group = $('#builtinEngineGroup')
  if (group && !win) group.hidden = true   // iOS/浏览器不显示桌面内置引擎
  const optTag = $('#apiOptionalTag')
  if (optTag) optTag.hidden = !win
  const apiHint = $('#apiHint')
  if (apiHint && win) apiHint.innerHTML = '进阶可选项：默认用内置引擎即可。<b>只有当你想在多台设备共用同一个自部署服务</b>，或关闭了内置引擎时，才需要填这里。支持 NeteaseCloudMusicApi / api-enhanced / UNM / Meting 等服务地址；填了会优先用它，取不到链时自动回退。'

  const apiVal = ($('#srcMusicApiUrl')?.value || '').trim()
  const relayVal = ($('#srcMusicApiBase')?.value || '').trim()
  if (apiBadge) { apiBadge.className = 'badge muted'; apiBadge.textContent = '检测中…' }
  if (relayBadge) { relayBadge.className = 'badge muted'; relayBadge.textContent = '检测中…' }
  if (apiVal) checkMusicApi(apiVal).then((r) => set(apiBadge, r)).catch(() => set(apiBadge, { ok: false, why: '检测失败' }))
  else if (win && builtinOn) set(apiBadge, { ok: true })   // 内置引擎接管时，API 未配置也显示运行中，避免误导
  else set(apiBadge, { ok: false, why: '未填写' })
  if (relayVal) checkRelay(relayVal).then((r) => set(relayBadge, r)).catch(() => set(relayBadge, { ok: false, why: '检测失败' }))
  else set(relayBadge, { ok: false, why: '未填写' })
}

// 音源与音质页（内嵌页面）的控件绑定。页面每次渲染都会重建 DOM，所以放在 bindView 里跑。
function bindSourcePage() {
  if (!$('#sourceList')) return
  $('#closeSourceBtn') && ($('#closeSourceBtn').onclick = () => back())
  $('#saveSourceBtn') && ($('#saveSourceButton').onclick = saveSourceCfg)
  // Windows 内置引擎开关：关掉后回退纯直连引擎（一般无需操作）
  const toggleBtn = $('#builtinToggleBtn')
  if (toggleBtn && isWinHost()) {
    const paint = () => { toggleBtn.textContent = getBuiltinApi() ? '关闭内置引擎' : '开启内置引擎' }
    paint()
    toggleBtn.onclick = () => {
      const next = !getBuiltinApi()
      setBuiltinApi(next)
      paint()
      toast(next ? '内置音乐引擎已开启（含解灰）' : '已关闭内置引擎，改用内置直连')
      refreshSourceBadges()
    }
  } else if (toggleBtn) toggleBtn.hidden = true
  // iOS 音源中转地址（边缘函数）：与设置页共享同一个存储
  const baseInput = $('#srcMusicApiBase')
  if (baseInput) baseInput.value = getMusicApiBase()
  $('#srcMusicApiBaseSave') && ($('#srcMusicApiBaseSave').onclick = () => {
    const v = (baseInput?.value || '').trim()
    setMusicApiBase(v)
    toast(v ? '已保存 iOS 音源中转地址' : '已清空：iOS 将走公共代理降级')
    refreshSourceBadges()
  })
  // 音乐 API 地址（UnblockNeteaseMusic / Meting）：更稳的取链后端
  const apiInput = $('#srcMusicApiUrl')
  if (apiInput) apiInput.value = getMusicApiUrl()
  $('#srcMusicApiUrlSave') && ($('#srcMusicApiUrlSave').onclick = () => {
    const v = (apiInput?.value || '').trim()
    setMusicApiUrl(v)
    toast(v ? '已启用外部音乐 API（取不到链时自动回退内置引擎）' : (isWinHost() && getBuiltinApi() ? '已清空：继续用内置音乐引擎（含解灰）' : '已清空：改回内置直连引擎'))
    refreshSourceBadges()
  })
  refreshSourceBadges()   // 进入页面即自动检测两个地址
}

function bindView() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    const g = b.dataset.group
    if (g === 'hall') S.hallTab = b.dataset.tab
    else if (g === 'library') S.libTab = b.dataset.tab
    else if (g === 'search') S.searchTab = b.dataset.tab
    if (g === 'hall' && b.dataset.tab !== '歌单广场') S.category = null
    S.picked.clear()
    S.pickMode = false
    S.pageQuery = ''   // 切 tab 清掉「列表内搜索」，避免上次的关键词把新列表过滤空
    render()
  })
  document.querySelectorAll('[data-play]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation()
    const k = b.dataset.play
    // 播放队列面板里的行：队列本身就是当前列表，点它只切歌，不能重建队列
    if (b.closest('.npq-row, #npqList')) {
      const t = (S.queue || []).find((x) => x.key === k)
      if (t) playTrack(t)
      return
    }
    playRowByKey(k)
  })
  // 整行点击 = 播放这一行（和主流客户端一致）。批量模式下点行仍然是勾选，不抢。
  document.querySelectorAll('.row[data-key], .orange-tr[data-key]').forEach((row) => {
    if (row._playBound) return
    row._playBound = true
    row.addEventListener('click', (e) => {
      if (S.pickMode || S.orangePicking) return
      if (e.target.closest('button, input, a, [data-artist], [data-album], [data-rowmore], [data-rowadd], [data-rowheart]')) return
      playRowByKey(row.dataset.key)
    })
  })
  document.querySelectorAll('[data-quick]').forEach((b) => b.onclick = () => quickAction(b.dataset.quick))
  document.querySelectorAll('[data-chartopen]').forEach((b) => b.onclick = () => openChartDetail(b.dataset.chartopen))
  document.querySelectorAll('[data-playchart]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation()
    playChart(b.dataset.playchart)
  })
  // 用卡片自身注册的确切对象打开歌单，避免按 id 在聚合数组里 find 到另一张卡
  document.querySelectorAll('[data-pl]').forEach((b) => b.onclick = () => {
    const p = plCardMap.get(b.dataset.pl)
    openRecommendPlaylist(p?.id || b.dataset.pl, p || null)
  })
  // 歌单卡右上角的星标：收藏 / 取消收藏（必须拦在冒泡前，否则会同时打开歌单）
  document.querySelectorAll('[data-favpl]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleFavPlaylist(b.dataset.favpl) }
    b.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault(); e.stopPropagation(); toggleFavPlaylist(b.dataset.favpl)
    }
  })
  document.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => homeAction(b.dataset.action, b))
  document.querySelectorAll('[data-mypl]').forEach((b) => b.onclick = () => openMyPlaylist(b.dataset.mypl))
  document.querySelectorAll('[data-favopen]').forEach((b) => b.onclick = () => openFavPlaylist(b.dataset.favopen))
  // 自建歌单的删除入口：卡片右上角 ✕、列表页「删除歌单 / 清空歌单」、单曲行「✕ 移除」
  document.querySelectorAll('[data-delpl]').forEach((b) => b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation()
    deletePlaylist(b.dataset.delpl)
  })
  document.querySelectorAll('[data-pldel], [data-delpl]').forEach((b) => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); deletePlaylist(b.dataset.pldel || b.dataset.delpl) })
  document.querySelectorAll('[data-plclear]').forEach((b) => b.onclick = () => clearPlaylist(b.dataset.plclear))
  document.querySelectorAll('[data-rmkey]').forEach((b) => b.onclick = () => {
    const id = S.page?.source?.type === 'playlist' ? S.page.source.id : ''
    if (id) removeFromPlaylist(id, b.dataset.rmkey)
  })
  document.querySelectorAll('[data-back]').forEach((b) => b.onclick = back)
  document.querySelectorAll('[data-retry]').forEach((b) => b.onclick = retryPage)
  document.querySelectorAll('[data-batch]').forEach((b) => b.onclick = () => batchAction(b.dataset.batch))
  document.querySelectorAll('[data-addpl]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openPickSheet([b.dataset.addpl]) })
  document.querySelectorAll('[data-pick]').forEach((cb) => cb.onchange = () => {
    if (cb.checked) S.picked.add(cb.dataset.pick)
    else S.picked.delete(cb.dataset.pick)
    // 表头「全选 | 已选中 N 首」实时跟着变
    const hsum = document.querySelector('.list-head.picking .lh-sum')
    if (hsum) hsum.innerHTML = `全选<i>|</i>已选中 ${S.picked.size} 首`
    const bar = document.querySelector('.list-actions .la-count')
    if (bar) {
      bar.innerHTML = pickCountHtml(S.batchTracks.length)
      bar.querySelectorAll('[data-batch]').forEach((b) => b.onclick = () => batchAction(b.dataset.batch))
    }
    const wbar = document.querySelector('.orange-pick-count')
    if (wbar) wbar.textContent = `已选 ${S.picked.size} 首`
    syncPickBadges()
  })
  const pickAll = document.querySelector('[data-pickall]')
  if (pickAll) pickAll.onchange = () => batchAction('pickall')
  document.querySelectorAll('[data-artist]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openArtistPage(b.dataset.artist) })
  document.querySelectorAll('[data-album]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openAlbumPage(b.dataset.album, b.dataset.albumartist) })
  // 行内工具按钮（红心 / 添加到 / 更多）：直接绑定，确保「非当前播放」的曲目也能响应。
  // 之前只靠 document 委托，部分列表里的非队列曲目拿不到 track；这里直接绑在按钮上并阻止冒泡，
  // 既保证一定触发，又避免与 document 委托重复处理。
  document.querySelectorAll('[data-rowheart], [data-rowadd], [data-rowmore]').forEach((b) => {
    if (b._rb) return
    b._rb = true
    b.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault()
      if (b.dataset.rowheart) toggleLikeKey(b.dataset.rowheart)
      else if (b.dataset.rowadd) openPickSheet([b.dataset.rowadd], b)
      else if (b.dataset.rowmore) openRowMoreMenu(b, b.dataset.rowmore)
    })
  })
  document.querySelectorAll('[data-trialopen]').forEach((b) => b.onclick = () => openTrialItem(b.dataset.trialopen))
  const trialClearBtn = document.querySelector('[data-trialclear]')
  if (trialClearBtn) trialClearBtn.onclick = clearTrialList
  // ── 账号绑定（个人主页）：发码 → 验码 → 合并同一账户 ──
  document.querySelectorAll('[data-bindstart]').forEach((b) => b.onclick = () => {
    S.bindFlow = { kind: b.dataset.bindstart === 'phone' ? 'phone' : 'email', step: 'input', tip: '', err: '' }
    render()
  })
  const bindSendBtn = document.querySelector('[data-bindsend]')
  if (bindSendBtn) bindSendBtn.onclick = async () => {
    const bf = S.bindFlow
    if (!bf) return
    const v = String($('#bindTarget')?.value || '').trim()
    if (bf.kind === 'email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) : !/^1\d{10}$/.test(v.replace(/\D/g, ''))) {
      S.bindFlow = { ...bf, tip: bf.kind === 'email' ? '请输入正确的邮箱地址' : '请输入正确的 11 位手机号' }
      return render()
    }
    S.bindFlow = { ...bf, tip: '发送中…' }
    render()
    try {
      if (!S.core) throw new Error('核心未就绪，请稍候再试')
      const r = await S.core.auth.bindSend(bf.kind === 'email' ? { email: v } : { phone: v }, S.session?.access_token)
      S.bindFlow = { kind: bf.kind, step: 'code', target: r.target, tip: '验证码已发送，请查收（以最新一条为准）', err: '' }
      toast('验证码已发送至 ' + (r.target || v))
    } catch (e) {
      S.bindFlow = { kind: bf.kind, err: e.message }
      toast(e.message || '发送失败，请重试')
    }
    render()
  }
  const bindOkBtn = document.querySelector('[data-bindconfirm]')
  if (bindOkBtn) bindOkBtn.onclick = async () => {
    S.bindFlow = { ...S.bindFlow, tip: '合并中…' }
    render()
    try {
      const r = await S.core.auth.bindConfirm(String($('#bindCode')?.value || '').trim(), S.session?.access_token)
      if (r?.identity) S.identity = r.identity
      else if (S.core?.auth?.loadIdentity) S.identity = S.core.auth.loadIdentity()
      if (r?.me && S.session) S.session.user = { ...(S.session.user || {}), ...r.me,
        phone: r.me.phone || r.me.phone_number || S.session.user?.phone || '' }
      S.bindFlow = null
      toast('绑定成功：两种登录方式指向同一账户')
    } catch (e) {
      S.bindFlow = { ...(S.bindFlow || {}), err: e.message }
    }
    renderNav()
    render()
  }
  const bindCancelBtn = document.querySelector('[data-bindcancel]')
  if (bindCancelBtn) bindCancelBtn.onclick = () => { S.bindFlow = null; render() }
  document.querySelectorAll('[data-category]').forEach((b) => b.onclick = () => {
    S.page = null
    S.category = b.dataset.category
    S.section = 'hall'
    S.hallTab = '歌单广场'
    S.plazaCat = b.dataset.category || '全部'
    S.plazaSource = 'all'
    render()
    markActive()
  })
  // 歌单广场：平台来源 / 分类筛选（只过滤已聚合的结果，不再请求网络）
  document.querySelectorAll('[data-plsrc]').forEach((b) => b.onclick = () => {
    const v = b.dataset.plsrc || 'all'
    if (S.plazaSource === v) return
    S.plazaSource = v
    render()
  })
  document.querySelectorAll('[data-plcat]').forEach((b) => b.onclick = () => {
    const v = b.dataset.plcat || '全部'
    if (S.plazaCat === v) return
    S.plazaCat = v
    render()
  })
  // 歌手页：性别 / 首字母筛选（没有「全部」按钮：再点一次已选中的分类即取消筛选）
  // 名录是全量拉好后本地筛选：切分类 / 字母只重绘，不清空、不重新联网（不再闪烁、不再串性别）
  document.querySelectorAll('[data-artsex]').forEach((b) => b.onclick = () => {
    const v = b.dataset.artsex || 'all'
    S.artistSex = (S.artistSex === v && v !== 'all') ? 'all' : v
    render()
  })
  const reloadArtists = () => { S.artistDir = []; S.artistDirKey = ''; S.artistFailAt = 0; render(); loadArtistDir(true) }
  $('#refreshArtistsBtn') && ($('#refreshArtistsBtn').onclick = reloadArtists)
  $('#retryArtistsBtn') && ($('#retryArtistsBtn').onclick = reloadArtists)
  document.querySelectorAll('[data-artletter]').forEach((b) => b.onclick = () => {
    const v = b.dataset.artletter || ''
    S.artistLetter = S.artistLetter === v ? '' : v   // 再点一次已选字母即取消
    render()
  })
  document.querySelectorAll('[data-hot]').forEach((b) => b.onclick = () => { S.page = null; S.query = b.dataset.hot; runSearch(b.dataset.hot) })
  document.querySelectorAll('[data-demo]').forEach((b) => b.onclick = () => playDemo())
  document.querySelectorAll('[data-orangetab]').forEach((b) => b.onclick = () => {
    S.orangeTab = b.dataset.qqtab
    S.orangeTabOf = S.libTab
    S.picked.clear()
    S.pickMode = false
    render()
  })
  document.querySelectorAll('[data-heart]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation()
    const key = b.dataset.heart
    const t = S.recent.find((x) => x.key === key) || S.favorites.find((x) => x.key === key)
    if (!t) return
    const exists = S.favorites.some((x) => x.key === key)
    S.favorites = exists ? S.favorites.filter((x) => x.key !== key) : [{ ...t, addedAt: Date.now() }, ...S.favorites]
    if (S.cloud) await saveFavorites().catch(() => {})
    render()
    updatePlayerBar()
  })
  document.querySelectorAll('[data-qqdownload]').forEach((b) => b.remove())
  // 巅峰榜 / 飙升榜：按整榜队列播放，点行内歌名从该首开始
  const cp = cpConf()
  if (cp) {
    const title = `「${cp.title}」`
    document.querySelectorAll('[data-cpplay]').forEach((b) => b.onclick = () => {
      const list = cpTracks()
      if (!list.length) return toast('榜单还在载入，请稍候')
      // 按 key 定位起点：开了「只听正式发行版」时下标会错位
      const at = list.findIndex((x) => x.key === b.dataset.cpplay)
      playList(list, Math.max(0, at), title, { id: `chart:${cpKey()}`, name: cp?.title || '' })
    })
    document.querySelectorAll('[data-cpheart]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation()
      const key = b.dataset.cpheart
      const t = cpTracks().find((x) => x.key === key)
      if (!t) return
      const exists = S.favorites.some((x) => x.key === key)
      S.favorites = exists ? S.favorites.filter((x) => x.key !== key) : [{ ...t, addedAt: Date.now() }, ...S.favorites]
      if (S.cloud) await saveFavorites().catch(() => {})
      render()
      updatePlayerBar()
    })
    $('#cpPlayAll') && ($('#cpPlayAll').onclick = () => {
      const list = cpTracks()
      if (!list.length) return toast('榜单还在载入，请稍候')
      playList(list, 0, title, { id: `chart:${cpKey()}`, name: cp?.title || '' })
    })
    $('#cpBatch') && ($('#cpBatch').onclick = () => {
      const list = cpTracks()
      if (!list.length) return toast('榜单还在载入，请稍候')
      openPickSheet(list.map((t) => t.key))
    })
    // 榜单行：批量模式下点行 = 勾选，与乐馆歌单列表一致
    document.querySelectorAll('.orange-cp-row').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return
        if (!S.pickMode) return
        const k = row.dataset.key
        if (!k) return
        if (S.picked.has(k)) S.picked.delete(k)
        else S.picked.add(k)
        row.classList.toggle('picked', S.picked.has(k))
        const cb = row.querySelector('input[data-pick]')
        if (cb) cb.checked = S.picked.has(k)
        const bar = document.querySelector('.list-actions .la-count')
        if (bar) bar.textContent = `已选 ${S.picked.size} 首`
        render()
      }
    })
    document.querySelectorAll('[data-pickkey]').forEach((cb) => {
      cb.onchange = () => {
        const k = cb.dataset.pickkey
        if (cb.checked) S.picked.add(k)
        else S.picked.delete(k)
        render()
      }
    })
  }
  document.querySelectorAll('.orange-tr').forEach((row) => row.onclick = (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
    const k = row.dataset.key
    if (S.orangePicking) {
      if (S.picked.has(k)) S.picked.delete(k)
      else S.picked.add(k)
      row.classList.toggle('picked', S.picked.has(k))
      const cb = row.querySelector('input[data-pick]')
      if (cb) cb.checked = S.picked.has(k)
      const wbar = document.querySelector('.orange-pick-count')
      if (wbar) wbar.textContent = `已选 ${S.picked.size} 首`
      syncPickBadges()
      return
    }
    // 非批量：左键点选行高亮（QQ 式「选中」态，展示行内工具）
    const was = row.classList.contains('sel')
    document.querySelectorAll('.orange-tr.sel').forEach((r) => r.classList.remove('sel'))
    if (!was) row.classList.add('sel')
  })
  // 列表工具条 + 搜索框：document 级事件只注册一次（bindView 每次 render 都会执行，
  // 不加守卫会累积监听器 → 每次按键触发 N 次 render → 最近播放卡死、搜索失灵）
  if (!S._docListenersBound) {
    S._docListenersBound = true
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-clearsearch]')) { S.pageQuery = ''; render(); return }
      const lt = e.target.closest('[data-libtool]')
      if (!lt) return
      const k = lt.dataset.libtool
      if (k === 'search') {
        S.libSearchOpen = !S.libSearchOpen
        if (!S.libSearchOpen) S.libQuery = ''
        render()
        if (S.libSearchOpen) $('#libSearchInput')?.focus()
      } else if (k === 'view') {
        S.orangeView = S.orangeView === 'normal' ? 'compact' : 'normal'
        render()
      } else if (k === 'history') {
        openCtxMenu(lt, [
          { label: '全部', onClick: () => { S.libRange = 'all'; render() } },
          { label: '今天', onClick: () => { S.libRange = 'today'; render() } },
          { label: '近 7 天', onClick: () => { S.libRange = '7d'; render() } },
          { label: '近 30 天', onClick: () => { S.libRange = '30d'; render() } },
        ])
      } else if (k === 'filter') {
        openCtxMenu(lt, [
          { label: '全部歌曲', onClick: () => { S.libFilter = 'all'; render() } },
          { label: '只看我喜欢', onClick: () => { S.libFilter = 'liked'; render() } },
          { label: '只看未喜欢', onClick: () => { S.libFilter = 'unliked'; render() } },
        ])
      }
    })
    // 列表内搜索框（歌单详情 / 库列表）：改值后重渲染并回焦光标。
    // ⚠ 中文输入法：组字过程中每敲一个键就 render() 会销毁正在组字的 <input>，
    // 输入法组合被打断 → 表现就是「搜索框打不出字」。所以：
    //  1) e.isComposing 期间不动 DOM；
    //  2) 正常输入也做 180ms 防抖，避免每个字符重建整页；
    //  3) 重绘后把光标恢复到末尾。
    let listSearchTimer = 0
    document.addEventListener('input', (e) => {
      const s = e.target
      if (!s || !['libSearchInput', 'plSearchInput', 'artistSearchInput'].includes(s.id)) return
      if (s.id === 'libSearchInput') S.libQuery = s.value
      else if (s.id === 'artistSearchInput') S.artistQuery = s.value
      else S.pageQuery = s.value
      if (e.isComposing) return
      const id = s.id
      const caret = s.value.length
      clearTimeout(listSearchTimer)
      listSearchTimer = setTimeout(() => {
        render()
        const el = document.getElementById(id)
        if (el) { el.focus(); try { el.setSelectionRange(caret, caret) } catch { /* 不支持则忽略 */ } }
      }, 180)
    })
  }
  $('#orangeLocalAdd') && ($('#orangeLocalAdd').onclick = orangeLoadLocal)
  $('#orangeDemoGo') && ($('#orangeDemoGo').onclick = () => goto('hall'))
  $('#goArtistsBtn') && ($('#goArtistsBtn').onclick = () => goto('hall', { hallTab: '歌手' }))
  document.querySelectorAll('[data-libjump]').forEach((b) => b.onclick = () => { S.libTab = b.dataset.libjump; render() })
  $('#ovPlayFav') && ($('#ovPlayFav').onclick = () => S.favorites.length ? playList(S.favorites, 0, '我喜欢的音乐') : toast('还没有收藏歌曲'))
  $('#ovImport') && ($('#ovImport').onclick = () => $('#importSheet').hidden = false)
  $('#ovRefresh') && ($('#ovRefresh').onclick = async () => { await loadEvents(true); render(); toast('听歌报告已刷新') })

  // 设置
  $('#setQuality') && ($('#setQuality').onchange = (e) => changeQuality(e.target.value))
  $('#setMode') && ($('#setMode').onchange = (e) => setPlayMode(e.target.value))
  $('#setResume') && ($('#setResume').onchange = (e) => {
    const on = e.target.checked
    saveSetting('resumeLast', on)
    if (!on) S.resume = null
    const st = $('#setResumeState')
    if (st) { st.textContent = on ? '已开启' : '已关闭'; st.classList.toggle('on', on) }
    toast(on ? '已开启：下次启动还原上次那首（不自动出声）' : '已关闭：下次启动从空白播放页开始')
  })
  $('#setLockLyric') && ($('#setLockLyric').onchange = (e) => {
    const on = e.target.checked
    saveSetting('lockLyric', on)
    // 立刻生效：开启→把当前歌词写进锁屏；关闭→还原为专辑名
    try { lockLyricKey = ''; syncLockScreenLyric(S.positionMs, true) } catch { /* 无 mediaSession */ }
    toast(on ? '已开启：锁屏 / 控制中心显示当前歌词' : '已关闭：锁屏不再显示歌词')
  })
  $('#setCompact') && ($('#setCompact').onchange = (e) => {
    saveSetting('compact', e.target.checked)
    toast(e.target.checked ? '已切换为紧凑列表' : '已恢复宽松列表')
  })
  $('#setOfficialOnly') && ($('#setOfficialOnly').onchange = async (e) => {
    const on = e.target.checked
    setOfficialOnly(on)
    const st = $('#setOfficialState')
    if (st) { st.textContent = on ? '已开启' : '已关闭'; st.classList.toggle('on', on) }
    // 让开关立刻见效：已加载的 /api/* 数据按新规则重过滤；
    // 关闭时清掉内存缓存重拉一次，把之前被隐藏的版本恢复回来。
    iosApplyOfficialOnly(on)
    try { await syncUserState() } catch { /* 离线状态照常 */ }
    toast(on ? '已开启：只显示正式发行的原版' : '已关闭：显示全部版本与音源')
  })
  $('#setSrcBtn') && ($('#setSrcBtn').onclick = openSourceSheet)
  $('#setMusicApiBaseSave') && ($('#setMusicApiBaseSave').onclick = () => {
    const v = $('#setMusicApiBase')?.value?.trim() || ''
    setMusicApiBase(v)
    toast(v ? '已保存 iOS 音源中转地址' : '已清空：iOS 将走公共代理降级')
    render()
  })
  $('#setMusicApiUrlSave') && ($('#setMusicApiUrlSave').onclick = () => {
    const v = $('#setMusicApiUrl')?.value?.trim() || ''
    setMusicApiUrl(v)
    toast(v ? '已启用外部音乐 API（取不到链自动回退内置引擎）' : '已清空：继续用内置音乐引擎')
    render()
  })
  document.querySelectorAll('[data-scheme-set]').forEach((b) => b.onclick = () => {
    applyScheme(b.dataset.schemeSet)
    render()
    toast(`外观：${SCHEME_MODES.find((x) => x.id === b.dataset.schemeSet)?.label || ''}`)
  })
  $('#setAutoStart') && ($('#setAutoStart').onchange = async (e) => {
    const on = e.target.checked
    S.autoStart = on
    try { localStorage.setItem('orangemusic:autostart', on ? '1' : '0') } catch { /* 隐私模式 */ }
    await window.orangeWindow?.setAutoStart?.(on)
    toast(on ? '已开启开机启动' : '已关闭开机启动')
  })
  $('#setMiniBtn') && ($('#setMiniBtn').onclick = () => setMiniMode(true))
  // 关闭按钮行为（问一次后再也不问的话，可以在这里改回来）
  if ($('#setCloseAction')) {
    const sel = $('#setCloseAction')
    window.orangeWindow?.getCloseAction?.().then((v) => { if (v) sel.value = v }).catch(() => {})
    sel.onchange = async () => {
      const v = sel.value
      try { await window.orangeWindow?.setCloseAction?.(v) } catch { /* 无宿主 */ }
      toast(v === 'tray' ? '已设置：关闭时最小化到托盘' : v === 'quit' ? '已设置：关闭时直接退出软件' : '已设置：关闭时每次询问')
    }
  }
  $('#setUpdateCheck') && ($('#setUpdateCheck').onclick = () => runUpdateCheck(true))
  $('#setChangelog') && ($('#setChangelog').onclick = () => openChangelog())
  $('#setAutoUpdate') && ($('#setAutoUpdate').onchange = (e) => {
    S.core?.updater?.saveCfg({ auto: e.target.checked })
    toast(e.target.checked ? '已开启：启动时自动检查更新' : '已关闭启动自动检查')
  })
  $('#setUpdRepoSave') && ($('#setUpdRepoSave').onclick = () => {
    const repo = ($('#setUpdRepo').value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('格式应为 owner/repo，例如 yourname/orange-music')
    S.core?.updater?.saveCfg({ repo })
    S.update = null
    toast('更新仓库已保存')
    render()
  })
  $('#setLogout') && ($('#setLogout').onclick = async () => {
    if (!S.cloud) return toast('核心未就绪')
    await S.core.auth.signOut()
    location.reload()
  })
  $('#profLogout') && ($('#profLogout').onclick = async () => {
    if (!S.cloud) return toast('核心未就绪')
    await S.core.auth.signOut()
    location.reload()
  })
  $('#setLogin') && ($('#setLogin').onclick = () => { $('#loginSheet').hidden = false })
  // iOS「我的」页：登录 / 退出 / 立即同步（与 Windows 同一账号体系）
  $('#iosLogin') && ($('#iosLogin').onclick = () => {
    const sheet = $('#loginSheet')
    if (sheet) { sheet.hidden = false; try { bindAuthSheet() } catch { /* 已绑定 */ } }
  })
  $('#iosLogout') && ($('#iosLogout').onclick = async () => {
    // 本地测试账号：记「已退出」标记，重启后不再自动登录；想再测从登录面板一键启用
    if (S.localTest) {
      try { localStorage.setItem('orangemusic:testLoggedOut', '1') } catch { /* 隐私模式 */ }
      try { await S.core.auth.signOut() } catch { /* 无真实云端会话，失败可忽略 */ }
      location.reload()
      return
    }
    if (!S.cloud) return toast('核心未就绪')
    await S.core.auth.signOut()
    location.reload()
  })
  $('#iosSyncNow') && ($('#iosSyncNow').onclick = async () => {
    if (!S.cloud) return toast('核心未就绪')
    toast('正在同步…')
    try { await syncUserState(); await render(); toast('已同步') } catch (e) { toast(e.message) }
  })
  document.querySelectorAll('[data-clear]').forEach((b) => b.onclick = () => clearData(b.dataset.clear))
  $('#goChartsBtn') && ($('#goChartsBtn').onclick = openAllCharts)
  $('#refreshRecBtn') && ($('#refreshRecBtn').onclick = async () => {
    if (!S.cloud) return toast('核心未就绪')
    try { S.recommend = await S.core.rec.refreshRecommend(true); await render(); toast('推荐已更新') } catch (e) { toast(e.message) }
  })
  $('#refreshPlBtn') && ($('#refreshPlBtn').onclick = async () => {
    try { await loadPlaza(true); toast('歌单已刷新') } catch (e) { toast(e.message) }
  })
  $('#refreshRadioBtn') && ($('#refreshRadioBtn').onclick = async () => {
    if (!S.core) return toast('核心未就绪')
    toast('正在后台刷新全部电台…')
    try { await warmRadio(100, { force: true }); await render(); toast('电台已更新') } catch (e) { toast(e.message) }
  })
  $('#openImportBtn') && ($('#openImportBtn').onclick = () => $('#importSheet').hidden = false)
  $('#openImportBtn2') && ($('#openImportBtn2').onclick = () => $('#importSheet').hidden = false)
  $('#openSourceBtn') && ($('#openSourceBtn').onclick = openSourceSheet)
  // 音源与音质是内嵌页面，控件随每次渲染重建，这里统一绑定
  bindSourcePage()
  const si = $('#searchInput')
  if (si) si.onkeydown = (e) => { if (e.key === 'Enter') { S.query = si.value; runSearch(si.value) } }
}

// 列表来源标识：用来判断「这次点歌是不是同一张歌单」。
// 同一张歌单继续沿用现有队列；换一张歌单才清空重建。
function pageListMeta(p) {
  const s = p?.source || {}
  const type = s.type || 'list'
  const id = s.id || p?.title || ''
  return { id: `${type}:${id}`, name: p?.title || '', cover: p?.cover || '', artist: s.artist || '' }
}

// 当前页面/板块是否是一张「歌单式列表」。是则返回它的曲目与来源标识。
function currentListContext() {
  if (S.page?.kind === 'list' && Array.isArray(S.page.tracks) && S.page.tracks.length) {
    return { tracks: S.page.tracks, meta: pageListMeta(S.page) }
  }
  if (S.section === 'peak' || S.section === 'rise') {
    const list = cpTracks()
    if (list.length) return { tracks: list, meta: { id: `chart:${cpKey()}`, name: cpConf()?.title || '' } }
  }
  // 搜索页：点结果里的任意一首，也应把整批结果按顺序入队（而不是只塞一首）
  if (S.section === 'search' && !S.page && S.searchResults.length) {
    return { tracks: S.searchResults, meta: { id: `search:${S.query || ''}`, name: `搜索：${S.query || ''}` } }
  }
  // 首页「实时推荐」：这一屏就是一张歌单
  if (S.section === 'home' && !S.page && S.recommend?.tracks?.length) {
    return { tracks: S.recommend.tracks, meta: { id: `recommend:${S.recommend.day || S.recommend.at || ''}`, name: '每日推荐' } }
  }
  if (S.section === 'library' && !S.page) {
    const map = { '我喜欢': S.favorites, '最近播放': S.recent, '本地歌曲': S.localTracks, '试听列表': [] }
    const list = map[S.libTab]
    if (Array.isArray(list) && list.length) return { tracks: list, meta: { id: `lib:${S.libTab}`, name: S.libTab } }
  }
  return null
}

// 从一个歌单/列表开始播放：
//   · 换歌单 → 清空原队列，整张列表按原顺序填入，从所点的那首开始（播完最后一首回到第一首）；
//   · 同一歌单 → 保持原队列不动，只切到所点的歌。
function playFrom(list, start = 0, meta = {}) {
  // 从搜索 / 榜单 / 歌单点歌 = 离开私人推荐流，别让队列尾部再触发续杯
  if (IS_IOS) iosStopRecFlow()
  const raw = (list || []).filter((t) => t?.key)
  const tracks = filterOfficial(raw).filter((t) => t?.key)
  if (!tracks.length) return toast('列表为空')
  // start 传的是「用户点的那首」的 key（或已过滤列表里的下标）。
  // 用 key 定位而不是原始下标：开了「只听正式发行版」时，前面被过滤掉的曲目
  // 不会让队列起点错位到别的歌。
  const kept = new Set(tracks.map((t) => t.key))
  let idx = 0
  if (typeof start === 'string') {
    const p = raw.findIndex((x) => x.key === start)
    if (p >= 0) idx = raw.slice(0, p).filter((x) => kept.has(x.key)).length
  } else idx = Number(start) || 0
  idx = Math.max(0, Math.min(idx, tracks.length - 1))
  const id = String(meta.id || '')
  const sameSource = !!(id && S.queueFrom?.id === id)
  if (!sameSource) {
    S.queue = capQ(tracks.slice())
    // 队列来源带全元数据（名/封面/专辑歌手）：试听列表「听过的专辑/歌单」靠它记录，
    // 播放成功时用户往往已经翻到别的页面，S.page 不可靠，S.queueFrom 才是可靠来源
    S.queueFrom = { id, name: String(meta.name || ''), cover: meta.cover || '', artist: meta.artist || '' }
  }
  // 同一歌单换歌时复用队列里已解析过直链的那份，避免再等一次取链
  const pick = tracks[idx]
  const queued = sameSource ? (S.queue || []).find((x) => x.key === pick.key) : null
  return playTrack(queued || pick)
}

function playByKey(key) {
  if (key.startsWith('pl-')) {
    const pl = S.playlists.find((p) => p.id === key)
    if (pl) return openMyPlaylist(pl.id)
    return
  }
  // 歌单式列表里点歌：整张列表入队（换歌单则重建，同歌单沿用原队列）
  const ctx = currentListContext()
  if (ctx && ctx.tracks.some((x) => x.key === key)) return playFrom(ctx.tracks, key, ctx.meta)
  // 曲目已在播放队列里（例如列表刚异步刷新、DOM 还是旧的一帧）：只切歌，不要再追加一首
  const inQueue = (S.queue || []).find((x) => x.key === key)
  if (inQueue) return playTrack(inQueue)
  const t = allTracks().find((x) => x.key === key)
  if (t) playTrack(t)
  else toast('曲目不在当前列表中，请先搜索')
}

// 单击与双击都会落到同一个入口。双击时浏览器会先派发两次 click，
// 不去重就会连发三次取链请求（甚至把队列重建三遍）。
let lastRowPlay = { key: '', at: 0 }
function playRowByKey(key) {
  if (!key) return
  const now = Date.now()
  if (lastRowPlay.key === key && now - lastRowPlay.at < 450) return
  lastRowPlay = { key, at: now }
  playByKey(key)
}

async function runSearch(q, stay = false) {
  if (!S.cloud) return toast('核心未就绪')
  if (!stay) { S.section = 'search'; S.page = null }
  S.query = q
  await render()
  markActive()
  const status = $('#searchStatus')
  if (status) status.textContent = '正在检索…'
  try {
    // iOS：直接打同源 /api/search（服务端已并行聚合网易云+酷我并补好封面），
    // 一次请求就出结果；不再走前端多引擎串行搜索（那才是「等半天没内容」的原因）。
    if (IS_IOS) {
      const [j, sp] = await Promise.all([
        iosApi(`/api/search?q=${encodeURIComponent(q)}&limit=40`, 3 * 60 * 1000),
        // 歌单单独一路：只出歌单实体，不再混进单曲列表
        iosApi(`/api/search/playlist?q=${encodeURIComponent(q)}&limit=20`, 3 * 60 * 1000),
      ])
      S.searchPlaylists = (sp?.list || []).filter((x) => x.id && x.name)
      const rows = iosNormList(j?.list || [])
        // 只收「真的是歌」的行：必须有歌手，时长不为 0 时要像一首歌
        .filter((x) => String(x.artist || '').trim() && (Number(x.durationMs) === 0 || Number(x.durationMs) > 45000))
        .map((x) => makeTrack({
          title: x.title, artist: x.artist, album: x.album || '',
          durationMs: x.durationMs || 0, cover: x.cover || '',
          license: 'third-party', licenseUrl: 'auto-discovered', tags: [],
          pending: { source: x.source, id: String(x.id || ''), name: x.title, singer: x.artist, albumName: x.album || '', durationMs: x.durationMs || 0, picId: '' },
        }))
      S.searchResults = sortByNewest(filterRelevant(officialBoost(rows), q))
    } else {
      S.searchResults = sortByNewest(officialBoost(filterRelevant(filterOfficial(await S.core.sources.searchAll(q)), q)))
    }
    // 不要把搜索结果并进播放队列：队列必须始终等于「用户最近点的那张歌单」。
    // 点搜索结果时 playByKey 会按 search:<关键词> 重建整批队列。
    await render()
    schedulePrefetch(S.searchResults)
    if (status) status.textContent = ''
    if (!S.searchResults.length) {
      toast(`没有找到「${q}」的可播放曲目，换个关键词或歌手名试试`)
    }
  } catch (err) {
    if (status) status.textContent = ''
    toast(`搜索失败：${err.message}`)
  }
}

// 首页榜单曲目预热（保留旧入口，内部走同一套预热逻辑）
function ensureLanes(charts = []) { return warmCoverTracks(charts, 14) }

// 口味标签：推荐标签 + 最近播放 / 收藏的歌手，用于给歌单和歌手排序加权。
const tasteTags = () => {
  const out = []
  for (const t of S.recommend?.tags || []) out.push(String(t))
  for (const t of [...S.recent.slice(0, 10), ...S.favorites.slice(0, 10)]) if (t?.artist) out.push(String(t.artist))
  return [...new Set(out.filter(Boolean))].slice(0, 10)
}

// 推荐歌单 / 热门歌手：多平台聚合 + 智能排序（内部有 20 分钟缓存 + 分源缓存）。
// 关键点：不等所有平台都回来才渲染——谁先回来先上屏（onPartial），剩下的陆续补。
async function loadDiscover(force = false) {
  if (!S.core) return
  const taste = tasteTags()
  const chartMap = new Map([...S.chartTracks.entries()].filter(([, v]) => v?.length))
  let timer
  const bump = () => {
    if (S.page) return                    // 子页面上不打断阅读
    clearTimeout(timer)
    timer = setTimeout(() => render(), 160)
  }
  try {
    const [pls, arts] = await Promise.all([
      S.core.discover.recommendedPlaylists({
        limit: 18, taste, chartMap, force, refresh: true,
        onPartial: (items) => { if (items.length) { S.discover.playlists = items; bump() } },
      }),
      S.core.discover.hotArtists({
        limit: 50, taste, chartMap, force, refresh: true,
        onPartial: (items) => { if (items.length) { S.discover.artists = items; bump() } },
      }),
    ])
    if (pls.length) S.discover.playlists = pls
    if (arts.length) S.discover.artists = arts
    clearTimeout(timer)
    if (!S.page) render()
    warmPlaylistCounts()   // 后台补齐首页歌单卡片的真实曲目数（角标动态化）
  } catch (e) { console.warn('[发现]', e.message) }
}

// 后台补齐首页歌单卡片的真实曲目数：拿到后立即刷新首页角标，实现「Daily N」动态跟随。
function warmPlaylistCounts() {
  if (!S.core?.discover?.playlistCount) return
  const list = (S.discover.playlists || []).slice(0, 10)
  for (const p of list) {
    if (!p?.id || S.plCounts[p.id] != null) continue
    S.core.discover.playlistCount(p).then((n) => {
      if (!n) return
      S.plCounts[p.id] = n
      if (S.section === 'home' && !S.page) render()
    }).catch(() => {})
  }
}

// 全站页面预热（第 7 项）：首次启动或清缓存后，在空闲时段按「先主后次、逐项错峰」
// 把各页面要用的数据都备进内存 / 本机缓存。用户点进任意页时直接读缓存，不再出现「加载中」。
// 播放中自动降速（每项前多等 2.5s），且每项串行、并发压在各模块内部，避免抢音频带宽导致卡顿。
let allPagesWarmed = false
function warmAllPages() {
  // iOS：页面数据全部走同源 /api，直连网易云/QQ/酷狗的预热请求只会被 CORS 拦掉，
  // 白白占连接、刷一屏报错、拖慢首屏；iOS 的预热由 iosLoadFeed() 负责。
  if (IS_IOS) return
  if (allPagesWarmed) return
  if (!S.core) return                 // 核心未就绪：不占标志，下次再预热
  allPagesWarmed = true
  // 错峰「启动」而不是串行 await：歌单广场这类慢聚合会把后面的页面全堵住。
  // 项与项之间留间隔，播放中把间隔拉长，保证音频缓冲优先，不抢带宽。
  const tasks = [
    () => loadDiscover(false),                                        // 首页推荐歌单 / 热门歌手
    async () => {                                                       // 每日推荐
      const r = await S.core.rec.refreshRecommend().catch(() => null)
      if (r) { S.recommend = r; if (S.section === 'home' && !S.page) render() }
    },
    () => warmCoverTracks(S.core.charts.topCharts(8, { real: true }), 14),  // 首页今日榜单
    () => loadArtistDir(true),                                          // 乐馆歌手名录
    () => loadPlaza(false),                                             // 乐馆歌单广场
    () => warmRadio(100),                                               // 乐馆电台 6 台
    () => {                                                             // 乐馆「全部榜单」剩余封面
      try {
        const all = (S.core.charts.groupedBoards() || []).flatMap((g) => g.charts || [])
        if (all.length) return warmCoverTracks(all, 8)
      } catch { /* 分组异常忽略 */ }
    },
  ]
  let i = 0
  // 用户刚有操作 / 正在播放时把间隔拉长：预热是「后台补数据」，不能和用户抢主线程与带宽。
  let lastInputAt = 0
  const markInput = () => { lastInputAt = Date.now() }
  document.addEventListener('pointerdown', markInput, true)
  document.addEventListener('keydown', markInput, true)
  const launch = () => {
    if (i >= tasks.length) return
    const fn = tasks[i++]
    Promise.resolve().then(fn).catch(() => {})
    const busy = S.playing || Date.now() - lastInputAt < 2500
    setTimeout(launch, busy ? 4000 : 2200)
  }
  setTimeout(launch, 0)
}

// 首页快捷入口
function quickAction(id) {
  if (id === 'import') { $('#importSheet').hidden = false; return }
  if (id === 'charts') return openAllCharts()
  if (id === 'playlists') return goto('hall', { hallTab: '歌单广场' })
  if (id === 'fm') return goto('hall', { hallTab: '电台' })
  if (id === 'new') return runSearch('new release')
  if (id === 'daily') {
    if (!S.cloud) return toast('核心未就绪')
    S.core.rec.refreshRecommend(true)
      .then((p) => {
        S.recommend = p
        // 异步可能十几秒后才回来：用户早已切到别的板块，别把人硬拽回首页
        if (S.section === 'home' && !S.page) render()
        toast('每日推荐已更新')
      })
      .catch((e) => toast(e.message))
  }
}

// ---- 播放 ----
// 连续「播不了」自动跳过的计数器：整列都取不到链时给个上限，避免无限空转
let skipGuard = 0
let lastFailAt = 0
// 首轮等待：18 秒内拿到就秒播；拿不到说明音源回源慢，继续等而不是直接跳过。
const RESOLVE_TIMEOUT_MS = 18000
// 慢速追加等待：波点/酷我回源偶尔要 20~40 秒，这段时间内出链仍然照播。
const RESOLVE_SLOW_WAIT_MS = 45000

// 播不了就跳过。关键点：**不 await 下一首**，把调用链立刻解开。
// 以前是 `return playTrack(nextOne)`，一整列歌都取不到链时会一层层套住 await，
// 界面就一直停在「没反应」上，直到找到能播的歌才恢复 —— 也就是用户说的假卡死。
// 换源成功后把新链接写回所有引用（队列 / 搜索结果 / 当前页 / 当前曲），
// 这样同一首歌再点一次直接用新链接，不会又走一遍失败链路。
function applyStreams(key, streams, curMi = null) {
  const put = (x) => (x && x.key === key ? { ...x, streams } : x)
  if (Array.isArray(S.queue)) S.queue = S.queue.map(put)
  if (Array.isArray(S.searchResults)) S.searchResults = S.searchResults.map(put)
  if (Array.isArray(S.page?.tracks)) S.page.tracks = S.page.tracks.map(put)
  if (S.current?.key === key) S.current = { ...S.current, streams }
  // 换源拿到的这条链也写进直链缓存：否则同一首歌（歌单里的 pending 曲目）每次都要重走取链
  // 带 ID 指纹：这条链是给哪个平台+ID 取的，缓存就只认这个 ID，杜绝同名不同版本串链
  try { S.core?.sources?.applyCachedStreams?.(key, streams, '', curMi) } catch { /* ignore */ }
}

// 手动点「播放 / 暂停」失败后的短窗口：停在当前曲只提示，绝不自动跳下一首。
// 自动连播（播完 / 队列续播）不受影响。
let noAutoSkipUntil = 0
// 立刻停掉音频并把「这条音频属于哪首」清空：调用它之后，任何巡检都不会再让它出声，
// 也不会把它的时间算到当前曲的进度上。
function stopAudioNow() {
  try {
    const a = $('#previewAudio')
    if (a) { if (!a.paused) a.pause(); a.dataset.omKey = '' }
  } catch { /* ignore */ }
}
function failAndNext(t, msg) {
  S.playing = false
  if (Date.now() < noAutoSkipUntil) {
    stopAudioNow()
    endStaleGuard()
    updatePlayerBar()
    toast(/iOS 播放授权/.test(String(msg || '')) ? '请再点一次播放键以开始（iOS 需要一次点击授权）' : PLAY_FAIL, true)
    return
  }
  // 换下一首之前必须把当前音频停掉：否则上一首会继续出声，
  // 用户听到的就是「界面跳到下一首、播的还是上一首」。
  stopAudioNow()
  endStaleGuard()
  updatePlayerBar()
  // 下一首怎么找：先在播放队列里找，找不到（或在队尾）再用当前页面 / 搜索结果兜底 ——
  // 以前只看队列，点单曲播放时队列里就一首，于是直接弹「暂无可播放链接」不再往下试。
  const idxIn = (list) => (Array.isArray(list) ? list.findIndex((x) => x?.key === t.key) : -1)
  let i = idxIn(S.queue)
  let nextOne = i >= 0 ? S.queue[i + 1] : null
  if (!nextOne || nextOne.key === t.key) {
    for (const alt of [S.page?.tracks, S.searchResults]) {
      const j = idxIn(alt)
      const cand = j >= 0 ? alt[j + 1] : null
      if (cand && cand.key !== t.key) { nextOne = cand; break }
    }
  }
  const now = Date.now()
  if (now - lastFailAt > 4000) skipGuard = 0
  lastFailAt = now
  // ★ 自动连跳上限：整队列都取不到音源时，以前会一首接一首无限往下跳，
  //   每跳一次都重绘播放页 —— 用户看到的就是「页面不断闪烁、点不动」。
  //   现在连续 3 首失败就停下来留着界面可用。
  if (now - autoSkipAt > 6000) autoSkipChain = 0
  autoSkipAt = now
  autoSkipChain++
  if (autoSkipChain > 3) {
    autoSkipChain = 0
    skipGuard = 0
    if (IS_IOS) { try { iosRenderNav() } catch { /* ignore */ } }
    toast('连续多首取不到音源，已停止自动切换', true)
    return
  }
  // 连续失败不设上限（用户要求）：一直往后找到能播的为止。
  // 只保留「队列到底就停」这一个终点，避免真的空转。
  const canSkip = !!(nextOne && nextOne.key !== t.key)
  if (!canSkip) {
    skipGuard = 0
    toast(PLAY_FAIL, true)
    return
  }
  skipGuard++
  toast(PLAY_FAIL, true)
  setTimeout(() => { playTrack(nextOne, 0, { auto: true }).catch(() => {}) }, 20)
}
// 自动跳歌的连续计数（成功起播即清零）
let autoSkipChain = 0
let autoSkipAt = 0
// 同一首歌「链接失效 → 重取」的重试计数，成功起播时清零
let audioErrRetry = 0

// 播放请求序号：快速连点下一首时，旧的那次可能还在等取链（几秒），
// 若它的结果晚于新请求回来，会覆盖界面 / 误跳两首。每次点播 +1，异步点后校验仍是最新才落盘。
let playSeq = 0
// ── 切歌「界面已换、声音还没跟上」的过渡态 ────────────────────────────────
// 用户反馈：切到一首取不到链的歌（如 哼 - 冯提莫）时，封面/标题已经是新歌、
// 进度条还在走、耳朵里仍是上一首，直到「暂时无法播放」才好。
// 根因：<audio> 里挂的还是上一首的音频，只要它还在播，进度/声音就都属于旧歌。
// 这里显式记录「正在起播的曲目 key」，期间：
//   ① 每 250ms 巡检一次，发现音频不是这一首还在出声就立刻压住；
//   ② 进度条按 0 显示，绝不拿旧音频的时间算到新歌头上。
let loadingKey = ''
let staleGuardTimer = 0
function startStaleGuard(key) {
  loadingKey = String(key || '')
  if (staleGuardTimer) return
  staleGuardTimer = setInterval(() => {
    if (!loadingKey) return
    if (S.current?.key !== loadingKey) { loadingKey = ''; return }
    const a = $('#previewAudio')
    if (!a || a.dataset.omKey === loadingKey) return
    // 音频元素里还是别的曲目（上一首）→ 立刻停掉，别让它继续出声/继续走进度
    if (!a.paused) { try { a.pause() } catch { /* ignore */ } }
    // ★ 绝不能置 'none'：那等于告诉 iOS「本应用没有活跃会话」，锁屏卡还在显示我们的歌，
    //   但系统的「正在播放应用」已经换成别人 —— 点卡片就跳去别的应用（用户反馈的现象）。
    //   过渡态用 'paused' 保持会话归属。
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch { /* ignore */ }
  }, 250)
}
function endStaleGuard() { loadingKey = '' }
// 当前音频元素是否「属于正在播放的这一首」：false 表示它还是上一首的残响
function audioIsStale() {
  if (!loadingKey) return false
  const a = $('#previewAudio')
  return !a || a.dataset.omKey !== loadingKey
}
async function playTrack(t, pos = 0, opts = {}) {
  if (!t) return
  // 记录点歌这一刻的界面：取链成功后据此决定是否把播放页顶上来。
  // 用户若在取链这几秒里切到了别的页面 / 打开了抽屉，就不要再抢界面（旧逻辑会「切回去」）。
  const viewSigAtStart = IS_IOS ? iosViewSig() : ''
  // iOS Safari：<audio>.play() 必须在用户手势内发起。点歌这一下的同步栈是唯一可靠时机，
  // 后面 await 取链 2~4 秒会让手势 / transient activation 失效，异步 play() 必被拒。
  // 先同步激活同一个 <audio> 元素，再异步取链（元素已激活则允许程序化 play）。
  // iOS Safari：先同步（手势内）激活同一个 <audio>，让 iOS 把元素标记为「已播放」。
  // ★ 关键改动：这里**同步调用但不立即 await** —— 先让下面的 S.current / updatePlayerBar
  //   立刻执行、给出即时反馈，解锁再随后补等（最多 1s）。旧写法先 await 解锁（最多 1.2s）
  //   才更新界面，看起来就是「点了没反应 / 切歌像卡住」。
  let unlockP = null
  if (!opts.auto) { try { unlockP = native.unlockAudio?.() } catch { /* 忽略 */ } }
  const seq = ++playSeq
  if (!opts.auto) skipGuard = 0
  // 先把界面切过去：取链可能要几秒，别让人对着上一首的封面以为卡死了
  // 只有 pending 才需要「解析」；但老歌单里可能既没有 pending 也没有可用直链，
  // 这类条目同样得先搜一次歌名，否则会被当成「没有音源」直接跳过。
  // 队列预取 / 恢复出来的直链是带签名的临时地址，放久了会 403。
  // 超过 5 分钟就当作没有链，重新取一次（force 会让 /api/url 绕开服务端缓存）。
  const streamAge = t.__streamAt ? Date.now() - Number(t.__streamAt) : 0
  // 诊断截图里 code=4 的死链是 /20261111162955/ 这种几天前签发的 CDN 地址，
  // 从云端同步 / 本地存档恢复的曲目常带着它且没有 __streamAt，旧逻辑看不出过期直接拿去播。
  // 只按「签发日期早于今天」判定，不会误杀当天签发的有效链。
  const nowD = new Date()
  const todayKey = Number(`${nowD.getFullYear()}${String(nowD.getMonth() + 1).padStart(2, '0')}${String(nowD.getDate()).padStart(2, '0')}`)
  const signedDay = (u) => { const m = String(u || '').match(/\/(20\d{12})\//); return m ? Number(m[1].slice(0, 8)) : 0 }
  const hasOldSigned = (t.streams || []).some((s) => { const day = signedDay(s?.url); return day > 0 && day < todayKey })
  const staleStreams = !!t.streams?.length && (streamAge > 5 * 60 * 1000 || hasOldSigned)
  const needResolve = (!t.streams?.length || staleStreams) && !!(t.pending || t.title)
  const resolveViaSearch = !t.pending && needResolve
  const switchingTo = t.key
  const prevKey = S.current?.key
  S.current = t
  S.positionMs = pos
  // 切到不同歌曲时，立刻停掉上一首：否则在「解析 / 取链」那几秒里，
  // 界面已经切到新歌、耳朵里还是上一首（用户反馈的「切了歌还播原来的」）。
  // 同一首（比如重试 / 单曲循环）不动它，避免刚暂停又被自己重启。
  if (!prevKey || prevKey !== switchingTo) {
    try {
      const a = document.getElementById('previewAudio')
      if (a) {
        if (!a.paused) a.pause()
        // 标记「这条音频不再属于当前曲」：巡检据此判断要不要压住它
        a.dataset.omKey = ''
      }
    } catch { /* ignore */ }
    // ★ 绝不能置 'none'：那等于告诉 iOS「本应用没有活跃会话」，锁屏卡还在显示我们的歌，
    //   但系统的「正在播放应用」已经换成别人 —— 点卡片就跳去别的应用（用户反馈的现象）。
    //   过渡态用 'paused' 保持会话归属。
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch { /* ignore */ }
    // 起播前进入「过渡态」：界面已经切过去，声音还没跟上，进度条按 0 显示
    startStaleGuard(switchingTo)
  }
  // 队列顺序必须保持「用户加入时的列表顺序」。以前这里把当前曲 unshift 到队头，
  // 于是 next() 永远在「当前曲 → 下一首 → 当前曲」之间来回切，后面的歌根本播不到。
  // 只在该曲确实不在队列时追加到末尾，绝不重排已有顺序。
  if (!S.queue.some((x) => x.key === t.key)) S.queue = capQ([...S.queue, t])
  S.playing = false
  updatePlayerBar()
  native.setMetadata(t).catch(() => {})
  // 界面已经即时切到目标曲（上面是同步执行的）；这里再补等静音解锁，最多 1s，
  // 让随后取链完成时的真实 play() 被 iOS 放行。解锁异常也不会卡住播放。
  if (unlockP && typeof unlockP.then === 'function') {
    try { await Promise.race([unlockP, new Promise((r) => setTimeout(r, 1000))]) } catch { /* 忽略 */ }
    if (seq !== playSeq) return
  }

  // 搜索结果只有元数据（秒出列表），点播这一下才向音源要链接。
  if (needResolve) {
    // 取链这一下别浪费：把队列后续几首的直链一起预取，下一首切歌时零等待。
    // 当前曲排除掉，避免和本次取链重复打同一个 /api/url。
    try {
      // iOS 只预取下一首：并发 6 首会和「当前这首」抢带宽，正是「点了半天不出声」的帮凶
      const aheadN = IS_IOS ? 2 : 6
      const ahead = S.queue.filter((x) => x?.key && x.key !== t.key).slice(0, aheadN)
      if (ahead.length) S.core?.sources?.prefetchTracks?.(ahead, { limit: aheadN, priorityKey: ahead[0].key })
    } catch { /* 忽略 */ }
    const status = $('#searchStatus')
    if (status) status.textContent = `正在解析「${t.title}」…`
    let settled = false
    const resolvePromise = (resolveViaSearch
      // force=true：用户主动点的那一下不受「失败冷却」限制，必须真的去取一次链
      ? S.core.sources.resolveRetry(t, []).catch(() => null)
      // force 只在「已知缓存链过期」时用：以前这里恒为 true，每次点歌都绕开服务端缓存
      // 重新取一遍链（波点+GD 双路各 1~2 秒），这是切歌/点歌明显变慢的主因。
      : S.core.sources.resolvePending(t, 0, !!staleStreams).catch(() => null))
      .finally(() => { settled = true })
    let resolved = null
    try {
      resolved = await Promise.race([resolvePromise, new Promise((r) => setTimeout(() => r(null), RESOLVE_TIMEOUT_MS))])
    } catch { resolved = null }
    if (seq !== playSeq) return                 // 期间点了别的歌：放弃这次，别覆盖新请求
    // 关键：超时 ≠ 取不到。很多歌只是「波点/酷我回源慢」（十几秒），
    // 以前 20 秒一到就判失败、自动跳下一首，于是用户看到连跳十几首。
    // 现在超时后继续等同一个请求（最多再等 45 秒），真的返回空才算失败。
    if (!resolved?.streams?.length && !settled) {
      if (status) status.textContent = `音源响应较慢，正在继续获取「${t.title}」…`
      resolved = await Promise.race([resolvePromise, new Promise((r) => setTimeout(() => r(null), RESOLVE_SLOW_WAIT_MS))])
      if (seq !== playSeq) return
    }
    if (status) status.textContent = ''
    if (!resolved?.streams?.length) { failAndNext(t, '暂时取不到播放链接'); return }
    t = resolved
    // 试听片段 / HTTP 直链等无法播放的情况：一律只提示「暂时无法播放」
    if (t.trial) toast(PLAY_FAIL, true)
    // 线上是 https：网易云返回的 http 直链会被当混合内容拦掉，先自动升级成 https 再播
    if (location.protocol === 'https:' && String(t.streams[0].url).startsWith('http:')) {
      t = { ...t, streams: t.streams.map((st) => ({ ...st, url: String(st.url).split('http://').join('https://') })) }
      S.current = t
    }
    // 用解析结果替换同 key 曲目，避免重复解析
    S.current = t
    S.searchResults = S.searchResults.map((x) => (x.key === t.key ? t : x))
    // key 为空时绝不能做「同 key 替换」，否则整条队列会被替换成当前这一首
    if (t.key) S.queue = S.queue.map((x) => (x.key === t.key ? t : x))
    if (S.page?.tracks) S.page.tracks = S.page.tracks.map((x) => (x.key === t.key ? t : x))
    updatePlayerBar()
    native.setMetadata(t).catch(() => {})
  }
  // 播放 + 换源重试：一条链接失败（死链 / 403 / 超时）不要立刻跳下一首 ——
  // 先按「歌名 + 歌手」到别的平台换源重试（最多 2 次），全都不行才跳过。
  let stream = null
  let lastErr = null
  const triedSources = []
  for (let attempt = 0; attempt < 2 && !stream; attempt++) {
    let cur = t
    if (attempt > 0) {
      const alt = await S.core.sources.resolveRetry(t, triedSources).catch(() => null)
      if (!alt?.streams?.length) break
      triedSources.push(alt.source)
      applyStreams(t.key, alt.streams, alt.pending)
      cur = alt
    }
    if (seq !== playSeq) return   // 已被新的点播取代：绝不能在换源阶段把「上一首」放出来
    try {
      stream = await S.core.quality.playWithFallback(cur, pos, S.quality, () => seq !== playSeq)
    } catch (e) {
      // 期间又切了歌：本次作废，静默返回（不报错、不跳歌、不放上一首）
      if (String(e?.message || e) === '__superseded__') return
      lastErr = e
      // 兜底判定：链路报错/超时，但音频其实已经在出声（上一首的残响或本条已起播），
      // 此时若继续换源就会「界面切到下一首、耳朵还在上一首」。直接认这条为成功。
      const el = $('#previewAudio')
      const curSrc = String(el?.currentSrc || el?.src || '')
      const wantSrc = String(cur?.streams?.[0]?.url || '')
      const sameFile = (a, b) => {
        try { return new URL(a).pathname === new URL(b).pathname } catch { return false }
      }
      // 必须确认「正在播的就是这一条链接」，否则会把上一首的残响当成成功
      if (el && !el.paused && !el.ended && el.readyState >= 2 && wantSrc && sameFile(curSrc, wantSrc)) {
        stream = { url: curSrc, quality: S.qualityNow || 'standard' }
        break
      }
      triedSources.push(cur.source || cur.pending?.source)
      // 这条链放不出来：立刻作废直链缓存，下一轮必须重新取链，
      // 否则会一直拿同一条过期签名地址重试（听感就是「在播但没声音」）。
      try { S.core?.sources?.forgetStreams?.(t.key) } catch { /* 老核心没有这个导出 */ }
    }
  }
  if (seq !== playSeq) return                   // 播放期间又点了下一首：这次作废
  if (!stream) {
    // 手动点播失败就停在当前曲：iOS Safari 的播放授权失败尤其不能当死链自动跳歌。
    if (!opts.auto) noAutoSkipUntil = Date.now() + 4000
    // 启动「自动续播」用的 noSkip：没有用户手势时 iOS 可能拒绝播放授权，
    // 这时停在当前曲（不跳歌、不弹错），用户点一下播放即可继续。
    if (opts.noSkip) { endStaleGuard(); S.playing = false; updatePlayerBar(); return }
    failAndNext(t, lastErr?.message)
    return
  }
  // ★ 起播成功后把「带真实直链」的版本写回 S.current（并按本次成功的那条排到最前）。
  // 旧代码里 S.current 一直是点播时的元数据（streams 为空），暂停→继续播放走
  // playWithFallback(S.current, …) 时 orderStreams 返回空 → 直接报「暂时无法播放」，
  // 这就是「播到一半暂停后不能继续」的另一条确定路径。
  if (t.streams?.length) {
    const ordered = [stream, ...t.streams.filter((s) => s && s.url !== stream.url)]
    S.current = { ...t, streams: ordered }
    const qi = S.queue.findIndex((x) => x?.key === t.key)
    if (qi >= 0) S.queue[qi] = { ...S.queue[qi], streams: ordered }
  }
  S.playing = true
  endStaleGuard()   // 声音已经跟上界面，退出过渡态（进度条恢复正常走动）
  try { window.__omLastTrackAt = Date.now() } catch { /* ignore */ }
  skipGuard = 0
  autoSkipChain = 0
  audioErrRetry = 0
  // 每次起播都把落盘音量重新贴回音频元素：托盘/播放条调的音量不会在切歌后被打回 100
  applyVolumePref()
  // 起播后二次确认：有的宿主在「换源 / 并发点播」时会把 <audio> 置回暂停，
  // 界面却还在播（用户听到的就是「在播但没声音」）。这里在 0.5s / 2.5s 各补一次 play()。
  const verifyKey = t.key
  // 起播后音频元素若自己报错（签名过期 / CDN 403），立刻作废缓存并重取一次，
  // 而不是放着「显示播放中、其实没声音」不动。
  try {
    const el = $('#previewAudio')
    if (el) {
      const onErr = () => {
        try { S.core?.sources?.forgetStreams?.(verifyKey) } catch { /* ignore */ }
        if (audioErrRetry >= 2) return   // 同一首连续报错两次就停，避免死循环重播
        if (S.current?.key === verifyKey && S.playing) {
          audioErrRetry++
          toast('链接失效，正在重新获取', true)
          setTimeout(() => { playTrack(S.current, S.positionMs || 0).catch(() => {}) }, 300)
        }
      }
      el.addEventListener('error', onErr, { once: true })
    }
  } catch { /* ignore */ }
  const ensurePlaying = () => {
    const a = $('#previewAudio')
    if (!a || !S.playing || S.current?.key !== verifyKey) return
    if (a.paused && a.readyState >= 2) a.play().catch(() => { /* 链接失效交给下一首 */ })
  }
  setTimeout(ensurePlaying, 500)
  setTimeout(ensurePlaying, 2500)
  // iOS：从「列表 / 首页」点歌 → 起播成功后进入播放页（默认动线）。
  // 但要尊重用户在取链这几秒里的操作：若他本来就在播放页（点的是播放/上下曲），
  // 或已经切到别的页面 / 打开抽屉，就不要再把播放页强行顶上来 —— 旧逻辑会「抢界面」，
  // 表现为「第一首歌还在加载时点其他页面/切歌像没反应」。
  if (IS_IOS && !opts.auto && iosViewSig() === viewSigAtStart) {
    try { iosOpenPlayer() } catch { /* 忽略 */ }
  }

  S.qualityNow = stream?.quality || ''
  if (stream && S.quality !== 'auto' && stream.quality !== S.quality) {
    toast(`${QUALITY_ABBR[S.quality] || S.quality} 无可用源，已按音质优先级回退到 ${QUALITY_ABBR[stream.quality] || stream.quality}`)
  }
  updatePlayerBar()
  // 按原规定并行预取队列近 6 首的直链，且「下一首」排在最前优先完成。
  // 延后 1.2s 起跑，避开音频首包缓冲（否则并发取链会抢带宽造成偶发卡顿）。
  schedulePrefetchAhead()
  if (S.cloud) {
    S.core.rec.trackEvent('play', t.key, t.tags || []).catch(() => {})
    S.recent = [{ ...t, playedAt: Date.now(), addedAt: Date.now() }, ...S.recent.filter((x) => x.key !== t.key)].slice(0, 100)
    saveRecent().catch((e) => toast(e.message))
    // 试听列表：记录「这次播放来自哪张专辑 / 哪个歌单」（不含本地歌曲与自建歌单）。
    // 优先 S.queueFrom（点歌那一刻的列表，翻页不影响）；S.page 仅作兜底。
    const qid = String(S.queueFrom?.id || '')
    const ptSrc = S.page?.source
    const fromSelfBuilt = /^playlist:pl-/.test(qid) || qid.startsWith('pl-')
      || (ptSrc?.type === 'playlist' && S.playlists.some((p) => p.id === ptSrc.id && !p.fav))
    if (t.license !== 'user-owned' && !fromSelfBuilt) {
      const c = trialContainerFromQueue() || trialContainerOf(S.page)
      if (c) {
        c.key = `${c.kind}:${c.name}`
        c.at = Date.now()
        S.trialList.items = [c, ...S.trialList.items.filter((x) => x.key !== c.key)].slice(0, 100)
        if (S.cloud) saveTrial().catch(() => {})
        try { localStorage.setItem('orangemusic:trialList', JSON.stringify({ items: S.trialList.items })) } catch { /* 隐私模式 */ }
        // 侧栏「试听列表·N」角标实时跟随（之前只在导航/渲染时刷新，播放后数字滞后）
        if (typeof renderNav === 'function') renderNav()
      }
    }
    scheduleRecommendRefresh()
  }
}

// 队列预取：把队列里紧跟当前曲的近 6 首直链提前取好写进缓存，切歌时 resolvePending
// 直接命中缓存（毫秒级），不再每首都现等 2~5 秒取链。
//  · 起播 1.2s 后并行预取近 6 首（并发 3），下一首永远占第一个槽、优先完成；
//  · 播放过半（55%）再补漏一次（上一轮有冷却 / 失败的曲目这时可重试）；
//  · 临近结尾（85%）把缓存直链直接挂到队列曲目上，playTrack 看到 streams 非空
//    就完全跳过「搜索 → 多平台取链」，点下一首即播。
const prefState = { key: '', warm: false, ready: false }
let aheadPrefTimer = 0
function nextAhead() {
  const i = S.queue.findIndex((x) => x?.key === S.current?.key)
  return i < 0 ? [] : S.queue.slice(i + 1, i + (IS_IOS ? 3 : 7))   // iOS 近 2~3 首，桌面端近 6 首
}
function schedulePrefetchAhead() {
  clearTimeout(aheadPrefTimer)
  aheadPrefTimer = setTimeout(() => {
    const ahead = nextAhead()
    if (!ahead.length || !S.core?.sources) return
    try { S.core.sources.prefetchTracks(ahead, { limit: 6, priorityKey: ahead[0].key }) } catch { /* 预取失败不影响播放 */ }
  }, 1200)
}
function maybePrefetchNext(pos, dur) {
  if (!S.playing || !dur || dur < 20000 || !S.core?.sources) return
  const key = S.current?.key || ''
  if (key !== prefState.key) { prefState.key = key; prefState.warm = false; prefState.ready = false }
  const ahead = nextAhead()
  if (!ahead.length) return
  const ratio = pos / dur
  if (ratio >= 0.55 && !prefState.warm) {
    prefState.warm = true
    // 补漏：起播那轮若有冷却 / 超时，这里再排一次；下一首仍优先
    try { S.core.sources.prefetchTracks(ahead, { limit: 6, priorityKey: ahead[0].key }) } catch { /* 预取失败不影响播放 */ }
    // 歌词也预取：下一首的歌词提前取好写进本地缓存，切歌时秒出，
    // 不再出现「歌已经响了、歌词还在匹配」的延迟。
    try {
      const nx = ahead[0]
      if (nx?.title && S.core?.lyrics?.getLyrics) S.core.lyrics.getLyrics(nx).catch(() => {})
    } catch { /* 无歌词核心 */ }
  }
  // 预取可能比 55%→85% 这段还慢：没挂上就每次进度刷新再试，直到成功为止（纯内存查询）
  if (ratio >= 0.85 && !prefState.ready) {
    try { prefState.ready = !!S.core.sources.applyPrefetched?.(ahead[0]) } catch { /* noop */ }
  }
}

// 整列表播放：整张列表替换队列，从指定位置开始。
// 说明：以前是「并入现有队列」，导致点一张新歌单后队列里混着上一张歌单的歌，
// 下一首会串到别的歌单去；现在统一走 playFrom（换歌单即重建队列）。
function playList(tracks, start = 0, label = '', meta = null) {
  const list = filterOfficial(tracks || []).filter((t) => t?.key)
  if (!list.length) return toast('列表为空')
  const from = meta || { id: label ? `label:${label}` : '', name: label }
  const at = Math.max(0, Math.min(Number(start) || 0, list.length - 1))
  return playFrom(list, list[at].key, from)
}

let recTimer
function scheduleRecommendRefresh() {
  clearTimeout(recTimer)
  recTimer = setTimeout(async () => {
    try { S.recommend = await S.core.rec.refreshRecommend(); if (S.section === 'home' && !S.page) await render() } catch { /* 保留上一份推荐 */ }
  }, 3000)
}

// 进度条：原生宿主只回位置事件，浏览器靠 <audio> timeupdate；
// 这里统一渲染「当前时间 + 拖动位置」，不再出现播放中仍停在 00:00 的情况。
function renderProgress() {
  const a = $('#previewAudio')
  // 过渡态（音频里还是上一首）→ 进度按 0 显示，绝不把旧歌的时间算到新歌头上
  const stale = audioIsStale()
  const dur = S.current?.durationMs || (!stale && a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
  // 歌词/进度都对「媒体元素当前时间」负责：S.positionMs 只在事件里刷新（≈4Hz），
  // 直接用 currentTime 可以消掉最多 250ms 的滞后，词曲才不会差半句。
  const live = !stale && a && S.playing && !a.paused && isFinite(a.currentTime) && a.currentTime > 0 ? a.currentTime * 1000 : 0
  const pos = stale ? 0 : Math.max(0, Math.min(live || S.positionMs || 0, dur || Number.MAX_SAFE_INTEGER))
  const cur = $('#curTime')
  if (cur) cur.textContent = mmss(pos)
  const npCur = $('#npCurTime')
  if (npCur) npCur.textContent = mmss(pos)
  const total = $('#totalTime')
  if (total) total.textContent = mmss(dur)
  const npTotal = $('#npTotalTime')
  if (npTotal) npTotal.textContent = mmss(dur)
  const seek = $('#seek')
  const npSeek = $('#npSeek')
  const pct = dur ? Math.min(1000, (pos / dur) * 1000) : 0
  if (seek && !SEEKING && document.activeElement !== seek) seek.value = String(Math.round(pct))
  if (npSeek) {
    if (!SEEKING && document.activeElement !== npSeek) npSeek.value = String(Math.round(pct))
    const p = SEEKING ? Number(npSeek.value) / 10 : pct / 10
    npSeek.style.setProperty('--p', `${p.toFixed(2)}%`)
  }
  const player = $('#player')
  if (player) player.style.setProperty('--np', `${(pct / 10).toFixed(2)}%`)
  // 精简模式封面外圈的环形进度（r=57 → 周长 358.1）
  const ring = $('#miniRing')
  if (ring) ring.style.strokeDashoffset = String((358.1 * (1 - Math.min(1, pct / 1000))).toFixed(1))
  if (IS_IOS) { try { iosPaintDockRing() } catch { /* 抽屉未挂载时忽略 */ } }
  highlightLyric(pos)
  if (IS_IOS) { try { syncLockScreenLyric(pos) } catch { /* 锁屏歌词不可用 */ } }
  if (IS_IOS) { try { iosPaintLyricSung(pos) } catch { /* 歌词未就绪 */ } }
  if (IS_IOS) { try { iosSyncLyricsPage(pos) } catch { /* 未打开歌词页 */ } }
  renderMiniLyric(pos)
  maybePrefetchNext(pos, dur)
}

function bindHomeHero() {
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('[data-hero]')
    if (!b) return
    const list = (S.recommend?.tracks?.length ? S.recommend.tracks : allChartTracks()).slice(0, 12)
    if (!list.length) return toast('推荐还没准备好，稍等一下再试')
    S.queue = capQ([...list])
    playTrack(b.dataset.hero === 'shuffle'
      ? list[Math.floor(Math.random() * list.length)]
      : list[0])
  })
}
function bindCogMenu() {
  // 左下角螺母：开合菜单；点其他区域自动收起
  document.addEventListener('click', (e) => {
    const cog = e.target?.closest?.('#sideCog')
    const menu = $('#cogMenu')
    if (!menu) return
    if (cog) { menu.hidden = !menu.hidden; return }
    if (!e.target.closest?.('#cogMenu')) menu.hidden = true
  })
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('[data-cog]')
    if (!b) return
    const menu = $('#cogMenu')
    if (menu) menu.hidden = true
    switch (b.dataset.cog) {
      case 'report': S.libTab = '总览'; goto('library'); break
      case 'update': runUpdateCheck(true); break
      case 'demo': playDemo(); break
      case 'cache': for (const k of ['covers', 'charts', 'rec']) clearData(k); break
      case 'import': $('#importSheet').hidden = false; break
      case 'source': openSourceSheet(); break
      case 'settings': goto('settings'); break
      case 'help': toast('帮助：使用说明见安装目录「使用说明.txt」；音源与更新说明见项目 README'); break
      case 'account': $('#loginSheet').hidden = false; break
      case 'exit':
        if (window.orangeWindow?.close) window.orangeWindow.close()
        else toast('网页版请直接关闭浏览器标签页')
        break
    }
  })
}
// ---- 歌词：切歌后异步补齐，逐行随时间高亮 ----
async function loadLyricsFor(t, retry = false) {
  if (!S.core?.lyrics || !t) return
  const key = t.key
  // forKey 记录「正在为哪一首加载」：切歌后旧结果过期时，靠它判断要不要为当前曲目重启，
  // 否则 loading 会永远挂着，页面一直显示「正在匹配歌词…」。
  S.lyrics = { key: '', forKey: key, lines: [], text: '', ok: false, loading: true }
  const box = $('#npLyrics')
  // 必须同时清掉 dataset.for：它记录「上一首歌已渲染过歌词 DOM」。
  // 旧版只删 dataset.on，清空 textContent 后 for 仍指向那首歌 → 再切回同一首时
  // renderLyrics 以为 DOM 还在，直接跳过重建，歌词区永远停在「正在匹配歌词…」。
  if (box) {
    box.textContent = '正在匹配歌词…'; box.dataset.state = 'loading'
    delete box.dataset.on; delete box.dataset.for
  }
  let out = { ok: false, lines: [], text: '' }
  let trans = []
  try {
    out = await S.core.lyrics.getLyrics(t, { force: retry }) } catch { /* 取不到就保留提示 */ }
  // iOS：翻译歌词单独取一次（服务端已缓存 24h，第二次几乎零成本）
  if (IS_IOS && out.ok) {
    try {
      const p = t.pending || {}
      const q = new URLSearchParams({ title: t.title || '', artist: t.artist || '', id: String(p.id || ''), source: String(p.platform || p.source || '') })
      const r = await fetch(`/api/lyric?${q.toString()}`, { signal: AbortSignal.timeout(9000) })
      const j = await r.json()
      if (j?.tlyric) trans = parseLrcServer(j.tlyric)
    } catch { /* 没有翻译就用纯歌词 */ }
  }
  if (S.current?.key !== key) { S.lyrics.forKey = ''; renderLyrics(); return }
  S.lyrics = { key, forKey: key, ...out, tlyric: trans, loading: false }
  renderLyrics()
  if (iosLyricsPageOpen) iosRenderLyricsPage()
}

// 极简 LRC 解析（只给翻译用，不需要和主解析器一样严格）
function parseLrcServer(raw = '') {
  const out = []
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/)
    if (!m) continue
    const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number((m[3] || '0').padEnd(3, '0'))
    const text = String(m[4] || '').trim()
    if (text) out.push({ time: ms, text })
  }
  return out
}

function renderLyrics() {
  const box = $('#npLyrics')
  if (!box) return
  const t = S.current
  if (!t) { box.textContent = '点一首歌开始听'; box.dataset.state = 'idle'; return }
  const L = S.lyrics
  if (L.key !== t.key) {
    box.textContent = L.loading ? '正在匹配歌词…' : '正在准备歌词…'
    box.dataset.state = L.loading ? 'loading' : 'miss'
    // 切歌瞬间旧 DOM 已作废，不能让下面的复用分支误判成「当前曲已渲染」
    delete box.dataset.for; delete box.dataset.on
    // 没在加载，或正在加载的是上一首歌 → 为当前曲目（重）启动
    if (!L.loading || L.forKey !== t.key) loadLyricsFor(t)
    return
  }
  if (L.loading) { box.textContent = '正在匹配歌词…'; box.dataset.state = 'loading'; return }
  if (!L.ok || !L.lines.length) {
    // 纯文本歌词（没有时间轴）：不编造假时间轴逐行跳，静态展示一句并提示可点开看全文
    const first = String(L.text || '').split('\n')[0].trim()
    box.textContent = first ? `${first} · 点击查看歌词` : '暂时没有找到同步歌词 · 点击重新匹配'
    box.dataset.state = 'miss'
    return
  }
  box.dataset.state = 'ok'
  // 同一首歌重复渲染（播放/暂停会走 updatePlayerBar）时不重建 DOM，避免滚动位置被重置。
  // 仅当标记一致且 DOM 里确实还有歌词行才复用：否则（DOM 被清空过）强制重建。
  if (box.dataset.for === t.key && box.querySelector('.lyric-line')) { highlightLyric(S.positionMs); return }
  box.dataset.for = t.key
  box.innerHTML = L.lines.map((l) => `<div class="lyric-line" data-t="${l.time}">${esc(l.text)}</div>`).join('')
  delete box.dataset.on
  highlightLyric(S.positionMs)
}

// 歌词按「与当前行的距离」做深浅渐变：近的深、远的浅，且带平滑过渡（#13 / #14）。
function applyLyricFade(nodes, idx) {
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.abs(i - idx)
    const op = d === 0 ? 1 : d === 1 ? 0.74 : d === 2 ? 0.54 : d === 3 ? 0.4 : d === 4 ? 0.3 : 0.2
    nodes[i].style.opacity = op
    nodes[i].classList.toggle('on', i === idx)
  }
}

function highlightLyric(pos = 0) {
  const box = $('#npLyrics')
  if (!box || S.lyrics.key !== S.current?.key || !S.lyrics.lines.length) return
  const nodes = box.querySelectorAll('.lyric-line')
  if (!nodes.length) return
  const lines = S.lyrics.lines
  let idx = 0
  for (let i = 0; i < lines.length; i++) {
    // 90ms 的前瞻只用于抵消渲染帧延迟；给多了会出现「人还没唱到，词先亮」。
    if (lines[i].time <= pos + 90) idx = i
    else break
  }
  if (box.dataset.on === String(idx)) return
  box.dataset.on = String(idx)
  applyLyricFade(nodes, idx)
  const on = nodes[idx]
  // 用 rect 相对滚动容器算偏移：.lyric-line 的 offsetTop 是相对 .np-lyric-col 的，
  // 直接拿去设 scrollTop 会多滚一个标题块的高度，高亮行被推出可视区（看起来就是词曲对不上）。
  if (on && !LYRIC_DRAG) {
    const br = box.getBoundingClientRect(), nr = on.getBoundingClientRect()
    const delta = (nr.top - br.top) - (box.clientHeight / 2 - nr.height / 2)
    box.scrollTop = Math.max(0, box.scrollTop + delta)
  }
}

// ---- 锁屏 / 控制中心歌词 ----
// 把「当前歌词行」写进 Media Session（经 bridge 的 native.setNowPlayingLyric）。
// 只在「歌曲 + 歌词行」变化时更新，避免每帧重设元数据导致锁屏闪烁；关闭时还原为专辑名。
let lockLyricKey = ''
function syncLockScreenLyric(pos = 0, force = false) {
  if (!IS_IOS) return
  if (S.settings && S.settings.lockLyric === false) {
    if (force || lockLyricKey !== '__off__') {
      lockLyricKey = '__off__'
      try { native.setNowPlayingLyric?.('') } catch { /* noop */ }
    }
    return
  }
  const t = S.current
  const L = S.lyrics
  let text = ''
  if (t && L && L.key === t.key && Array.isArray(L.lines) && L.lines.length) {
    let idx = 0
    for (let i = 0; i < L.lines.length; i++) {
      if (L.lines[i].time <= pos + 90) idx = i
      else break
    }
    text = String(L.lines[idx]?.text || '').trim()
  }
  const sig = `${t?.key || ''}|${text}`
  if (!force && sig === lockLyricKey) return
  lockLyricKey = sig
  try { native.setNowPlayingLyric?.(text) } catch { /* noop */ }
}

// ---- 歌词拖动：按住左键上下拖，显示时间线；松开跳到该时间 ----
let LYRIC_DRAG = null

function bindLyricDrag() {
  const box = $('#npLyrics')
  if (!box || box.dataset.dragBound) return
  box.dataset.dragBound = '1'
  const tip = $('#npSeekTip')
  const timeAt = (i) => (S.lyrics.lines[i] ? S.lyrics.lines[i].time : 0)
  const nearest = () => {
    const nodes = box.querySelectorAll('.lyric-line')
    if (!nodes.length) return -1
    const mid = box.getBoundingClientRect().top + box.clientHeight / 2
    let best = -1, bestD = Infinity
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect()
      const d = Math.abs(r.top + r.height / 2 - mid)
      if (d < bestD) { bestD = d; best = i }
    })
    return best
  }
  const showTip = (ms) => {
    if (!tip) return
    tip.hidden = false
    const t = tip.firstElementChild
    if (t) t.textContent = mmss(ms)
  }
  const hideTip = () => { if (tip) tip.hidden = true }

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !S.lyrics.lines.length) return
    LYRIC_DRAG = { y: e.clientY, top: box.scrollTop, moved: false }
    box.classList.add('dragging')
    try { box.setPointerCapture(e.pointerId) } catch { /* 老内核忽略 */ }
    showTip(timeAt(nearest()))
    e.preventDefault()
  })
  box.addEventListener('pointermove', (e) => {
    if (!LYRIC_DRAG) return
    const dy = e.clientY - LYRIC_DRAG.y
    if (Math.abs(dy) > 2) LYRIC_DRAG.moved = true
    box.scrollTop = Math.max(0, LYRIC_DRAG.top - dy)
    showTip(timeAt(nearest()))
  })
  const finish = () => {
    if (!LYRIC_DRAG) return
    const moved = LYRIC_DRAG.moved
    LYRIC_DRAG = null
    box.classList.remove('dragging')
    hideTip()
    if (!moved || !S.current) return
    const ms = timeAt(nearest())
    S.positionMs = ms
    renderProgress()
    native.seek(ms).catch(() => {})
    delete box.dataset.on
    highlightLyric(ms)
  }
  box.addEventListener('pointerup', finish)
  box.addEventListener('pointercancel', finish)
}

// SVG 不是 HTMLElement，el.hidden = true 只是挂了个 JS 属性，不会写 attribute，
// 所以 [hidden] 选择器永远不匹配 —— 必须显式 toggle class 才能真正切换图标。
function switchPlayIcon(btn, playing) {
  if (!btn) return
  const ip = btn.querySelector('.ico-play')
  const ipa = btn.querySelector('.ico-pause')
  if (!ip || !ipa) return
  ip.removeAttribute('hidden'); ipa.removeAttribute('hidden')
  ip.classList.toggle('is-off', !!playing)
  ipa.classList.toggle('is-off', !playing)
}

// 播放行高亮同步：只切换 class，不重建 DOM（避免滚动被重置）。
function syncPlayingRows() {
  const key = S.current?.key || ''
  // 榜单详情用的是 .orange-cp-row，以前漏了它 → 播榜单时一行都不高亮
  document.querySelectorAll('.orange-tr[data-key], .row[data-key], .orange-cp-row[data-key], .npq-row[data-key]').forEach((el) => {
    const on = !!key && el.dataset.key === key
    el.classList.toggle('playing', on)
    el.querySelector('.orange-tr-album')?.classList.toggle('on', on)
  })
}

// 托盘菜单状态：把当前曲目 / 播放态 / 音量推给主进程（菜单弹窗展示用）
function pushTrayState() {
  try {
    const qi = (S.queue || []).findIndex((x) => x.key === S.current?.key)
    window.orangeWindow?.trayState?.({
      title: S.current?.title || '',
      artist: S.current?.artist || '',
      playing: !!S.playing,
      liked: !!(S.current && S.favorites.some((x) => x.key === S.current.key)),
      volume: Math.round(($('#previewAudio')?.volume ?? 1) * 100),
      mode: S.mode,
      // 托盘队列窗只显示「即将播放」的 3 首，所以要带当前曲在队列里的位置
      index: qi,
      queue: (S.queue || []).slice(0, 100).map((t) => ({ title: t.title || '', artist: t.artist || '' })),
    })
  } catch { /* 无宿主 */ }
}

// 封面上的「展开到播放页」提示图标（四角括号，鼠标指向封面才出现）。
// 以前是把 span 写死在 index.html 里，结果 updatePlayerBar 一 innerHTML 覆盖就没了，
// 所以统一由 paintCover() 在每次重绘后补回来。
const EXPAND_ICO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13.6 4.4h6v6"/><path d="M10.4 19.6h-6v-6"/></svg>'

function paintCover(el, t) {
  if (!el) return
  el.innerHTML = coverHtml(t)
  const ex = document.createElement('span')
  ex.className = 'cover-expand'
  ex.title = '打开播放页'
  ex.setAttribute('aria-label', '打开播放页')
  ex.innerHTML = EXPAND_ICO
  el.appendChild(ex)
  paintDynamics(el)
}

function updatePlayerBar() {
  const t = S.current
  $('#barTitle').textContent = t?.title || '未在播放'
  $('#barArtist').textContent = t?.artist || '从授权音源中选一首歌'
  const npBT = $('#npBarTitle')
  if (npBT) npBT.textContent = t?.title || '未在播放'
  const npBA = $('#npBarArtist')
  if (npBA) npBA.textContent = t?.artist || '从授权音源中选一首歌'
  syncQualityLabels()
  paintCover($('#barCover'), t)
  const playing = !!S.playing
  for (const id of ['#playBtn', '#npPlayBtn']) switchPlayIcon($(id), playing)
  $('#nowPlaying')?.classList.toggle('playing', playing)
  syncPlayingRows()
  pushTrayState()
  renderProgress()
  $('#npTitle').textContent = t?.title || '未在播放'
  $('#npArtist').textContent = t?.artist || ''
  // 唱盘：封面圆 + 外圈「黑胶环」= 同一张封面的暗化模糊底（CSSOM 赋值，避开行内样式限制）
  const npCv = $('#npCover')
  if (npCv) {
    const cu = cachedCover(t)
    // 播放/暂停反复切换时不再重建封面 DOM：否则 <img> 每次重新解码 → 封面闪一下，
    // 用户反馈「歌播不了时再按开始/暂停，封面会抖」。只有曲目或封面变了才重绘。
    const sig = `${String(t?.key || '')}|${String(cu || '')}`
    if (npCv.dataset.coverSig !== sig) {
      npCv.innerHTML = npCoverHtml(t)
      npCv.dataset.coverSig = sig
      npCv.style.backgroundImage = cu ? `url("${String(cu).replace(/"/g, '%22')}")` : ''
      paintDynamics(npCv)
    }
  }
  renderLyrics()
  // iOS：把播放页的标题 / 标签 / 操作行与底部 dock 一起刷新（Windows 不进入此分支）
  if (IS_IOS) {
    try { iosSyncNp() } catch { /* 播放页元素还没挂上时忽略 */ }
    try { iosRenderNav() } catch { /* 同上 */ }
    if (iosSheetOpen()) { try { iosSheetRender() } catch { /* 同上 */ } }
  }
  const tiers = t?.streams?.length
    ? [...new Set(t.streams.map((s) => s.quality))].sort((a, b) => (QUALITY_ABBR[a] ? 4 : 0) - (QUALITY_ABBR[b] ? 4 : 0)).map((q) => QUALITY_ABBR[q] || q)
    : []
  // 播放页不再展示音质 / 授权标签与音源入口（音质仍可在底部播放条切换）。
  // QQ 音乐式模糊封面底：用 CSSOM 赋值，避开 style-src 'self' 的行内样式限制。
  const npBg = $('#npBg')
  if (npBg) {
    const u = cachedCover(t)
    npBg.style.backgroundImage = u ? `url('${String(u).replace(/'/g, '%27')}')` : ''
  }
  const sel = $('#qualitySel')
  if (sel) { sel.value = S.quality; sel.title = tiers.length ? `本曲可用音质：${tiers.join(' / ')}` : '音质偏好（自动 = 本曲最高可用）' }
  const liked = t && S.favorites.some((x) => x.key === t.key)
  const lb = $('#likeBtn')
  if (lb) lb.textContent = liked ? '♥ 已喜欢' : '♡ 喜欢'
  for (const id of ['#barLikeBtn', '#npLikeBtn']) {
    const b = $(id)
    if (b) b.classList.toggle('on', !!liked)
  }
  renderNpQueue()
  updateMini()
}

// ---- 音质：按当前实际音质显示，点击切换 ----
function qualityLabel() {
  const q = S.qualityNow || (S.quality === 'auto' ? '' : S.quality)
  return QUALITY_ABBR[q] || '自动'
}

function syncQualityLabels() {
  const txt = qualityLabel()
  for (const id of ['#npQualityBtn', '#qualityBtn']) {
    const b = $(id)
    if (b) b.textContent = txt
  }
  $('#qualityMenu')?.querySelectorAll('.qm-item').forEach((b) => b.classList.toggle('on', b.dataset.q === S.quality))
}

function openQualityMenu(anchor) {
  const m = $('#qualityMenu')
  if (!m || !anchor) return
  closeModeMenu()
  syncQualityLabels()
  m.hidden = false
  const r = anchor.getBoundingClientRect()
  const w = m.offsetWidth || 152
  const h = m.offsetHeight || 168
  const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
  const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8
  m.style.setProperty('left', `${Math.round(left)}px`)
  m.style.setProperty('top', `${Math.round(top)}px`)
}

const closeQualityMenu = () => { const m = $('#qualityMenu'); if (m) m.hidden = true }

// ---- 播放队列面板（右侧滑出）----
const NPQ_HEART = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.4s-7.6-4.7-7.6-10.2A4.25 4.25 0 0 1 12 7.8a4.25 4.25 0 0 1 7.6 2.4c0 5.5-7.6 10.2-7.6 10.2z"/></svg>'
const NPQ_LINK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 14.5 14.5 9.5"/><path d="M12.6 6.6l1.4-1.4a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4"/><path d="M11.4 17.4 10 18.8a3.6 3.6 0 0 1-5.1-5.1L6.3 12.3"/></svg>'
const NPQ_MORE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.2"/><circle cx="8.9" cy="12" r=".85" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r=".85" fill="currentColor" stroke="none"/><circle cx="15.1" cy="12" r=".85" fill="currentColor" stroke="none"/></svg>'

function renderNpQueue() {
  const list = $('#npqList')
  if (!list) return
  const q = S.queue || []
  const sub = $('#npqSub')
  if (sub) sub.textContent = `共 ${q.length} 首歌曲`
  if (!q.length) { list.innerHTML = '<div class="npq-empty">队列还没有歌曲</div>'; return }
  const picked = S.npqPick || new Set()
  list.innerHTML = q.map((t) => {
    const on = t.key === S.current?.key
    const liked = S.favorites.some((x) => x.key === t.key)
    return `<div class="npq-row${on ? ' on' : ''}${picked.has(t.key) ? ' picked' : ''}" data-key="${esc(t.key)}">
      <div class="npq-cv">${coverHtml(t)}</div>
      <div class="npq-main">
        <div class="npq-title">
          <span class="t">${esc(t.title)}</span>
          <button class="npq-play" data-play="${esc(t.key)}" title="播放">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>
          </button>
        </div>
        <div class="npq-artist">${esc(t.artist || '')}</div>
      </div>
      <div class="npq-tools-row">
        <button class="npq-like${liked ? ' on' : ''}" data-nplike="${esc(t.key)}" title="喜欢">${NPQ_HEART}</button>
        <button data-npmore="${esc(t.key)}" title="更多">${NPQ_MORE}</button>
      </div>
    </div>`
  }).join('')
  paintDynamics(list)
  const cur = list.querySelector('.npq-row.on')
  if (cur) list.scrollTop = Math.max(0, cur.offsetTop - 6)
}

function setNpQueueOpen(open) {
  const p = $('#npQueuePanel')
  if (!p) return
  // 面板挂在 body 上；播放页打开时挪进播放页，才能压在播放页之上又不遮住窗口按钮
  if (open) {
    const host = $('#nowPlaying')?.hidden === false ? $('#nowPlaying') : document.body
    if (p.parentElement !== host) host.appendChild(p)
  }
  p.hidden = !open
  for (const id of ['#npListBtn', '#barList']) {
    const b = $(id)
    b?.setAttribute('aria-expanded', open ? 'true' : 'false')
    b?.classList.toggle('on', open)
  }
  if (open) renderNpQueue()
}

const isQueueOpen = () => $('#npQueuePanel')?.hidden === false

function bindNpQueue() {
  const panel = $('#npQueuePanel')
  if (!panel || panel.dataset.bound) return
  panel.dataset.bound = '1'

  const trackOf = (key) => (S.queue || []).find((t) => t.key === key)

  panel.addEventListener('click', async (e) => {
    const like = e.target.closest('[data-nplike]')
    if (like) {
      const t = trackOf(like.dataset.nplike)
      if (t) { await toggleLike(); renderNpQueue() }
      return
    }
    const more = e.target.closest('[data-npmore]')
    if (more) {
      const t = trackOf(more.dataset.npmore)
      const liked = S.favorites.some((x) => x.key === t.key)
      openCtxMenu(more, [
        { label: '播放', onClick: () => t && playTrack(t) },
        { label: '下一首播放', onClick: () => { if (t) { S.queue = capQ([S.current, ...S.queue.filter((x) => x.key !== t.key), t]); renderNpQueue(); toast('已设为下一首') } } },
        { label: '播放相似单曲', onClick: () => toast('已加入相似播放') },
        { label: '播放MV', onClick: () => toast('MV 暂未提供') },
        { sep: true },
        { label: '我喜欢', danger: liked, onClick: () => toggleLikeKey(t.key) },
        { label: '添加到', arrow: true, onClick: () => openPickSheet([t.key]) },
        { label: '移动到', arrow: true, onClick: () => toast('移动到：暂以「添加到」代替') },
        { label: '单曲购买', onClick: () => toast('本应用不内置付费曲库') },
        { label: '分享', onClick: () => copyTrackShare(t) },
        { label: '查看评论', onClick: () => toast('评论需登录云账号') },
        { label: '曲谱', onClick: () => toast('曲谱暂未提供') },
        { sep: true },
        { label: '删除', danger: true, onClick: () => { S.queue = S.queue.filter((x) => x.key !== t.key); renderNpQueue(); toast('已从队列移除') } },
        { label: '复制歌曲信息', onClick: () => copyTrackInfo(t) },
      ])
      return
    }
    const play = e.target.closest('[data-play]')
    if (play) {
      const t = trackOf(play.dataset.play)
      if (t) { await playTrack(t); renderNpQueue() }
      return
    }
    const row = e.target.closest('.npq-row')
    if (row) {
      const key = row.dataset.key
      if ($('#npqList')?.classList.contains('multi')) {
        if (S.npqPick.has(key)) S.npqPick.delete(key); else S.npqPick.add(key)
        row.classList.toggle('picked', S.npqPick.has(key))
        return
      }
      const t = trackOf(key)
      if (t) { await playTrack(t); renderNpQueue() }
    }
  })

  const clearBtn = $('#npqClearBtn')
  if (clearBtn) clearBtn.onclick = () => {
    if (!S.queue.length) return
    const list = $('#npqList')
    if (S.npqPick?.size && list?.classList.contains('multi')) {
      const n = S.npqPick.size
      S.queue = S.queue.filter((t) => !S.npqPick.has(t.key))
      S.npqPick.clear()
      renderNpQueue()
      toast(`已从队列移除 ${n} 首`)
      return
    }
    S.queue = S.current ? [S.current] : []
    renderNpQueue()
    toast('已清空播放队列')
  }

  // 点面板外任意位置（以及顶部/底部的队列按钮）关闭
  document.addEventListener('click', (e) => {
    if (!isQueueOpen()) return
    if (e.target.closest?.('#npQueuePanel, #npListBtn, #barList, #miniList')) return
    setNpQueueOpen(false)
  })

  const multiBtn = $('#npqMultiBtn')
  const selectAllBtn = $('#npqSelectAll')
  if (selectAllBtn) selectAllBtn.onclick = () => {
    const list = $('#npqList')
    if (!list || !list.classList.contains('multi')) return
    const q = S.queue || []
    if (S.npqPick.size >= q.length) {
      S.npqPick.clear()
    } else {
      q.forEach((t) => S.npqPick.add(t.key))
    }
    list.querySelectorAll('.npq-row').forEach((r) => r.classList.toggle('picked', S.npqPick.has(r.dataset.key)))
  }
  if (multiBtn) multiBtn.onclick = () => {
    const list = $('#npqList')
    if (!list) return
    list.classList.toggle('multi')
    const on = list.classList.contains('multi')
    multiBtn.classList.toggle('on', on)
    if (selectAllBtn) selectAllBtn.hidden = !on
    if (!on) { S.npqPick.clear(); list.querySelectorAll('.npq-row.picked').forEach((r) => r.classList.remove('picked')) }
  }
}

function bindQualityMenu() {
  const m = $('#qualityMenu')
  if (!m || m.dataset.bound) return
  m.dataset.bound = '1'
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-q]')
    if (!b) return
    closeQualityMenu()
    await changeQuality(b.dataset.q)
    syncQualityLabels()
  })
  document.addEventListener('click', (e) => {
    if (m.hidden) return
    if (e.target.closest('#qualityMenu, #npQualityBtn, #qualityBtn')) return
    closeQualityMenu()
  })
}

function startPositionSync() {
  const a = $('#previewAudio')
  a.ontimeupdate = () => {
    if (!S.playing) return
    // 过渡态里这条时间是上一首的，不能写进当前曲的进度
    if (audioIsStale()) return
    S.positionMs = a.currentTime * 1000
    renderProgress()
  }
  on('player.position', (p) => {
    if (audioIsStale()) return
    if (p && Number.isFinite(p.positionMs)) S.positionMs = p.positionMs
    if (S.playing) renderProgress()
  })
  on('player.ended', () => {
    // 起播即失败（死链 / 音频报错）时进度几乎为 0，不能按「播完」处理，
    // 否则点一下播放/暂停就被自动切到下一首（用户明确不接受）。
    if (Date.now() < noAutoSkipUntil || S.positionMs < 800) { S.playing = false; updatePlayerBar(); return }
    next(1, { auto: true })
  })
  on('media.next', () => next(1))
  on('media.prev', () => next(-1))
  on('media.play', () => { if (!S.playing) $('#playBtn').click() })
  on('media.pause', () => { if (S.playing) $('#playBtn').click() })
  // 兜底：个别宿主不回 position 事件时才用真实进度补一次（position 事件本身约 4Hz，
  // 这里降到 1s，减少播放期主线程负担；maybePrefetchNext 仍会被两条路径及时触发）。
  // 窗口不可见（最小化 / 托盘）时直接跳过：进度没人看，省掉每秒一次的全量 DOM 更新。
  setInterval(() => {
    if (!S.playing || document.hidden) return
    const el = $('#previewAudio')
    if (el && !el.paused && el.currentTime > 0 && !audioIsStale()) S.positionMs = el.currentTime * 1000
    renderProgress()
  }, 1000)
  // 「界面显示在播、实际没声音」自愈：起播瞬间被打断、音频元素被重置、
  // 或系统音频会话被抢占时，<audio> 会停在 paused 但 S.playing 仍为 true。
  // 这里低频检查真实状态，发现异常就把它拉回来（4 秒内最多一次，避免死循环）。
  let lastSoundFixAt = 0
  let stalledSince = 0
  let reResolving = false
  // 卡在「已请求但一字节都没下来」（签名直链过期 / CDN 拒绝）时，重新取一次链再播。
  const reResolveCurrent = async () => {
    if (reResolving || !S.current) return
    reResolving = true
    try {
      const fresh = await S.core.sources.resolveRetry({ ...S.current, streams: [] }, [])
      if (fresh?.streams?.length) {
        S.current = fresh
        S.queue = S.queue.map((x) => (x.key === fresh.key ? fresh : x))
        await S.core.quality.playWithFallback(fresh, 0, S.quality)
      }
    } catch { /* 换源也失败：保持现状，等用户点下一首 */ } finally { reResolving = false }
  }
  setInterval(() => {
    if (!S.playing || document.hidden) return
    // 过渡态里 <audio> 挂的是上一首：绝不能把它「自愈」成继续播上一首
    if (audioIsStale()) return
    const a = $('#previewAudio')
    if (!a || !a.src || a.ended) return
    // 元数据就绪后可播而实际暂停 → 直接拉回播放
    if (!a.paused) {
      // 有声音但被静音 / 音量为 0（多半是历史设置或误触），按落盘音量纠正一次
      // 旧版用 prefVolume() > 0 当门槛，而默认值被算成 0 → 条件永远不成立，静音再也解不掉。
      // 现在只排除「用户主动点的静音」，其余一律纠正。
      if (!window.__omUserMuted && (a.muted || a.volume === 0)) applyVolumePref()
      stalledSince = 0
      return
    }
    if (a.readyState >= 2) {
      stalledSince = 0
      if (Date.now() - lastSoundFixAt < 3000) return
      lastSoundFixAt = Date.now()
      applyVolumePref()
      a.play().catch(() => { /* 仍失败：交给下一次巡检 / 换源 */ })
      return
    }
    // readyState 0：一直没拿到数据，累计 8 秒就重新取链
    if (!stalledSince) stalledSince = Date.now()
    if (Date.now() - stalledSince > 8000) { stalledSince = 0; reResolveCurrent() }
  }, 2000)
  setInterval(async () => {
    if (!S.cloud || !S.current) return
    try {
      // 续听队列按原规定保留前 100 首（不再砍到 30 首）；写入周期 15s 避免周期性顿卡。
      await S.core.repo.setState(S.core.repo.keys.playback, {
        track: S.current, positionMs: S.positionMs,
        queue: S.queue.slice(0, 100), device: S.device,
      })
    } catch { /* 网络抖动下次 tick 重试 */ }
  }, 15000)
  // 退出前立即落盘：iOS PWA 被关掉时 15s 定时器常还没跑到，导致「下次进来没回到上次那首」。
  const savePlaybackNow = () => {
    try {
      if (!S.current || !S.core?.repo?.setState) return
      S.core.repo.setState(S.core.repo.keys.playback, {
        track: S.current, positionMs: S.positionMs,
        queue: S.queue.slice(0, 100), device: S.device,
      }).catch(() => {})
    } catch { /* ignore */ }
  }
  try { window.addEventListener('pagehide', savePlaybackNow) } catch { /* ignore */ }
  try {
    document.addEventListener('visibilitychange', () => { if (document.hidden) savePlaybackNow() })
  } catch { /* ignore */ }
}

// ---- 音质 ----
function applyQualityPref(q, { silent = false } = {}) {
  S.quality = q
  try { localStorage.setItem(QUALITY_PREF_KEY, q) } catch { /* 隐私模式 */ }
  S.core?.quality.setPreferred(q)
  if (!silent) toast(`音质偏好：${q === 'auto' ? '自动' : QUALITY_ABBR[q]}`)
}

async function changeQuality(q) {
  applyQualityPref(q)
  if (!S.current) return updatePlayerBar()
  const pos = S.positionMs
  let next = S.current
  // 取链层的档位顺序跟着偏好走：切档后必须重新向音源要一次链接，
  // 否则只是把旧链接换个顺序播，选「无损」也拿不到无损流。
  if (S.current.pending && S.core) {
    toast('正在按新音质重新取链…')
    try {
      const r = await S.core.sources.resolvePending(S.current, 0, true)
      if (r?.streams?.length) {
        next = r
        S.searchResults = S.searchResults.map((x) => (x.key === next.key ? next : x))
        S.queue = S.queue.map((x) => (x.key === next.key ? next : x))
      }
    } catch { /* 取不到就沿用已有候选流，按新优先级播放 */ }
  }
  if (S.playing) await playTrack(next, pos)
  else updatePlayerBar()
}

// ---- 外观模式：浅色 / 深色 / 跟随系统 ----
const SCHEME_KEY = 'orangemusic:scheme'
const SCHEME_MODES = [
  { id: 'light', label: '浅色', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/>' },
  { id: 'dark', label: '深色', icon: '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/>' },
  { id: 'system', label: '跟随系统', icon: '<rect x="3.2" y="4.4" width="17.6" height="12" rx="2"/><path d="M8.6 19.6h6.8"/>' },
]
let schemeMode = 'light'
try { schemeMode = localStorage.getItem(SCHEME_KEY) || 'light' } catch { /* 隐私模式 */ }
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
function applyScheme(mode = schemeMode) {
  schemeMode = SCHEME_MODES.some((x) => x.id === mode) ? mode : 'light'
  try { localStorage.setItem(SCHEME_KEY, schemeMode) } catch { /* 隐私模式 */ }
  const dark = schemeMode === 'dark' || (schemeMode === 'system' && !!darkQuery?.matches)
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light'
  window.orangeWindow?.setTheme?.(schemeMode)
}
if (darkQuery?.addEventListener) darkQuery.addEventListener('change', () => { if (schemeMode === 'system') applyScheme('system') })

function openThemeMenu(anchor) {
  $('#themeMenu')?.remove()
  const m = document.createElement('div')
  m.className = 'theme-menu'
  m.id = 'themeMenu'
  m.innerHTML = SCHEME_MODES.map((x) => `<button class="theme-item${x.id === schemeMode ? ' on' : ''}" data-scheme-mode="${x.id}">
    <span class="ti-ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${x.icon}</svg></span>${x.label}</button>`).join('')
  document.body.appendChild(m)
  const r = anchor.getBoundingClientRect()
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left))}px`
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 8)}px`
  m.querySelectorAll('[data-scheme-mode]').forEach((b) => (b.onclick = () => {
    applyScheme(b.dataset.schemeMode)
    m.remove()
    toast(`外观：${SCHEME_MODES.find((x) => x.id === b.dataset.schemeMode)?.label || ''}`)
  }))
  setTimeout(() => document.addEventListener('click', (e) => { if (!e.target.closest('#themeMenu, .orange-tool, .icon-btn, #npDressBtn')) m.remove() }, { once: true }), 0)
}

// ---- 左侧导航栏：缩略模式（只留图标，右侧内容区 / 播放条自适应）----
const NARROW_KEY = 'orangemusic:navnarrow'
try { S.sideNarrow = localStorage.getItem(NARROW_KEY) === '1' } catch { /* 隐私模式 */ }
function toggleSideNarrow() {
  S.sideNarrow = !S.sideNarrow
  try { localStorage.setItem(NARROW_KEY, S.sideNarrow ? '1' : '0') } catch { /* 隐私模式 */ }
  renderNav()
}

// ---- 精简模式（迷你播放器）----
// 进精简模式前必须把弹层全关掉：弹层挂在 <body> 上，不在 .window 里，
// 小窗化以后它们还留着 → 小窗里糊一大片白色卡片（就是「超长精简模式、回不去」的原因）。
function closeAllSheets() {
  document.querySelectorAll('.sheet').forEach((el) => { el.hidden = true })
  document.querySelectorAll('.ask-sheet').forEach((el) => el.remove())
  document.querySelectorAll('.ctx-menu, .orange-menu, .menu-pop').forEach((el) => el.remove())
  const q = $('#npQueuePanel'); if (q) q.hidden = true
  try { closeModeMenu(); closeQualityMenu() } catch { /* ignore */ }
}

let miniOn = false
let miniEnteredAt = 0
// 只做界面切换（不通知主进程）：主进程回推状态、以及窗口尺寸自愈时都复用这一层，
// 保证「样式」与「窗口」永远是一起变的，不会再出现「窗口缩成小窗但页面还是完整界面 → 一片空白」。
function applyMiniUi(want) {
  miniOn = !!want
  try { $('#window')?.classList.toggle('mini-mode', !!want) } catch { /* ignore */ }
  try { document.documentElement.dataset.mini = want ? '1' : '' } catch { /* ignore */ }
  try {
    if (want) { $('#nowPlaying').hidden = true; updateMini() }
    else { toggleMiniQueue(false, true); updateMini() }
  } catch { /* 小窗界面已经切过去，单点失败不影响 */ }
}
function setMiniMode(on) {
  const want = !!on
  // 以前这里有个 `want === miniOn 就 return`：主进程状态一旦和页面不同步
  //（比如精简模式里点了关闭→最小化到托盘，再唤回来），点「切换到精简模式」就彻底没反应。
  // 现在改成幂等执行：重复调用只是再应用一次样式 + 告知主进程，不会再动窗口位置。
  if (want) {
    miniEnteredAt = Date.now()
    // 进精简模式前的清理可以失败（弹层模块未就绪），但绝不能因此卡住下面的界面切换
    try { closeAllSheets() } catch { /* ignore */ }
    try { setNpQueueOpen(false) } catch { /* ignore */ }
    // 精简模式完全不显示黑框提示：清掉可能残留的一条
    const t = $('#toast'); if (t) t.hidden = true
    clearTimeout(toastTimer)
  }
  // 关键顺序：先把界面切到目标状态，再让主进程改窗口尺寸。
  // 反过来的话，窗口缩小的瞬间页面还是完整界面，透明小窗里什么都没有（用户看到的「面板整个不见了」）。
  applyMiniUi(want)
  try { window.orangeWindow?.setMini?.(want) } catch { /* 无宿主 */ }
}

// 主进程改完窗口尺寸 / 从托盘恢复时会回推真实状态：界面跟着对齐，避免两边不一致
try { window.orangeWindow?.onMiniState?.((on) => { if (!!on !== miniOn) applyMiniUi(!!on) }) } catch { /* 无宿主 */ }

// 自愈：精简模式下窗口被系统/用户放大（双击标题、Win+↑、任务栏还原、主进程状态不同步）
// 时，页面若还挂着 mini-mode 样式，就会只剩左上角一个小播放器、右边一片空白 ——
// 也就是「切回主体卡住」。反过来，窗口已经是小窗但界面还是完整布局时，同样什么都看不到。
// 这里以窗口实际尺寸为准双向纠正。
window.addEventListener('resize', () => {
  if (Date.now() - miniEnteredAt < 600) return   // 进入/退出瞬间的尺寸变化不要抢跑
  const w = window.innerWidth, h = window.innerHeight
  if (miniOn && w > 640) { setMiniMode(false); return }
  if (!miniOn && w > 0 && w <= 430 && h <= 220) applyMiniUi(true)
})

// 精简模式的队列：在同一个窗口里往下展开（参考图那样），不退回完整模式
let miniQueueOpen = false
function toggleMiniQueue(force, silent = false) {
  miniQueueOpen = typeof force === 'boolean' ? force : !miniQueueOpen
  const p = $('#miniPlayer')
  p?.classList.toggle('queue-open', miniQueueOpen)
  const q = $('#miniQueue')
  if (q) q.hidden = !miniQueueOpen
  // 让主进程把窗口拉高 / 收回（卡片本身高度固定，多出来的空间放列表）。
  // silent = 退出精简模式时用：那时窗口尺寸已由 win:mini 还原，不能再改。
  if (!silent) window.orangeWindow?.setMiniQueue?.(miniQueueOpen)
  if (miniQueueOpen) renderMiniQueue()
}
function renderMiniQueue() {
  const list = $('#mqList')
  if (!list) return
  const items = S.queue || []
  const cnt = $('#mqCount')
  if (cnt) cnt.textContent = items.length ? `${items.length} 首` : ''
  list.innerHTML = items.length
    ? items.map((t) => `<button class="mq-row${t.key === S.current?.key ? ' on' : ''}" data-mqkey="${esc(t.key)}"><span class="mq-name">${esc(t.title)}</span><span class="mq-art"> - ${esc(t.artist)}</span></button>`).join('')
    : '<div class="mq-empty">队列是空的</div>'
  list.querySelectorAll('[data-mqkey]').forEach((b) => {
    b.onclick = () => {
      const t = findTrack(b.dataset.mqkey) || (S.queue || []).find((x) => x.key === b.dataset.mqkey)
      if (t) playTrack(t).then(() => renderMiniQueue()).catch(() => {})
    }
  })
}
// 精简模式右侧「滚动歌词」：随播放进度逐句切换当前行，超宽时横向往返滚动。
// 独立于全屏歌词页（#npLyrics 没打开时这里照样要显示），所以不复用 highlightLyric。
// 按最终文本去重：切歌 / 换句 / 匹配中→匹配完成 都会触发，文本没变就不动 DOM。
let miniLyricText = ''
let miniSungPct = -1
let miniSungLine = ''
function renderMiniLyric(pos = 0) {
  const el = $('#miniLyricText')
  if (!el) return
  const L = S.lyrics || {}
  const ok = !!(L.key && L.key === S.current?.key && L.lines?.length)
  let idx = 0
  if (ok) {
    for (let i = 0; i < L.lines.length; i++) {
      if (L.lines[i].time <= pos + 90) idx = i
      else break
    }
  }
  const line = ok ? L.lines[idx] : null
  const t0 = line ? Number(line.time) || 0 : 0
  const next = ok ? L.lines[idx + 1] : null
  const t1 = next ? (Number(next.time) || (t0 + 5000)) : (t0 + 5000)
  // KTV 逐字上色：用「本句已唱时长 / 整句时长」推进渐变分界点。
  // 只在变化 ≥0.4% 时写变量（position 事件 4Hz，每次都写会一格一格跳），
  // 再靠 CSS 里 --sung 的 .22s 线性过渡补间 → 视觉上是连续推过去的。
  const ratio = line ? Math.max(0, Math.min(1, (pos - t0) / Math.max(400, t1 - t0))) : 0
  const pct = ratio * 100
  const lineTag = line ? `${L.key}|${idx}` : ''
  if (Math.abs(pct - miniSungPct) >= 0.4 || lineTag !== miniSungLine) {
    miniSungPct = pct
    miniSungLine = lineTag
    iosSetSung(el, pct, lineTag)
  }
  const text = ok ? String(line?.text || '').trim()
    : (L.loading ? '正在匹配歌词…'
      : (L.key && L.key === S.current?.key && L.text
        ? `♪ ${String(L.text).split('\n')[0].trim()}` : '♪ 暂无歌词'))
  if (text === miniLyricText) return
  miniLyricText = text
  el.classList.remove('marquee')
  el.style.removeProperty('--shift')
  el.style.removeProperty('--dur')
  el.textContent = text
  const wrap = el.parentElement
  if (!wrap) return
  wrap.classList.remove('scrolling')
  // 滚动速度自适应：滚动时长取「本句剩余时间」，句子多长就滚多久，
  // 保证这一句唱完前一定滚到句尾（以前固定 12s，长句还没滚完就换下一句了）。
  // 短句不滚；超长句限制最快 55px/s 的阅读速度，仍不超过本句时长。
  const remain = Math.max(1.2, ((next ? t1 : pos + 4500) - Math.max(pos, t0)) / 1000)
  requestAnimationFrame(() => {
    if (!el.isConnected) return
    const overflow = el.scrollWidth - wrap.clientWidth
    if (overflow > 6) {
      const dur = Math.max(1.2, Math.min(remain, 12))
      wrap.classList.add('scrolling')
      el.style.setProperty('--shift', `${-overflow}px`)
      el.style.setProperty('--dur', `${dur.toFixed(2)}s`)
      el.classList.add('marquee')
    }
  })
}
// 精简模式左栏的一行：文本超出自身宽度时在栏内往复滚动（歌名/歌手各自判断、互不影响）。
// 滚动速度按超出距离算（约 26px/s），长文本也不过快。
function setMiniLine(host, text) {
  if (!host) return
  const inner = host.querySelector('.ml-in') || host
  if (inner.textContent !== text) inner.textContent = text
  host.classList.remove('rolling')
  host.style.removeProperty('--shift')
  host.style.removeProperty('--dur')
  requestAnimationFrame(() => {
    if (!inner.isConnected) return
    const over = inner.scrollWidth - host.clientWidth
    if (over > 4) {
      host.style.setProperty('--shift', `${-over}px`)
      host.style.setProperty('--dur', `${Math.max(4, Math.min(16, over / 26)).toFixed(1)}s`)
      host.classList.add('rolling')
    }
  })
}
function updateMini() {
  const t = S.current
  const mt = $('#miniTitle'), ma = $('#miniArtist'), mc = $('#miniCover'), mp = $('#miniPlay')
  if (!mt || !mc) return
  setMiniLine(mt, t?.title || '未在播放')
  setMiniLine(ma, t?.artist || '从授权音源中选一首歌')
  paintCover(mc, t)
  switchPlayIcon(mp, !!S.playing)
  $('#miniLike')?.classList.toggle('on', !!(t && S.favorites.some((x) => x.key === t.key)))
  renderProgress()
}

// ---- 关于 ----
// 关于改为独立页面（不再弹窗）：底部 ⓘ / 相关入口统一 goto('about')
function openAbout() { goto('about') }

function bindStatic() {
  // Electron 桌面版：顶栏右侧的窗口按钮接管真实窗口操作（网页版没有 orangeWindow，自动跳过）
  const w = window.orangeWindow
  if (w) {
    document.documentElement.classList.add('native-window')
    const slots = { min: () => w.minimize(), max: () => w.toggleMax(), close: () => w.close(), full: () => w.toggleFull?.(), mini: () => setMiniMode(true) }
    document.querySelectorAll('[data-win]').forEach((el) => {
      const fn = slots[el.dataset.win]
      if (fn) el.onclick = fn
    })
    // 关闭按钮：主进程拦截后请求页面弹窗，用户选完再回传
    w.onAskClose?.(() => showCloseDialog())
    // 全屏状态由主进程回推，图标在全屏/还原之间切换
    w.onFullscreen?.((on) => {
      document.querySelectorAll('[data-win="full"]').forEach((b) => {
        const a = b.querySelector('.ico-full'), c = b.querySelector('.ico-unfull')
        if (!a || !c) return
        a.removeAttribute('hidden'); c.removeAttribute('hidden')
        a.classList.toggle('is-off', !!on)
        c.classList.toggle('is-off', !on)
        b.title = on ? '退出全屏' : '全屏'
      })
    })
    document.querySelector('.titlebar')?.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button, input, .pill, .winbtns')) w.toggleMax()
    })
    // 托盘菜单指令：播放控制 / 收藏 / 播放列表 / 音量 / 设置 / 关于
    w.onTrayCmd?.((cmd, val) => {
      if (cmd === 'play') togglePlay()
      else if (cmd === 'prev') next(-1)
      else if (cmd === 'next') next(1)
      else if (cmd === 'fav') toggleLike()
      else if (cmd === 'sync') pushTrayState()
      else if (cmd === 'volume') {
        const v = Number(val)
        if (!Number.isFinite(v)) return               // 绝不把 NaN 写进 audio.volume（会变成 0 且拉不回来）
        setVolumePref(v / 100)
        // 立即回推状态，托盘菜单下次打开 / 收到 tray:state 时显示的就是刚调的音量
        try { window.orangeWindow?.trayState?.({ volume: Math.round(prefVolume() * 100) }) } catch { /* 无宿主 */ }
      }
      // 托盘里的「播放队列」：打开完整队列面板（精简模式下先退回完整界面，否则面板看不到）
      else if (cmd === 'jump') {
        const t = S.queue[Number(val)]
        if (t) playTrack(t)
      } else if (cmd === 'list') {
        if (miniOn) setMiniMode(false)
        const q = $('#npQueuePanel')
        if (q) { q.hidden = false; renderNpQueue() }
      } else if (cmd === 'mode') {
        // 托盘里的播放模式：随机 → 顺序 → 单曲 → 列表 循环切换
        const order = ['shuffle', 'order', 'single', 'list']
        const i = order.indexOf(S.mode)
        setPlayMode(order[(i + 1) % order.length] || 'list')
        pushTrayState()
      }       else if (cmd === 'setmode') { setPlayMode(String(val || 'order')); pushTrayState() }
      // 精简模式下点「设置」/「关于」：小窗里放不下整页，先退回完整界面再跳转
      else if (cmd === 'settings') { if (miniOn) setMiniMode(false); goto('settings') }
      else if (cmd === 'about') { if (miniOn) setMiniMode(false); openAbout() }
      else if (cmd === 'account') { if (miniOn) setMiniMode(false); $('#loginSheet') && ($('#loginSheet').hidden = false) }
    })
  }
  // 侧栏是整块重绘的，底部三按钮 + 新建歌单只能走事件委托，直接 onclick 会在下一次渲染后失效。
  document.addEventListener('click', (e) => {
    const nw = e.target.closest('#qqNarrow')
    if (nw) { toggleSideNarrow(); return }
    // 音源与音质也必须走委托：侧栏整块重绘后直接 onclick 会丢（曾导致按钮点了没反应）
    if (e.target.closest('#qqSource')) { openSourceSheet(); return }
    // 顶栏「精简模式」：走委托，任何重绘后都还能点
    if (e.target.closest('#tbCollapse')) { setMiniMode(true); return }
    if (e.target.closest('#qqCog')) { goto('settings'); return }
    // 「登录保持」开关：点一下切换，关闭后下次启动需重新登录（当前这次不受影响）
    if (e.target.closest('#keepLoginSwitch')) {
      const on = S.core?.auth?.keepLoginEnabled?.() !== false
      try { S.core.auth.setKeepLogin(!on) } catch { /* 无宿主 */ }
      render()
      return
    }
    if (e.target.closest('#qqAbout')) { openAbout(); return }
    if (e.target.closest('#qqAddPl, #qqAddPl2')) { $('#importSheet').hidden = false; return }
    const pt = e.target.closest('[data-pltab]')
    if (pt) { S.plTab = pt.dataset.pltab === 'fav' ? 'fav' : 'mine'; renderNav(); return }
  })
  // 双击任意列表行直接播放（不挑封面图标或更多菜单）：orange-tr / row / orange-cp-row / npq-row 都带 data-key。
  // 必须走 playByKey：以前这里直接 playTrack(t)，结果双击歌单里的歌只往队列塞 1 首、旧队列也不清空。
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, a, select, textarea')) return
    const row = e.target.closest('.orange-tr[data-key], .row[data-key], .orange-cp-row[data-key], .npq-row[data-key]')
    if (!row) return
    const key = row.dataset.key
    if (row.classList.contains('npq-row')) {
      const t = (S.queue || []).find((x) => x.key === key)
      if (t) playTrack(t)
      return
    }
    playRowByKey(key)
  })
  document.addEventListener('click', (e) => {
    // 头像：未登录开登录面板，已登录回「我的音乐」（以前点了会落到别的页面，像进了播放页）
    if (e.target.closest('.orange-user')) {
      e.preventDefault()
      e.stopPropagation()
      // 已登录 → 个人主页（只放我喜欢 / 创建的歌单）；未登录 → 登录面板
      if (S.session) { S.libTab = '个人主页'; S.page = null; goto('library') }
      else openLoginSheet()
      return
    }
    if (e.target.closest('[data-avatar]')) { openAvatarSheet(); return }
    if (e.target.closest('[data-open-name]')) { openNameSheet(); return }
    const ptab = e.target.closest('[data-proftab]')
    if (ptab) { S.profileTab = ptab.dataset.proftab === 'pl' ? 'pl' : 'like'; render(); return
    }
    if (e.target.closest('[data-open-login]')) { $('#loginSheet').hidden = false; return }
    // 整榜页「重新加载」：清掉冷却期，强制重取一次
    if (e.target.closest('[data-cpretry]')) {
      cpTriedAt.clear()
      loadChartPage(S.section, { force: true })
      return
    }
    const b = e.target.closest('[data-section]')
    if (!b) return
    // 侧栏「巅峰榜 / 飙升榜」是整榜页（不是「全部榜单」目录），要在这里截住，别走 goto。
    if (b.dataset.section === 'peak' || b.dataset.section === 'rise') { openOrangeChart(b.dataset.section); return }
    if (b.dataset.lib) { S.libTab = b.dataset.lib; S.orangeTab = ''; S.orangeTabOf = '' }
    if (b.dataset.hall) goto('hall', { hallTab: b.dataset.hall })
    else goto(b.dataset.section)
  })
  document.addEventListener('click', (e) => {
    const p = e.target.closest('[data-playlist]')
    if (p) {
      // 收藏分组里的条目是平台歌单引用，点开要去平台取真实曲目；自建歌单才读本地曲目。
      const item = S.playlists.find((x) => x.id === p.dataset.playlist)
      if (item?.fav) openFavPlaylist(item.id)
      else openMyPlaylist(p.dataset.playlist)
    }
    if (e.target.closest('#sideImportBtn')) $('#importSheet').hidden = false
  })
  // 歌单右键菜单（参考 QQ：播放 / 删除 / 重命名 / 同步所有歌单 / 恢复歌单）
  document.addEventListener('contextmenu', (e) => {
    const p = e.target.closest('[data-playlist]')
    if (!p) return
    e.preventDefault()
    const id = p.dataset.playlist
    const pl = S.playlists.find((x) => x.id === id)
    if (!pl) return
    openCtxMenu({ x: e.clientX, y: e.clientY }, [
      { label: '播放', icon: MI.play, onClick: () => (pl.tracks || []).length ? playList(pl.tracks, 0, pl.name) : (pl.fav ? openFavPlaylist(id) : toast('这个歌单还没有歌曲')) },
      { sep: true },
      { label: '删除', icon: MI.trash, danger: true, onClick: () => (pl.fav ? toggleFavPlaylist(id) : deletePlaylist(id)) },
      { label: '重命名', disabled: !!pl.fav, onClick: () => renamePlaylist(id) },
      { sep: true },
      { label: '同步所有歌单', onClick: syncAllPlaylists },
      { label: '恢复歌单', onClick: restorePlaylists },
    ])
  })
  $('#globalSearch').onkeydown = (e) => { if (e.key === 'Enter') runSearch(e.target.value) }
  $('#settingsBtn').onclick = () => goto('settings')
  $('#accountBtn').onclick = () => openLoginSheet()
  $('#closeLoginBtn').onclick = () => { $('#loginSheet').hidden = true }
  $('#logoutBtn').onclick = async () => { if (!S.cloud) return toast('核心未就绪'); await S.core.auth.signOut(); location.reload() }
  bindAuthSheet()
  bindAvatarSheet()
  bindNameSheet()
  $('#closeImportBtn').onclick = () => $('#importSheet').hidden = true
  $('#doImportBtn').onclick = doImport
  // 音源与音质页的控件绑定在 bindSourcePage()：它是内嵌页面，每次渲染都会重建 DOM

  // 音质选择：自动 / 无损 / 320k / 192k / 128k
  const qs = $('#qualitySel')
  if (qs) {
    qs.value = S.quality
    qs.onchange = () => changeQuality(qs.value)
  }

  // 歌曲行：红心 / 添加到 / 更多（通用菜单）
  document.addEventListener('click', (e) => {
    const rh = e.target.closest('[data-rowheart]')
    if (rh) { toggleLikeKey(rh.dataset.rowheart); return }
    const ad = e.target.closest('[data-rowadd]')
    if (ad) { openPickSheet([ad.dataset.rowadd], ad); return }
    const more = e.target.closest('[data-rowmore]')
    if (more) { openRowMoreMenu(more, more.dataset.rowmore); return }
  })

  // 添加到歌单弹层
  $('#closePickBtn').onclick = () => $('#pickSheet').hidden = true
  $('#pickNewBtn').onclick = () => createPlaylistWithKeys($('#pickNewName').value.trim())

  // 暂停后「继续播放」：优先直接恢复已加载的 <audio>，而不是重跑一遍取链。
  // 音乐 CDN 的直链常带时效（签名 URL），播到一半后旧链接可能已失效；
  // 旧逻辑恢复时调 playWithFallback → 拿过期直链重新 play() → 全部候选失败，
  // 表现就是「暂停后再点播放没反应」，并弹出「已试 N 条链路」黑框（胡桃夹子那首即如此）。
  async function resumePlayback() {
    const a = $('#previewAudio')
    if (a && a.src && a.paused && !a.error) {
      try {
        const pos = S.positionMs || 0
        // 拖过进度条 / 事件滞后时把真实位置对齐，差得不多就别打断缓冲
        if (pos > 0 && Math.abs(a.currentTime * 1000 - pos) > 1500) {
          try { a.currentTime = pos / 1000 } catch { /* 元数据未就绪 */ }
        }
        await a.play()
        if (!a.paused) {
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
          return
        }
      } catch { /* 直链确实失效 → 落到下面重新取链 */ }
    }
    // 已加载的链接失效（签名 URL 过期 / CDN 断流）→ 必须重新取链，
    // 否则 playWithFallback 会拿 S.current.streams 里那批同样过期的直链再试一遍，
    // 全部失败就变成「暂停后再也播不动」（胡桃夹子 - 张碧晨 即此症状）。
    const pos = S.positionMs || 0
    try {
      return await S.core.quality.playWithFallback(S.current, pos, S.quality)
    } catch (e) {
      // 兜底：强制重新解析一次（不受失败冷却限制），成功就接着播
      try {
        const fresh = await S.core.sources.resolveRetry(S.current, []).catch(() => null)
        if (fresh?.streams?.length) {
          S.current = fresh
          S.queue = S.queue.map((x) => (x.key === fresh.key ? fresh : x))
          if (S.page?.tracks) S.page.tracks = S.page.tracks.map((x) => (x.key === fresh.key ? fresh : x))
          return await S.core.quality.playWithFallback(fresh, pos, S.quality)
        }
      } catch { /* 仍失败 → 交给上层统一提示「暂时无法播放」 */ }
      throw e
    }
  }

  const togglePlay = async () => {
    // iOS：刚由「点一下续播」把手势补上的这一帧，直接认定在播，
    // 否则 toggle 会因为 a.paused 已变 false 反而把刚起来的声音 pause 掉。
    if (Date.now() - (window.__omJustResumed || 0) < 700) {
      window.__omJustResumed = 0
      S.playing = true
      updatePlayerBar(); iosSyncNp(); iosRenderNav(); renderProgress()
      return
    }
    if (!S.current) { if (S.resume) return playTrack(S.resume.track, S.resume.positionMs); return toast('先选一首歌') }
    const a = $('#previewAudio')
    // ★ 以 <audio> 的真实状态为准：界面说在播、元素其实已暂停时，第一次点击必须是「播」，
    //   否则会出现「按钮点下去没反应 / 越点越乱」。只有拿不到元素时才退回 S.playing 取反。
    const actuallyPlaying = !!(a && !a.paused && !a.ended)
    const wantPlay = a ? !actuallyPlaying : !S.playing
    S.playing = wantPlay
    try {
      if (wantPlay) {
        await resumePlayback()
        if (a && a.paused) await a.play().catch(() => {})
      } else {
        try { a && a.pause() } catch { /* ignore */ }
        await native.pause()
      }
    } catch (e) {
      // 当前曲取不到链：留在这一首只提示，4 秒内禁止任何自动切歌路径把用户带走。
      noAutoSkipUntil = Date.now() + 4000
      toast(PLAY_FAIL, true)
      S.playing = false
    }
    // 落地后再对一次真实状态，避免图标与实际相反
    if (a) S.playing = !a.paused
    updatePlayerBar()
    iosSyncNp()
    iosRenderNav()
    renderProgress()
  }
  try { window.__omToggle = togglePlay } catch { /* ignore */ }
  $('#playBtn').onclick = togglePlay
  $('#npPlayBtn').onclick = togglePlay
  // 托盘菜单「播放 / 暂停」（Electron 壳）
  window.orangeWindow?.onTrayPlay?.(() => togglePlay())
  $('#nextBtn').onclick = () => next(1)
  $('#prevBtn').onclick = () => next(-1)
  $('#npNextBtn').onclick = () => next(1)
  $('#npPrevBtn').onclick = () => next(-1)
  $('#modeBtn') && ($('#modeBtn').onclick = (e) => { e.stopPropagation(); cyclePlayMode() })
  const seekTo = (value) => {
    const a = $('#previewAudio')
    // durationMs 缺失时退回 <audio> 的时长，否则拖动会算成 0 秒（表现为「拖不动」）
    const dur = S.current?.durationMs || (a && isFinite(a.duration) ? a.duration * 1000 : 0) || 0
    if (!dur) return
    S.positionMs = Math.min(dur, (Number(value) / 1000) * dur)
    renderProgress()
    native.seek(S.positionMs).catch(() => {})
  }
  // 拖动期间不让 timeupdate 把滑块拽回去
  const bindSeek = (el) => {
    if (!el) return
    el.oninput = (e) => seekTo(e.target.value)
    el.onpointerdown = () => { SEEKING = true }
    el.onpointerup = () => { SEEKING = false }
    el.onpointercancel = () => { SEEKING = false }
    el.onblur = () => { SEEKING = false }
  }
  bindSeek($('#seek'))
  bindSeek($('#npSeek'))
  $('#expandBtn').onclick = () => { $('#nowPlaying').hidden = false; updatePlayerBar() }
  $('#collapseBtn').onclick = () => { setNpQueueOpen(false); closeModeMenu(); closeQualityMenu(); $('#nowPlaying').hidden = true }
  $('#likeBtn') && ($('#likeBtn').onclick = toggleLike)
  $('#barLikeBtn') && ($('#barLikeBtn').onclick = toggleLike)
  $('#npLikeBtn') && ($('#npLikeBtn').onclick = toggleLike)
  $('#npVolBtn') && ($('#npVolBtn').onclick = () => {
    const a = $('#previewAudio'); if (!a) return
    a.muted = !a.muted
    // 标记为「用户主动静音」，巡检才不会把它当成历史脏数据反复解除
    try { window.__omUserMuted = a.muted } catch { /* ignore */ }
    $('#npVolBtn').classList.toggle('muted', a.muted)
  })
  $('#npDislikeBtn') && ($('#npDislikeBtn').onclick = () => toast('已减少推荐类似歌曲'))
  // 换肤按钮接管「日夜模式」：浅色 / 深色 / 跟随系统
  $('#npDressBtn') && ($('#npDressBtn').onclick = () => openThemeMenu($('#npDressBtn')))
  $('#barDress') && ($('#barDress').onclick = () => openThemeMenu($('#barDress')))
  // 播放页左下角的「四角括号」按钮 = 和其它地方同一个语义：进入精简模式（以前只是关掉播放页，点了像没反应）
  $('#npFoldBtn') && ($('#npFoldBtn').onclick = () => { setNpQueueOpen(false); closeModeMenu(); closeQualityMenu(); setMiniMode(true) })
  $('#npQualityBtn') && ($('#npQualityBtn').onclick = (e) => { e.stopPropagation(); openQualityMenu(e.currentTarget) })
  $('#npLyricBtn') && ($('#npLyricBtn').onclick = () => {
    const off = $('#nowPlaying').classList.toggle('no-lyric')
    $('#npLyricBtn').classList.toggle('on', !off)
    $('#npLyricBtn').title = off ? '显示歌词' : '隐藏歌词'
    $('#npLyricBtn').setAttribute('aria-pressed', off ? 'false' : 'true')
  })
  $('#npListBtn') && ($('#npListBtn').onclick = () => setNpQueueOpen($('#npQueuePanel')?.hidden !== false))
  $('#npModeBtn') && ($('#npModeBtn').onclick = (e) => { e.stopPropagation(); cyclePlayMode() })
  bindNpQueue()
  bindQualityMenu()
  // 播放页开/合时把队列面板挪到对应层级
  const npEl = $('#nowPlaying')
  if (npEl) {
    new MutationObserver(() => {
      const p = $('#npQueuePanel')
      if (!p || p.hidden) return
      const host = npEl.hidden ? document.body : npEl
      if (p.parentElement !== host) host.appendChild(p)
    }).observe(npEl, { attributes: true, attributeFilter: ['hidden'] })
  }
  bindModeMenu()
  syncModeUI()
  const lyricBox = $('#npLyrics')
  if (lyricBox) lyricBox.onclick = () => {
    if (!S.current || S.lyrics.lines.length || S.lyrics.text) return
    loadLyricsFor(S.current, true)
  }
  bindLyricDrag()
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.page) back()
  })

  // ── Windows 新增顶栏 / 播放条控件 ──
  const openPlayer = () => {
    $('#nowPlaying').hidden = false
    updatePlayerBar()
    // 播放页打开时若当前曲还没有封面，立即补一次解析并刷新（列表页有封面、播放页是占位的根因）
    if (S.current && !cachedCover(S.current) && S.core?.covers) {
      S.core.covers.fillCovers([S.current], { limit: 1 }).then((m) => {
        const u = m.get(S.current.key)
        if (u && S.current) { S.current.cover = u; updatePlayerBar() }
      }).catch(() => {})
    }
  }
  if (IS_WIN) {
    $('#tbRefresh') && ($('#tbRefresh').onclick = () => render())
    $('#tbBack') && ($('#tbBack').onclick = () => goBack())
    $('#tbFwd') && ($('#tbFwd').onclick = () => goFwd())
    // 播放条：封面 / 标题 / 歌手 → 打开播放页；喜欢 / 评论 / 音效 / 换肤 / 词 / 列表
    $('#barCover') && ($('#barCover').onclick = openPlayer)
    $('#barTitle') && ($('#barTitle').onclick = openPlayer)
    $('#barArtist') && ($('#barArtist').onclick = openPlayer)
    $('#barVip') && ($('#barVip').onclick = () => openSourceSheet())
    $('#barLyric') && ($('#barLyric').onclick = openPlayer)
    $('#barList') && ($('#barList').onclick = (e) => { e.stopPropagation(); setNpQueueOpen(!isQueueOpen()) })
    $('#barDislike') && ($('#barDislike').onclick = () => toast('已减少推荐类似歌曲'))
    $('#qualityBtn') && ($('#qualityBtn').onclick = (e) => { e.stopPropagation(); openQualityMenu(e.currentTarget) })
    const aVol = $('#previewAudio')
    const volBtn = $('#volBtn'), volPopup = $('#volPopup'), volRange = $('#volRange'), volPct = $('#volPct'), volMute = $('#volMuteBtn')
    if (volBtn) volBtn.onclick = (e) => { e.stopPropagation(); volPopup.hidden = !volPopup.hidden; if (!volPopup.hidden) { const v = Math.round(prefVolume() * 100); volRange.value = v; volPct.textContent = v + '%' } }
    if (volRange) volRange.oninput = () => { const v = volRange.value / 100; setVolumePref(v); volPct.textContent = volRange.value + '%'; volBtn.classList.toggle('muted', v === 0) }
    if (volMute) volMute.onclick = (e) => { e.stopPropagation(); const a = $('#previewAudio'); if (!a) return; a.muted = !a.muted; try { window.__omUserMuted = a.muted } catch { /* ignore */ } volBtn.classList.toggle('muted', a.muted); if (!a.muted && a.volume === 0) { setVolumePref(0.8); volRange.value = 80; volPct.textContent = '80%' } }
    if (!volPopup.dataset.bound) { volPopup.dataset.bound = '1'; document.addEventListener('click', (e) => { if (volPopup && !e.target.closest('#volPopup, #volBtn')) volPopup.hidden = true }) }
    $('#miniCover') && ($('#miniCover').onclick = () => {
      if ($('#miniPlayer')?.dataset.dragged) return   // 刚拖过窗口，别误触打开播放页
      openPlayer()
    })
    $('#qqDemoItem') && ($('#qqDemoItem').onclick = () => playDemo())
    $('#closeAboutBtn') && ($('#closeAboutBtn').onclick = () => $('#aboutSheet').hidden = true)
    $('#aboutCheck') && ($('#aboutCheck').onclick = () => runUpdateCheck(true))
    $('#aboutSource') && ($('#aboutSource').onclick = () => { $('#aboutSheet').hidden = true; openSourceSheet() })
    // 精简模式（迷你播放器）
    $('#miniClose') && ($('#miniClose').onclick = () => setMiniMode(false))
    $('#miniPlay') && ($('#miniPlay').onclick = togglePlay)
    $('#miniPrev') && ($('#miniPrev').onclick = () => next(-1))
    $('#miniNext') && ($('#miniNext').onclick = () => next(1))
    $('#miniLike') && ($('#miniLike').onclick = toggleLike)
    $('#miniDislike') && ($('#miniDislike').onclick = () => toast('已减少推荐类似歌曲'))
    // 队列按钮：在精简窗口里直接展开队列（不再退回完整模式）
    $('#miniList') && ($('#miniList').onclick = () => toggleMiniQueue())
    // 精简模式小窗：整条播放栏都能拖动。窗口是透明无边框的，若把 -webkit-app-region
    // 设成 drag，指针事件会被系统吞掉 —— hover 就只剩关闭按钮能触发（用户反馈的问题）。
    // 所以这里自己算位移，交给主进程 setPosition。
    const mpl = $('#miniPlayer')
    if (mpl && !mpl.dataset.dragBound) {
      mpl.dataset.dragBound = '1'
      let down = false, moved = false, sx = 0, sy = 0
      const endDrag = () => {
        if (!down) return
        down = false
        window.orangeWindow?.dragEnd?.()
        if (moved) {
          mpl.dataset.dragged = '1'
          setTimeout(() => { delete mpl.dataset.dragged }, 0)
        }
        moved = false
      }
      mpl.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return
        // 文字/图片被拖拽会走原生 drag，把窗口拖动搅乱
        e.preventDefault()
        down = true; moved = false; sx = e.screenX; sy = e.screenY
        window.orangeWindow?.dragStart?.(e.screenX, e.screenY)
      })
      // 关键：必须校验按键仍然按下。以前只靠 mouseup，一旦鼠标在窗口外松开，
      // mouseup 收不到 → down 一直为 true → 之后随便移动鼠标窗口就跟着跑（越跑越下）。
      const onMove = (e) => {
        if (!down) return
        if (e.buttons === 0) { endDrag(); return }
        if (!moved && Math.abs(e.screenX - sx) + Math.abs(e.screenY - sy) > 4) moved = true
        if (moved) window.orangeWindow?.dragMove?.(e.screenX, e.screenY)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', endDrag)
      window.addEventListener('blur', endDrag)
      document.addEventListener('mouseleave', endDrag)
      document.addEventListener('dragstart', (e) => e.preventDefault())
    }
  }
}

function markActive() {
  // 音源与音质是设置里进去的子页面，侧栏仍然点亮「设置」
  const active = S.page ? (S.page.from === 'home' ? 'home' : 'hall') : (S.section === 'source' ? 'settings' : S.section)
  // 带 data-lib 的侧栏项共用 data-section="library"，不能按 data-section 统一点亮，
  // 否则「喜欢 / 最近播放 / 本地歌曲 / 试听列表」会同时出现选中底纹。
  document.querySelectorAll('[data-section]:not([data-lib])').forEach((x) => x.setAttribute('aria-current', x.dataset.section === active ? 'page' : 'false'))
  document.querySelectorAll('.nav-item[data-section]').forEach((x) => x.setAttribute('aria-current', x.dataset.section === active ? 'page' : 'false'))
  document.querySelectorAll('.orange-nav[data-section]').forEach((x) => x.setAttribute('aria-current', x.dataset.section === active ? 'page' : 'false'))
  document.querySelectorAll('.orange-side-item[data-lib]').forEach((x) => {
    const on = S.section === 'library' && !S.page && S.libTab === x.dataset.lib
    x.setAttribute('aria-current', on ? 'page' : 'false')
  })
  syncNavBtns()
}

function next(dir, { auto = false } = {}) {
  if (!S.queue.length) return
  // 单曲循环只影响「自动播完」，手动点下一首仍然换歌
  if (auto && S.mode === 'single') { S.positionMs = 0; playTrack(S.current); return }
  const i = S.queue.findIndex((t) => t.key === S.current?.key)
  // 私人推荐续杯：最后一首播完 / 在最后一首上滑 → 换上全新 6 首接着播，
  // 不再停在末尾或回卷到第一首。失败时回退到原来的队列行为，界面不会卡死。
  if (IS_IOS && iosRecFlow && dir > 0 && i >= 0 && i === S.queue.length - 1) {
    // 刷新进行中再上滑：直接忽略，别用旧队列下标回卷，否则会和正在写入的新队列打架
    if (iosRecBusy) return
    iosRefreshRecFlow().then((ok) => { if (!ok) nextInQueue(i, dir, auto) })
    return
  }
  nextInQueue(i, dir, auto)
}
// 原队列行为（顺序 / 单曲循环 / 随机），抽出来给续杯失败时兜底
function nextInQueue(i, dir, auto) {
  if (!S.queue.length) return
  let j
  if (S.mode === 'shuffle') {
    // 随机：尽量不和当前这首重复
    j = S.queue.length > 1 ? Math.floor(Math.random() * (S.queue.length - 1)) : 0
    if (i >= 0 && j >= i) j += 1
  } else {
    j = i < 0 ? (dir > 0 ? 0 : S.queue.length - 1) : i + dir
    if (j < 0 || j >= S.queue.length) {
      // 顺序播放：播到最后一首就停，不回卷
      if (S.mode === 'order' && auto && dir > 0) {
        S.playing = false
        try { native.pause() } catch { /* ignore */ }
        updatePlayerBar()
        return
      }
      j = (j + S.queue.length) % S.queue.length
    }
  }
  playTrack(S.queue[j])
}

async function toggleLike() {
  if (!S.current) return
  const exists = S.favorites.some((x) => x.key === S.current.key)
  S.favorites = exists ? S.favorites.filter((x) => x.key !== S.current.key) : [{ ...S.current, addedAt: Date.now() }, ...S.favorites]
  if (S.cloud) {
    await saveFavorites().catch((e) => toast(e.message))
    if (!exists) S.core.rec.trackEvent('like', S.current.key, S.current.tags || []).catch(() => {})
  }
  if (S.section === 'library' && S.libTab === '我喜欢' && !S.page) await render()
  updatePlayerBar()
  toast(exists ? '已取消喜欢' : '已加入我喜欢')
}

// ---- 批量操作 ----
async function batchAction(kind) {
  const all = S.batchTracks || []
  const targets = S.picked.size ? all.filter((t) => S.picked.has(t.key)) : all
  if (kind === 'clear') { S.picked.clear(); return render() }
  // 「⋯ → 批量操作」：进入 / 退出多选，退出时清掉已选，避免残留勾选影响下次
  if (kind === 'pickstart') {
    S.pickMode = true
    S.picked.clear()
    render()
    return toast('批量操作：勾选歌曲后可批量播放 / 加歌单 / 收藏')
  }
  if (kind === 'pickdone') { S.pickMode = false; S.picked.clear(); return render() }
  if (kind === 'pickall') {
    if (S.picked.size >= all.length) S.picked.clear()
    else all.forEach((t) => t.key && S.picked.add(t.key))
    return render()
  }
  if (kind === 'toggle') {
    S.orangePicking = !S.orangePicking
    S.picked.clear()
    render()
    return toast(S.orangePicking ? '批量模式：点歌曲行勾选，再用「播放」批量操作' : '已退出批量模式')
  }
  if (kind === 'picktoggle') {
    S.pickMode = !S.pickMode
    S.picked.clear()
    render()
    return toast(S.pickMode ? '批量模式：勾选歌曲后可批量播放 / 加歌单 / 收藏' : '已退出批量模式')
  }
  if (kind === 'searchchart') {
    const q = S.page?.source?.chart?.tags?.slice(0, 2).join(' ') || S.page?.title || ''
    if (!q) return
    S.page = null
    return runSearch(q)
  }
  if (!targets.length) return toast('先选择曲目')
  if (kind === 'play') {
    // 批量播放同样视为「从这张列表开始播」：换列表才重建队列，同一列表沿用现有队列
    const ctx = currentListContext()
    return playList(targets, 0, S.picked.size ? `已选 ${targets.length} 首` : `${S.page?.title || S.libTab || '列表'}`, ctx?.meta || null)
  }
  if (kind === 'shuffle') {
    const arr = targets.slice()
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]] }
    return playList(arr, 0, '随机播放')
  }
  if (kind === 'add') return openPickSheet(targets.map((t) => t.key), document.querySelector('[data-batch="add"]'))
  if (kind === 'like') return likeAll(targets)
  if (kind === 'del') {
    const n = targets.length
    if (!n) return toast('先勾选要删除的曲目')
    const keys = new Set(targets.map((t) => t.key))
    // 歌单详情页：自建歌单真删除（写回仓库）；收藏的平台歌单只能从当前列表移除
    if (S.page?.source?.type === 'playlist') {
      const id = S.page.source.id
      const pl = S.playlists.find((p) => p.id === id)
      if (!pl) return toast('歌单不存在')
      if (!(await askConfirm(`确定从「${pl.name}」移除 ${n} 首歌曲？`, { title: '移除歌曲', ok: '移除', danger: true }))) return
      const before = (pl.tracks || []).length
      pl.tracks = (pl.tracks || []).filter((t) => !keys.has(t.key))
      try { if (S.core) await S.core.repo.setState(S.core.repo.keys.playlist(id), pl) } catch (e) { return toast(`保存失败：${e.message}`) }
      S.page.tracks = pl.tracks.slice()
      S.page.sub = `自建歌单 · ${pl.tracks.length} 首 · ${S.session ? '云端同步' : '仅存本机'}`
      S.picked.clear(); S.pickMode = false
      renderNav(); render()
      return toast(`已从「${pl.name}」移除 ${before - pl.tracks.length} 首`)
    }
    if (S.page?.source?.fav) {
      if (!(await askConfirm(`确定从当前列表移除 ${n} 首？收藏的平台歌单不支持改动，重新进入会恢复。`, { title: '移除歌曲', ok: '移除' }))) return
      S.page.tracks = (S.page.tracks || []).filter((t) => !keys.has(t.key))
      S.picked.clear(); S.pickMode = false
      render()
      return toast(`已移除 ${n} 首`)
    }
    const tab = S.libTab
    const label = tab === '我喜欢' ? '取消收藏' : tab === '最近播放' ? '清除播放记录' : tab === '本地歌曲' ? '移除本地歌曲' : '移除'
    if (!(await askConfirm(`确定${label} ${n} 首歌曲？`, { title: label, ok: label, danger: true }))) return
    if (tab === '我喜欢') {
      S.favorites = S.favorites.filter((t) => !keys.has(t.key))
      if (S.cloud) saveFavorites().catch(() => {})
    } else if (tab === '最近播放') {
      S.recent = S.recent.filter((t) => !keys.has(t.key))
    } else if (tab === '本地歌曲') {
      S.localTracks = S.localTracks.filter((t) => !keys.has(t.key))
    }
    // 试听列表已改为「专辑 / 歌单」卡片（无单曲行），批量删歌不再覆盖它；清空入口是列表页的「清空记录」。
    S.picked.clear(); S.orangePicking = false
    renderNav(); render()
    return toast(`已${label} ${n} 首`)
  }
  if (kind === 'delpl') {
    const id = S.page?.source?.id
    if (!id) return toast('当前歌单无法删除')
    return deletePlaylist(id)
  }
  if (kind === 'sharepl') {
    const t = S.page?.title || '歌单'
    try { await navigator.clipboard.writeText(`${t} · 分享自 橙子音乐`); toast('已复制歌单分享信息') } catch { toast('复制歌单信息失败') }
    return
  }
}

async function likeAll(tracks) {
  const have = new Set(S.favorites.map((t) => t.key))
  const add = tracks.filter((t) => t.key && !have.has(t.key))
  if (!add.length) return toast('这些曲目已经都在「我喜欢」里了')
  S.favorites = [...add.map((x) => ({ ...x, addedAt: Date.now() })), ...S.favorites].slice(0, 1000)
  if (S.cloud) {
    await saveFavorites().catch((e) => toast(e.message))
    for (const t of add.slice(0, 20)) S.core.rec.trackEvent('like', t.key, t.tags || []).catch(() => {})
  }
  updatePlayerBar()
  toast(`已收藏 ${add.length} 首`)
  renderNav()
  if (S.section === 'library' && S.libTab === '我喜欢' && !S.page) render()
}

// 添加到歌单弹层
// 「添加」不再弹窗口：就地弹菜单（播放队列 / 我喜欢 / 各歌单 / 添加到新歌单）
function openPickSheet(keys, anchor = null) {
  const list = [...new Set((keys || []).filter(Boolean))]
  if (!list.length) return toast('没有可添加的曲目')
  S.pickKeys = list
  const tracks = list.map((k) => findTrack(k) || (S.queue || []).find((t) => t.key === k)).filter(Boolean)
  openCtxMenu(anchor || document.querySelector('[data-batch="add"]') || document.body, [
    { label: '播放队列', icon: MI.next, onClick: () => {
      S.queue = capQ([...(S.queue || []), ...tracks])
      if (!S.current && tracks[0]) playTrack(tracks[0])
      render()
      toast(`已添加到播放队列 · ${tracks.length} 首`)
    } },
    { label: '我喜欢的音乐', icon: MI.heart, onClick: () => likeAll(tracks) },
    { sep: true },
    ...S.playlists.map((p) => ({ label: `${p.name}（${p.tracks?.length || 0} 首）`, onClick: () => mergeIntoPlaylist(p, list) })),
    ...(S.playlists.length ? [{ sep: true }] : []),
    { label: '添加到新歌单', onClick: async () => {
      const name = await askText('新建歌单', '给歌单起个名字')
      if (name) await createPlaylistWithKeys(name)
    } },
  ])
}

async function addKeysToPlaylist(id) {
  const pl = S.playlists.find((p) => p.id === id)
  if (!pl) return
  await mergeIntoPlaylist(pl, S.pickKeys)
}

async function createPlaylistWithKeys(name) {
  if (!name) return toast('先填歌单名称')
  const list = { id: `pl-${Date.now()}`, name, platform: '自建', tracks: [], createdAt: Date.now() }
  await mergeIntoPlaylist(list, S.pickKeys, true)
}

async function mergeIntoPlaylist(pl, keys, isNew = false) {
  if (!S.cloud) return toast('核心未就绪')
  const map = new Map((pl.tracks || []).map((t) => [t.key, t]))
  const byKey = new Map(allTracks().map((t) => [t.key, t]))
  let added = 0
  for (const k of keys) {
    if (map.has(k)) continue
    const t = byKey.get(k)
    if (!t) continue
    map.set(k, t)
    added += 1
  }
  pl.tracks = [...map.values()].slice(0, 1000)
  try {
    await S.core.repo.setState(S.core.repo.keys.playlist(pl.id), pl)
    if (isNew) S.playlists.push(pl)
    $('#pickSheet').hidden = true
    renderNav()
    toast(added ? `已添加 ${added} 首到「${pl.name}」` : `「${pl.name}」里已经有这些歌了`)
    if (S.section === 'hall' && S.hallTab === '歌单广场' && !S.page) render()
    if (S.page?.source?.type === 'playlist' && S.page.source.id === pl.id) {
      S.page.tracks = pl.tracks
      render()
    }
  } catch (e) { toast(`保存歌单失败：${e.message}`) }
}

// ---- 歌单右键菜单助手：重命名 / 同步所有歌单 / 恢复歌单 ----
// Electron 无 window.prompt，用小浮层输入代替。
function promptLine(title, def = '') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'prompt-wrap'
    wrap.innerHTML = `<div class="prompt-box"><div class="prompt-title">${esc(title)}</div>
      <input class="prompt-input" value="${esc(def)}">
      <div class="prompt-btns"><button class="btn small" data-prompt="0">取消</button><button class="btn small primary" data-prompt="1">确定</button></div></div>`
    document.body.appendChild(wrap)
    const input = wrap.querySelector('input')
    input.focus(); input.select()
    const done = (v) => { wrap.remove(); resolve(v) }
    wrap.querySelector('[data-prompt="0"]').onclick = () => done(null)
    wrap.querySelector('[data-prompt="1"]').onclick = () => done(input.value.trim() || null)
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); if (e.key === 'Escape') done(null) }
  })
}

async function renamePlaylist(id) {
  const p = S.playlists.find((x) => x.id === id)
  if (!p) return
  if (p.fav) return toast('收藏歌单不支持重命名')
  const name = await promptLine('重命名歌单', p.name)
  if (!name || name === p.name) return
  p.name = name
  try { if (S.cloud) await S.core.repo.setState(S.core.repo.keys.playlist(p.id), p) } catch (e) { toast(`保存失败：${e.message}`) }
  renderNav(); render(); toast('已重命名')
}

async function syncAllPlaylists() {
  if (!S.cloud) return toast('云端未就绪：登录后才能同步歌单')
  const mine = S.playlists.filter((p) => !p.fav)
  let ok = 0
  for (const p of mine) {
    try { await S.core.repo.setState(S.core.repo.keys.playlist(p.id), p); ok++ } catch { /* 单个失败不影响其余 */ }
  }
  toast(`已同步 ${ok}/${mine.length} 个歌单到云端`)
}

const PL_TRASH_KEY = 'orangemusic:pl-trash'
async function restorePlaylists() {
  let trash = []
  try { trash = JSON.parse(localStorage.getItem(PL_TRASH_KEY) || '[]') } catch { /* 隐私模式 */ }
  if (!trash.length) return toast('没有可恢复的歌单（删除的歌单会暂存这里）')
  let n = 0
  for (const p of trash) {
    if (!p?.id || S.playlists.some((x) => x.id === p.id)) continue
    S.playlists.push(p); n++
    try { if (S.cloud) await S.core.repo.setState(S.core.repo.keys.playlist(p.id), p) } catch { /* 本地恢复即可 */ }
  }
  try { localStorage.removeItem(PL_TRASH_KEY) } catch { /* ignore */ }
  renderNav(); render(); toast(`已恢复 ${n} 个歌单`)
}

// ---- 自建歌单的删除 / 清空 / 移除单曲 ----
async function deletePlaylist(id) {
  const pl = S.playlists.find((p) => p.id === id)
  if (!pl) return
  if (!(await askConfirm(`删除歌单「${pl.name || '未命名歌单'}」？删除后可在歌单右键菜单「恢复歌单」里找回。`, { title: '删除歌单', ok: '删除', danger: true }))) return
  try {
    // 先进回收站（localStorage 暂存 20 个），供右键「恢复歌单」找回
    const trash = (() => { try { return JSON.parse(localStorage.getItem(PL_TRASH_KEY) || '[]') } catch { return [] } })()
    trash.unshift(pl)
    try { localStorage.setItem(PL_TRASH_KEY, JSON.stringify(trash.slice(0, 20))) } catch { /* 隐私模式 */ }
    if (S.core) await S.core.repo.delState(S.core.repo.keys.playlist(id)).catch(() => {})
  } catch { /* 云端删不掉也继续清本地视图 */ }
  try { localStorage.removeItem(`orangemusic:v1:state:playlist:${id}`) } catch { /* 隐私模式 */ }
  S.playlists = S.playlists.filter((p) => p.id !== id)
  if (S.page?.source?.type === 'playlist' && S.page.source.id === id) {
    S.page = null
    S.section = 'hall'
    S.hallTab = '歌单广场'
  }
  renderNav()
  render()
  markActive()
  toast(`已删除歌单「${pl.name || '未命名歌单'}」`)
}

async function clearPlaylist(id) {
  const pl = S.playlists.find((p) => p.id === id)
  if (!pl) return
  if (!(pl.tracks || []).length) return toast('这个歌单已经是空的')
  if (!(await askConfirm(`清空「${pl.name}」里的 ${pl.tracks.length} 首歌？`, { title: '清空歌单', ok: '清空', danger: true }))) return
  pl.tracks = []
  try { if (S.core) await S.core.repo.setState(S.core.repo.keys.playlist(id), pl) } catch (e) { toast(`保存失败：${e.message}`) }
  if (S.page?.source?.type === 'playlist' && S.page.source.id === id) {
    S.page.tracks = []
    S.page.sub = '自建歌单 · 0 首'
  }
  render()
  toast('歌单已清空')
}

async function removeFromPlaylist(plId, key) {
  const pl = S.playlists.find((p) => p.id === plId)
  if (!pl) return
  const before = (pl.tracks || []).length
  pl.tracks = (pl.tracks || []).filter((t) => t.key !== key)
  if (pl.tracks.length === before) return
  try { if (S.core) await S.core.repo.setState(S.core.repo.keys.playlist(plId), pl) } catch (e) { toast(`保存失败：${e.message}`) }
  if (S.page?.source?.type === 'playlist' && S.page.source.id === plId) {
    S.page.tracks = pl.tracks
    S.page.sub = `自建歌单 · ${pl.tracks.length} 首 · ${S.session ? '云端同步' : '仅存本机'}`
  }
  render()
  toast(`已从「${pl.name}」移除`)
}

async function doImport() {
  // 导入只依赖本地核心模块 + 同源 /api/proxy，不要求登录 / 云端可用
  if (!S.core?.importer) return ($('#importErr').textContent = '核心未就绪，稍后重试')
  try {
    $('#importErr').textContent = '正在解析…'
    const res = await S.core.importer.importPlaylist($('#importInput').value)
    if (!res.tracks.length) {
      $('#importErr').textContent = res.hint || '未解析到曲目，请粘贴歌单分享链接、「歌名 - 歌手」文本，或含 songmid/hash 的 JSON'
      return
    }
    // 全部添加：以解析到的原始曲目为准，不挑音源；带平台 ID 的记为 pending，点播时再取链。
    const src = (res.tracks && res.tracks.length) ? res.tracks : (res.pendingRows || [])
    const matched = src.map((r) => makeTrack({
      title: r.name || r.title, artist: r.singer || r.artist, album: r.album || '',
      cover: r.cover || '', durationMs: r.durationMs || 0,
      pending: r.pending || (r.songmid || r.id ? {
        // 同时写 platform（新引擎用）与 source（反查/缓存用），避免两套契约错位导致 QQ 曲目精确取链被跳过。
        platform: (r.source === 'tx' || r.source === 'qq') ? 'qq' : (r.source === 'wy' || r.source === 'netease') ? 'netease' : undefined,
        source: r.source, id: String(r.songmid || r.id), name: r.name || r.title,
        singer: r.singer || r.artist, album: r.album || '', cover: r.cover || '', durationMs: r.durationMs || 0,
      } : undefined),
    }))
    const list = { id: `pl-${Date.now()}`, name: res.title || res.platform, platform: res.platform, tracks: matched, createdAt: Date.now() }
    await S.core.repo.setState(S.core.repo.keys.playlist(list.id), list)
    S.playlists.push(list)
    S.core.rec.trackEvent('import', '', res.tracks.slice(0, 20).map((t) => t.artist)).catch(() => {})
    $('#importSheet').hidden = true
    toast(`已导入 ${matched.length} 首（按列表全部添加，点播时按平台 ID 取链，无音源也保留）`)
    renderNav(); render()
  } catch (e) { $('#importErr').textContent = e.message }
}

// ---- 音源与音质：内嵌页面（从设置页点进去，和设置同一套视觉）----
async function openSourceSheet() {
  if (S.section !== 'source' || S.page) {
    pushHist()
    S.page = null
    S.section = 'source'
    markActive()
  }
  await render()
}

// 新版音源页内容由 index.html 的 <template id="sourceTpl"> 提供，无需 JS 注入 LX 状态

// 音源页的元素可能在异步过程中被切页销毁：错误提示统一走带空值保护的写入
const srcErrOf = (e) => { const n = $('#sourceErr'); if (n) n.textContent = e.message }
const srcErrClear = () => { const n = $('#sourceErr'); if (n) n.textContent = '' }

async function saveSourceCfg() {
  try {
    const parsed = JSON.parse($('#sourceCfg').value)
    if (!S.core) throw new Error('核心未就绪')
    const cfg = (await S.core.repo.getState(S.core.repo.keys.sources).catch(() => null)) || {}
    cfg.endpoints = parsed.endpoints || []
    cfg.ownAudio = parsed.ownAudio || []
    await S.core.repo.setState(S.core.repo.keys.sources, cfg)
    toast(S.session ? '授权源配置已保存到云端' : '授权源配置已保存到本机（离线试用）')
    srcErrClear()
  } catch (e) { srcErrOf(e) }
}

// 完全无广告：任何注入式广告位 / 追踪 SDK 在此被硬拒绝。
if (!ADS_ENABLED) Object.freeze(window.adSlots = [])

// PWA：网络优先 + 离线兜底；iOS 网页版与 Windows exe 共用同一份实现。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {}))
}

boot()
