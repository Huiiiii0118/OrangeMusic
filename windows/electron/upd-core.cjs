/* 应用内一键自更新的共享核心：下载（Range 断点续传 + 重试）与替换助手脚本生成。
   main.cjs（Electron 主进程）与测试脚本 tools/test_upd_core.mjs 共用，保证「测的就是跑的」。 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

// 下载更新包到暂存目录。github.com 的 browser_download_url 会 302 到对象存储，手动跟随；
// 已有的 .part 按已收字节发 Range 接着下，最多重试 3 次；收满 expectedSize（若给了）才认成功。
async function downloadUpdate(url, expectedSize, destPath, onProgress) {
  const https = require('node:https')
  const http = require('node:http')
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const part = destPath + '.part'
  let received = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (expectedSize && received > expectedSize) {
    try { fs.unlinkSync(part) } catch { /* ignore */ }
    received = 0
  }
  const fetchOnce = (target) => new Promise((resolve, reject) => {
    const mod = target.startsWith('http:') ? http : https
    const req = mod.get(target, {
      headers: {
        'User-Agent': 'OrangeMusic-Updater',
        Accept: 'application/octet-stream',
        ...(received > 0 ? { Range: `bytes=${received}-` } : {}),
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, target).toString()
        fetchOnce(next).then(resolve, reject)
        return
      }
      if (res.statusCode >= 400) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
      const resumed = received > 0 && res.statusCode === 206
      const total = expectedSize || (Number(res.headers['content-length']) || 0) + (resumed ? received : 0)
      const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })
      if (!resumed && received > 0) received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (total && received > total) { out.destroy(); res.destroy(); reject(new Error('下载超出预期大小')); return }
        try { onProgress?.(received, total) } catch { /* 回调炸了不影响下载 */ }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve({ received, total })))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('连接超时')))
  })
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { received: got } = await fetchOnce(url)
      if (expectedSize && got !== expectedSize) throw new Error(`下载不完整（${got}/${expectedSize}）`)
      fs.renameSync(part, destPath)
      return { ok: true, path: destPath, size: got }
    } catch (e) {
      lastErr = e
      received = fs.existsSync(part) ? fs.statSync(part).size : 0
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  return { ok: false, error: lastErr?.message || '下载失败' }
}

// 生成替换助手的 PowerShell 脚本（经 -EncodedCommand 执行，规避 bat 的中文路径编码坑）：
// 等内层 PID 退出（壳文件此时才真正解锁）→ 备份旧壳(.old) → 换上新壳 → 启动新壳 →
// 任何失败回滚旧壳并启动旧版，结果写进 resultPath（ok / fail: 原因），内层下次启动读给用户。
function buildHelperScript({ launcherPath, stagedPath, resultPath, pid }) {
  const esc = (s) => String(s).replace(/'/g, "''")
  return [
    `$ErrorActionPreference='Stop'`,
    `$old='${esc(launcherPath)}'`,
    `$new='${esc(stagedPath)}'`,
    `$result='${esc(resultPath)}'`,
    `$target=${pid}`,
    `for($i=0;$i -lt 120;$i++){ if(-not (Get-Process -Id $target -ErrorAction SilentlyContinue)){ break }; Start-Sleep -Milliseconds 500 }`,
    `$bak="$old.old"`,
    `try{`,
    `  if(Test-Path $bak){ Remove-Item $bak -Force }`,
    `  Move-Item $old $bak -Force`,
    `  Move-Item $new $old -Force`,
    `  Start-Process -FilePath $old`,
    `  Set-Content -Path $result -Value 'ok'`,
    `}catch{`,
    `  try{ if((Test-Path $bak) -and -not (Test-Path $old)){ Move-Item $bak $old -Force }; if(Test-Path $old){ Start-Process -FilePath $old -ErrorAction SilentlyContinue } }catch{}`,
    `  Set-Content -Path $result -Value ('fail: ' + $_.Exception.Message)`,
    `}`,
  ].join('\n')
}

const buildHelperCommand = (opts) => {
  const enc = Buffer.from(buildHelperScript(opts), 'utf16le').toString('base64')
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc] }
}

module.exports = { downloadUpdate, buildHelperScript, buildHelperCommand }
