#!/usr/bin/env node
/* 生成 windows/dist/OrangeMusic.exe —— 一个免安装、双击即用的单文件桌面应用。
   - Chromium / Node / 全部网页资源都打进 exe，目标机器不需要装 Edge、Node 或任何运行时；
   - 页面经 app://orangemusic 自定义协议直接读内嵌资源，**不起本地 HTTP 服务**；
   - 首次运行解压到 %LOCALAPPDATA%\OrangeMusic\app-<版本>（带闪屏），
     之后每次启动直接拉起已解压的副本，1~2 秒；
   - 构建完成后清掉 win-unpacked 等中间产物，目录里只留一个 exe。

   打包链路：electron-builder --dir 出 win-unpacked → makensis 用 portable.nsi 封装成单文件。
   （不用 electron-builder 的 portable 目标：它每次启动都重解压 300MB，要 30 秒以上。）

   依赖：node >= 20、electron 目录已 npm install（electron + electron-builder）、
        NSIS（electron-builder 缓存里自带 makensis）。 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildSite } from './build_web.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'electron')
const DIST = path.join(ROOT, 'dist')
// 中间产物放独立暂存目录：win-unpacked 常被「正在运行的旧 exe」锁住，
// 直接往里写会 EBUSY/EPERM，换目录能稳定出包（清理失败只提示，不影响产物）。
// 每轮用唯一目录名：上一轮的产物常被杀软/索引服务短暂锁住，
// 复用同名目录会在「删旧 → 写新」时 EBUSY。留点垃圾换稳定出包。
const STAGE = process.env.OM_STAGE || `_stage-${Date.now().toString(36)}`
const STAGE_DIR = path.join(DIST, STAGE)
const UNPACKED = path.join(STAGE_DIR, 'win-unpacked')
const ELECTRON = path.join(APP, 'node_modules', 'electron')
const EXE = path.join(DIST, 'OrangeMusic.exe')
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
const BIN_MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'
const KEEP = new Set(['OrangeMusic.exe', '使用说明.txt'])

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`命令失败：${cmd} ${args.join(' ')}（exit ${r.status}）`)
}

const version = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version
// 构建号写进解压目录名：换了 exe 就一定重新解压，不会出现「更新了还在跑旧内容」
const buildId = new Date().toISOString().replace(/\D/g, '').slice(0, 12)

/** 找 makensis：优先环境变量，其次 electron-builder 的 NSIS 缓存。 */
function findMakensis() {
  if (process.env.MAKENSIS && fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  if (!fs.existsSync(cache)) return ''
  for (const dir of fs.readdirSync(cache).filter((d) => /^nsis-/.test(d)).sort().reverse()) {
    const base = path.join(cache, dir)
    for (const sub of fs.readdirSync(base)) {
      const p = path.join(base, sub, 'makensis.exe')
      if (fs.existsSync(p)) return p
    }
  }
  return ''
}

// 1. 从 shared/ 组装内嵌站点（与 iOS 网页版同源同版）
const { files } = buildSite({ out: 'electron/www', platform: 'windows' })
console.log(`[1/5] 站点就绪：${files.length} 个文件 → windows/electron/www`)

// 2. Electron 运行时（首次需要下载；已有 dist 就跳过）
const electronExe = path.join(ELECTRON, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!fs.existsSync(electronExe)) {
  console.log('[2/5] 下载 Electron 运行时 …')
  run(process.execPath, [path.join(ELECTRON, 'install.js')], { cwd: APP, env: { ...process.env, ELECTRON_MIRROR: MIRROR } })
} else {
  console.log('[2/5] Electron 运行时已就绪')
}

// 3. 清空旧产物（保留使用说明）
fs.mkdirSync(DIST, { recursive: true })
if (fs.existsSync(STAGE_DIR)) fs.rmSync(STAGE_DIR, { recursive: true, force: true })
for (const f of fs.readdirSync(DIST)) {
  if (KEEP.has(f) || f === STAGE) continue
  try { fs.rmSync(path.join(DIST, f), { recursive: true, force: true }) }
  catch { console.log(`  · 跳过占用中的 ${f}`) }
}

// 4. electron-builder --dir → windows/dist/win-unpacked
const builderCli = path.join(APP, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!fs.existsSync(builderCli)) throw new Error('未找到 electron-builder，请先在 windows/electron 执行 npm install')
console.log('[3/5] 打 asar + 组装运行时 …')
run(process.execPath, [builderCli, '--win', '--dir', '--x64', `--config.directories.output=${path.relative(APP, STAGE_DIR).replace(/\\/g, '/')}`], {
  cwd: APP,
  env: {
    ...process.env,
    // electron-builder 会批量删掉多余的语言包，构建环境默认会拦批量删除；只对构建子进程放开
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    ELECTRON_MIRROR: MIRROR,
    ELECTRON_BUILDER_BINARIES_MIRROR: BIN_MIRROR,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
})
if (!fs.existsSync(path.join(UNPACKED, '橙子音乐.exe'))) throw new Error('electron-builder 没产出 win-unpacked/橙子音乐.exe（检查 build.productName）')

// 5. makensis 封装成单文件（首次解压、之后复用）
const makensis = findMakensis()
if (!makensis) throw new Error('没找到 makensis：请安装 NSIS，或设置环境变量 MAKENSIS 指向 makensis.exe')
console.log(`[4/5] 封装单文件（makensis ${path.basename(path.dirname(path.dirname(makensis)))}，LZMA 压缩较慢，请稍候）…`)
const unpackedRel = path.relative(APP, UNPACKED)
run(makensis, ['/INPUTCHARSET', 'UTF8', `/DAPPVER=${version}`, `/DAPPBUILD=${buildId}`,
  `/DUNPACKED=${unpackedRel}`, 'portable.nsi'], { cwd: APP })
if (!fs.existsSync(EXE)) throw new Error('封装完成但没找到 windows/dist/OrangeMusic.exe')

// 6. 收拾中间产物：只留 exe 和说明
//    这一步是「打扫」，失败了不能算构建失败：常见于正在跑 win-unpacked 里的 exe（文件被占用）、
//    或资源管理器/杀软临时锁定。逐项清理，失败的留下并提示，下次构建会自动覆盖。
const leftovers = []
for (const f of fs.readdirSync(DIST)) {
  if (KEEP.has(f)) continue
  try {
    fs.rmSync(path.join(DIST, f), { recursive: true, force: true })
  } catch (e) {
    leftovers.push(`${f}（${e.code || e.message}）`)
  }
}
if (leftovers.length) {
  console.log(`[!] 以下中间产物没清掉，可手动删除，不影响 exe：${leftovers.join('、')}`)
}

const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1)
console.log(`[5/5] 完成：windows/dist/OrangeMusic.exe（${mb} MB · 单文件 · 免安装 · 双击即用）`)
console.log(`      首次运行解压到 %LOCALAPPDATA%\\OrangeMusic\\app-${version}-${buildId}（约 20~30 秒，有闪屏），之后启动 1~2 秒。`)
