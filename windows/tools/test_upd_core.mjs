/* upd-core.cjs 端到端测试：
   1) helper 替换链路：占位进程退出 → 备份旧壳(.old) → 换上新壳 → 启动新壳 → result=ok
   2) 真实下载：GitHub Release asset（122MB）→ 大小校验
   用法：node tools/test_upd_core.mjs helper | download
   （下载测试受网络影响，跑一次校验即可；产物放 %TEMP% 下的 om-upd-test/，测试完可删） */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { downloadUpdate, buildHelperCommand } = require('../electron/upd-core.cjs')

const TMP = path.join(os.tmpdir(), 'om-upd-test')
fs.mkdirSync(TMP, { recursive: true })
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function testHelper() {
  const launcher = path.join(TMP, 'fake-shell.exe')
  const staged = path.join(TMP, 'OrangeMusic-update.exe')
  const result = path.join(TMP, 'update-result.txt')
  const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe')
  fs.copyFileSync(notepad, launcher)
  fs.copyFileSync(notepad, staged)
  // 模拟"新包"内容不同：往 staged 尾部追加一段，哈希即可区分
  fs.appendFileSync(staged, 'om-update-payload')
  const hashOld = sha256(launcher)
  const hashNew = sha256(staged)
  // 占位进程：模拟"正在运行的内层"。helper 必须等它退出后才动手。
  const placeholder = spawn('ping', ['-n', '3', '127.0.0.1'], { stdio: 'ignore' })
  try { fs.unlinkSync(result) } catch { /* ignore */ }
  const { file, args } = buildHelperCommand({ launcherPath: launcher, stagedPath: staged, resultPath: result, pid: placeholder.pid })
  spawn(file, args, { stdio: 'ignore', windowsHide: true })
  // 轮询结果（最多 30 秒）
  let res = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try { res = fs.readFileSync(result, 'utf8').trim() } catch { continue }
    if (res) break
  }
  const replaced = fs.existsSync(launcher) && sha256(launcher) === hashNew
  const backup = path.join(TMP, 'fake-shell.exe.old')
  const backedUp = fs.existsSync(backup) && sha256(backup) === hashOld
  // 清理被启动的记事本
  spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
  console.log('helper result:', res || '(no result)')
  console.log('replaced(new hash):', replaced)
  console.log('backup(old hash):', backedUp)
  const ok = res === 'ok' && replaced && backedUp
  console.log(ok ? 'HELPER TEST PASS' : 'HELPER TEST FAIL')
  process.exit(ok ? 0 : 1)
}

async function testDownload() {
  // 从 GitHub API 拿 v1.0.1 的 asset 直链与大小（匿名 1 次调用，不超限）
  const api = await fetch('https://api.github.com/repos/Huiiiii0118/OrangeMusic/releases/tags/v1.0.1', {
    headers: { 'User-Agent': 'OrangeMusic-Updater', Accept: 'application/vnd.github+json' },
  })
  const rel = await api.json()
  const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name))
  if (!asset) { console.log('DOWNLOAD TEST SKIP: no asset'); process.exit(0) }
  const dest = path.join(TMP, 'download-test.exe')
  try { fs.unlinkSync(dest) } catch { /* ignore */ }
  try { fs.unlinkSync(dest + '.part') } catch { /* ignore */ }
  console.log('asset:', asset.name, (asset.size / 1048576).toFixed(1) + 'MB')
  const t0 = Date.now()
  let lastPct = -1
  const r = await downloadUpdate(asset.browser_download_url, asset.size, dest, (got, total) => {
    const pct = Math.round((got * 100) / total)
    if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; console.log(`  ${pct}%`) }
  })
  const sizeOk = r.ok && fs.statSync(dest).size === asset.size
  console.log('result:', JSON.stringify({ ok: r.ok, size: r.size, error: r.error }))
  console.log('elapsed:', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  console.log(sizeOk ? 'DOWNLOAD TEST PASS' : 'DOWNLOAD TEST FAIL')
  // 清理 122MB 临时产物
  try { fs.unlinkSync(dest) } catch { /* ignore */ }
  process.exit(sizeOk ? 0 : 1)
}

const mode = process.argv[2] || 'helper'
;(mode === 'download' ? testDownload() : testHelper()).catch((e) => { console.error('FATAL', e); process.exit(1) })
