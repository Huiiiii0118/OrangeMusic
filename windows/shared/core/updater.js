// 在线更新：GitHub Releases 检查 + 下载入口。
//
// 交付形态是「单文件免安装 exe」和「iOS 网页 / PWA」，两者都不能像安装版那样静默替换自己，
// 所以这里做的是「检查 → 告知 → 打开下载链接」，用户换掉 exe 即可（数据在 %APPDATA%\橙子音乐，
// 不受影响）。等仓库传到 GitHub 之后，把「设置 → 更新 → 仓库」改成你自己的 owner/repo 就能用，
// Release 的 tag 用 v1.2.3，资产名带 .exe 会自动识别成 Windows 安装包。
//
// 只用公开 API，不带任何 token，也不上报任何东西。
import { native } from '../protocol/bridge.js'

const LS = 'orangemusic:update:v1'
const CACHE_MS = 10 * 60 * 1000

// 当前版本：改版本号只改这一处 + package.json。
export const CURRENT_VERSION = '1.0.1'

const DEFAULTS = Object.freeze({
  repo: 'Huiiiii0118/OrangeMusic',   // 官方仓库：OrangeMusic
  auto: true,                      // 启动时静默检查一次
})

const read = () => {
  try {
    const j = JSON.parse(localStorage.getItem(LS) || '{}')
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}
const write = (v) => {
  try { localStorage.setItem(LS, JSON.stringify(v)) } catch { /* 隐私模式 */ }
}

export function readCfg() {
  const j = read()
  // 设置页已不再提供「更新源」编辑入口，任何非官方仓库地址都是历史遗留（早期版本存过
  // 'orangemusic/orange-music'、'organgemusic/orangemusic' 这类占位值），会让检查更新 404。
  // 这里统一纠正并落盘，之后永远按官方仓库检查。
  const raw = String(j.repo || '').trim()
  const repo = raw && raw.toLowerCase() === DEFAULTS.repo.toLowerCase() ? raw : DEFAULTS.repo
  if (raw && raw !== repo) { try { write({ ...j, repo }) } catch { /* 隐私模式 */ } }
  return { repo, auto: j.auto !== false, last: j.last || null }
}

export function saveCfg(patch = {}) {
  const cur = readCfg()
  const next = { ...read(), ...cur, ...patch }
  write(next)
  return readCfg()
}

// 版本号比较：只比前三段数字，1.2 == 1.2.0
export const parseVer = (v) => String(v || '').replace(/^v/i, '')
  .split(/[.+-]/).slice(0, 3).map((x) => Number(String(x).replace(/\D/g, '')) || 0)

export function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

const ASSET_ORDER = [/\.exe$/i, /\.msi$/i, /\.zip$/i, /\.dmg$/i, /\.apk$/i]

function pickAsset(assets = []) {
  for (const re of ASSET_ORDER) {
    const hit = assets.find((a) => re.test(a.name || ''))
    if (hit) return hit
  }
  return assets[0] || null
}

async function ghJson(url) {
  const r = await native.request(url, {
    method: 'GET',
    timeout: 9000,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OrangeMusic-Updater',
    },
  })
  if (!r || typeof r.statusCode !== 'number') throw new Error('网络无响应')
  if (r.statusCode === 404) throw new Error('仓库或 Release 不存在（先在 GitHub 发布一个 Release，或检查仓库地址）')
  if (r.statusCode === 403) throw new Error('GitHub 接口限流，稍后再试')
  if (r.statusCode >= 400) throw new Error(`GitHub 返回 HTTP ${r.statusCode}`)
  const t = String(r.bodyRaw || '').trim()
  if (!t) throw new Error('空响应')
  return JSON.parse(t)
}

const normalizeRelease = (rel, repo) => {
  const assets = (rel.assets || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: Number(a.size) || 0,
  }))
  const asset = pickAsset(assets)
  return {
    ok: true,
    repo,
    current: CURRENT_VERSION,
    latest: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
    name: rel.name || rel.tag_name || '',
    notes: String(rel.body || '').slice(0, 4000),
    publishedAt: rel.published_at || '',
    pageUrl: rel.html_url || `https://github.com/${repo}/releases`,
    prerelease: !!rel.prerelease,
    asset,
    assets,
    hasUpdate: cmpVer(rel.tag_name || rel.name, CURRENT_VERSION) > 0,
  }
}

// 主入口：force=true 时绕过 10 分钟缓存
export async function checkForUpdate({ force = false, repo = '' } = {}) {
  const cfg = readCfg()
  const target = String(repo || cfg.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
    return { ok: false, error: '仓库地址格式不对，应为 owner/repo', repo: target, current: CURRENT_VERSION }
  }
  const cache = cfg.last
  if (!force && cache && cache.repo === target && cache.data?.ok && Date.now() - (cache.at || 0) < CACHE_MS) {
    return cache.data
  }

  try {
    // 先取最新几个 Release，跳过草稿和预发布，拿第一个正式版
    let list
    try {
      list = await ghJson(`https://api.github.com/repos/${target}/releases?per_page=6`)
    } catch (e) {
      // 某些镜像 / 代理不支持列表接口，退回 latest
      if (!/404|403/.test(e.message)) throw e
      list = []
    }
    const rels = Array.isArray(list) ? list : []
    const rel = rels.find((r) => !r.draft && !r.prerelease) || rels[0]
      || await ghJson(`https://api.github.com/repos/${target}/releases/latest`)
    const data = normalizeRelease(rel, target)
    saveCfg({ last: { at: Date.now(), repo: target, data } })
    return data
  } catch (e) {
    return { ok: false, error: e.message, repo: target, current: CURRENT_VERSION }
  }
}

// 启动时静默检查：只在「有新版本」时返回结果，其余返回 null（不打扰用户）
export async function checkSilently() {
  const cfg = readCfg()
  if (!cfg.auto) return null
  const r = await checkForUpdate().catch(() => null)
  return r?.ok && r.hasUpdate ? r : null
}

// 最近 N 个正式版（用于「更新内容」查看）：跳过草稿 / 预发布，按发布时间倒序。
export async function recentReleases(n = 3, { force = false } = {}) {
  const cfg = readCfg()
  const target = String(cfg.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
    return { ok: false, error: '仓库地址格式不对，应为 owner/repo', releases: [] }
  }
  const cacheKey = `recent:${target}:${n}`
  const cache = cfg[cacheKey]
  if (!force && cache && Date.now() - (cache.at || 0) < CACHE_MS) return cache.data
  try {
    const list = await ghJson(`https://api.github.com/repos/${target}/releases?per_page=${Math.max(n, 6)}`)
    const rels = Array.isArray(list) ? list : []
    const official = rels.filter((r) => !r.draft && !r.prerelease)
    const picked = (official.length ? official : rels).slice(0, n).map((r) => ({
      version: String(r.tag_name || r.name || '').replace(/^v/i, ''),
      title: r.name || r.tag_name || '',
      notes: String(r.body || '').trim(),
      date: (r.published_at || '').slice(0, 10),
      url: r.html_url || `https://github.com/${target}/releases`,
    }))
    const data = { ok: true, releases: picked }
    saveCfg({ [cacheKey]: { at: Date.now(), data } })
    return data
  } catch (e) {
    return { ok: false, error: e.message, releases: [] }
  }
}

export const sizeText = (n) => (!n ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
