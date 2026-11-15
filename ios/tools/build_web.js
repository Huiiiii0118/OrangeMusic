#!/usr/bin/env node
/* 从 shared/（唯一真源）组装可独立部署的静态站点。
   iOS 网页版 → ios/www；Windows exe 内嵌站点 → windows/sea/www。
   两端产物除 platform 标记外完全一致，非 UI 逻辑天然同步。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = path.join(ROOT, 'shared')

const copyFile = (src, dst) => {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel]
  })
}

export function buildSite({ out, platform = 'ios' }) {
  const target = path.resolve(ROOT, out)
  if (target === ROOT || !target.startsWith(ROOT + path.sep)) throw new Error('输出目录必须位于项目内')
  // 覆盖写入而非递归删除：预览服务可能正以该目录为工作目录，删除会被占用拦截。
  fs.mkdirSync(target, { recursive: true })
  const written = new Set()

  // 业务层原样镜像：app.js 的 ../core、../protocol 相对路径保持有效。
  for (const d of ['config', 'protocol', 'core', 'ui', 'vendor']) {
    for (const rel of walk(path.join(SHARED, d))) {
      copyFile(path.join(SHARED, d, rel), path.join(target, d, rel))
      written.add(`${d}/${rel}`)
    }
  }
  // PWA 资源放到站点根（manifest / sw / 图标）。
  for (const f of walk(path.join(SHARED, 'pwa'))) {
    copyFile(path.join(SHARED, 'pwa', f), path.join(target, f))
    written.add(f)
  }

  // 根入口：资源路径改到 ./ui/，并按端注入唯一不同的视觉主题。
  const theme = platform === 'windows' ? 'macos' : 'ios'
  const accent = theme === 'macos' ? '#e8620a' : '#f2660a'
  let html = fs.readFileSync(path.join(SHARED, 'ui', 'index.html'), 'utf8')
  html = html.replace('href="./tokens.css"', 'href="./ui/tokens.css"')
             .replace('href="./app.css"', 'href="./ui/app.css"')
             .replace('src="./app.js"', 'src="./ui/app.js"')
             .replace(/<!-- THEME_STYLE_SLOT[^>]*-->/, `<link rel="stylesheet" href="./ui/theme-${theme}.css">`)
             .replace(/<meta name="theme-color" content="[^"]*">/, `<meta name="theme-color" content="${accent}">`)
             .replace('<html lang="zh-CN">', `<html lang="zh-CN" data-platform="${platform}" data-theme="${theme}">`)
  fs.writeFileSync(path.join(target, 'index.html'), html)
  written.add('index.html')

  // manifest 的主题色与端一致（iOS 添加到主屏幕后的状态栏色调）。
  const manifestPath = path.join(target, 'manifest.webmanifest')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.theme_color = accent
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // iOS：把同源 API 服务一起打进产物，让 www/ 能以「单端口 Node 应用」发布。
  // 只带 server.js（零依赖：node:http + 全局 fetch）；内置引擎缺失时会自动降级到
  // 酷我/网易云双源取链。若只发静态文件，/api/* 全部 404 → 推荐/封面/歌单
  // 永远停在「正在取…」。必须 add 进 written，否则下面清理旧文件时会被删掉。
  if (platform === 'ios') {
    const srv = path.join(ROOT, 'server.js')
    if (fs.existsSync(srv)) {
      copyFile(srv, path.join(target, 'server.js'))
      written.add('server.js')
    }
    const pkg = {
      name: 'orange-music-ios',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'server.js',
      scripts: { start: 'node server.js' },
    }
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    written.add('package.json')
  }

  // 清掉上一版留下、这一版已经删除的文件（例如旧的 LX 音源模块）。
  // 只删除「构建产物里不该存在」的单个文件，不递归删目录，避免被预览服务占用。
  for (const rel of walk(target)) {
    if (!written.has(rel)) {
      try { fs.rmSync(path.join(target, rel), { force: true }) } catch { /* 被占用就跳过 */ }
    }
  }

  const files = walk(target).sort()
  const missing = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-180.png', 'logo.png', 'ui/app.js',
    'ui/theme-ios.css', 'ui/theme-macos.css', 'core/cloud.js', 'core/sources.js',
    'core/charts.js', 'core/chart-tracks.js', 'core/discover.js', 'core/genre-pool.js',
    'core/official.js', 'core/identity.js', 'core/cover-clean.js', 'core/lyrics.js',
    'core/engine/client.js', 'core/engine/index.js', 'core/engine/OrangeKugou.js',
    'core/engine/OrangeMusicApi.js', 'core/engine/OrangeBodian.js']
    .filter((f) => !files.includes(f))
  if (missing.length) throw new Error(`站点缺少文件：${missing.join(', ')}`)
  return { out: target, platform, files }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const get = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  const { out, files } = buildSite({ out: get('--out', 'ios/www'), platform: get('--platform', 'ios') })
  console.log(`OK ${out} · ${files.length} 个文件`)
}
