/* 网络代发（Electron 主进程）：把浏览器的跨域请求交给 Node 的 http/https 发出去。
   页面里的 native.request 会先直连，失败后 POST app://orangemusic/api/net，由这里代发。
   与旧 SEA 版本逻辑一致：支持 http_proxy/https_proxy（CONNECT 隧道）+ 基础 SSRF 防护。 */
'use strict'
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')

const isPrivateHost = (h) => {
  const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  return x === 'localhost' || x === '127.0.0.1' || x === '::1' || x === '0.0.0.0' ||
    /^10\./.test(x) || /^192\.168\./.test(x) || /^172\.(1[6-9]|2\d|3[01])\./.test(x) ||
    /^169\.254\./.test(x) || x.endsWith('.local') || x.endsWith('.internal')
}

function envProxy(u) {
  const raw = u.protocol === 'https:'
    ? (process.env.https_proxy || process.env.HTTPS_PROXY)
    : (process.env.http_proxy || process.env.HTTP_PROXY)
  if (!raw) return null
  try { const p = new URL(raw); return p.protocol.startsWith('http') ? p : null } catch { return null }
}

function connectTunnel(p, u) {
  return new Promise((resolve, reject) => {
    const authority = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`
    const headers = { Host: authority }
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
    const r = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: authority, headers })
    r.on('connect', (res, socket) => res.statusCode === 200 ? resolve(socket) : (socket.destroy(), reject(new Error(`代理 CONNECT ${res.statusCode}`))))
    r.on('error', reject)
    r.setTimeout(10000, () => r.destroy(new Error('代理连接超时')))
    r.end()
  })
}

async function rawRequest(url, init, redirects = 0) {
  let u
  try { u = new URL(url) } catch { throw new Error('无效 URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (isPrivateHost(u.hostname) && (process.env.OM_ALLOW_PRIVATE || process.env.QM_ALLOW_PRIVATE) !== '1') throw new Error('默认禁止代发内网地址')

  const headers = { ...(init.headers || {}) }
  for (const k of Object.keys(headers)) if (['host', 'content-length', 'accept-encoding'].includes(k.toLowerCase())) delete headers[k]
  headers['Accept-Encoding'] = 'identity'
  const body = init.body
  if (body != null) headers['Content-Length'] = Buffer.byteLength(body)

  const p = envProxy(u)
  const opts = { method: init.method, headers }
  let request
  if (p && u.protocol === 'https:') {
    const socket = await connectTunnel(p, u)
    request = (cb) => https.request(u, { ...opts, agent: false, createConnection: () => tls.connect({ socket, servername: u.hostname }) }, cb)
  } else if (p && u.protocol === 'http:') {
    headers.Host = u.host
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
    request = (cb) => http.request({ hostname: p.hostname, port: Number(p.port) || 80, path: u.href, method: init.method, headers }, cb)
  } else {
    request = (cb) => (u.protocol === 'https:' ? https : http).request(u, opts, cb)
  }

  return new Promise((resolve, reject) => {
    const r = request((resp) => {
      const code = resp.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(code) && resp.headers.location && redirects < 5) {
        resp.resume()
        return resolve(rawRequest(new URL(resp.headers.location, u).href,
          { ...init, method: code === 303 ? 'GET' : init.method, body: code === 303 ? undefined : body }, redirects + 1))
      }
      // 只要响应头（解析直链用）：拿到最终地址就断开，不下载音频
      if (init.headersOnly) {
        const headers = resp.headers
        resp.destroy()
        return resolve({ statusCode: code, headers, buf: Buffer.alloc(0), finalUrl: u.href })
      }
      const parts = []; let n = 0
      resp.on('data', (c) => { n += c.length; if (n > 8 * 1024 * 1024) return r.destroy(new Error('响应过大（>8MB）')); parts.push(c) })
      resp.on('end', () => resolve({ statusCode: code, headers: resp.headers, buf: Buffer.concat(parts), finalUrl: u.href }))
      resp.on('error', reject)
    })
    r.setTimeout(init.timeout || 12000, () => r.destroy(new Error('请求超时')))
    r.on('error', reject)
    if (body != null) r.write(body)
    r.end()
  })
}

/** 解析音频直链：跟随 302 拿到 CDN 真实地址（页面是 secure 上下文，http 会被当混合内容拦掉）。
 *  返回 { url, statusCode, type, ok }；url 一律换成 https（各平台 CDN 均支持）。 */
async function resolveMediaUrl(url, timeout = 8000) {
  const src = String(url || '')
  if (!/^https?:\/\//i.test(src)) throw new Error('无效 URL')
  let out
  try {
    out = await rawRequest(src, { method: 'GET', headers: { Range: 'bytes=0-1' }, headersOnly: true, timeout })
  } catch (e) {
    // 有些 CDN 不认 Range，退回普通 GET（仍然只读响应头）
    out = await rawRequest(src, { method: 'GET', headersOnly: true, timeout })
  }
  const h = out.headers || {}
  const type = String(h['content-type'] || '')
  const final = String(out.finalUrl || src).replace(/^http:/i, 'https:')
  return {
    url: final,
    statusCode: out.statusCode,
    type,
    // ok 只判「拿到的是音频」：部分 CDN 对 Range 请求回 206
    ok: out.statusCode >= 200 && out.statusCode < 400 && (!type || /audio|octet-stream|mpeg/i.test(type)),
  }
}

// 与旧 /api/net 完全一致的入参出参：{ url, options, timeout } → { statusCode, headers, bodyRaw }
async function proxyNet(url, o = {}, timeout) {
  let u
  try { u = new URL(String(url)) } catch { throw new Error('无效 URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (isPrivateHost(u.hostname) && (process.env.OM_ALLOW_PRIVATE || process.env.QM_ALLOW_PRIVATE) !== '1') throw new Error('默认禁止代发内网地址')

  const method = String(o.method || 'GET').toUpperCase()
  const headers = { ...(o.headers || {}) }
  let body
  if (o.body != null) {
    if (typeof o.body === 'string') body = o.body
    else {
      body = JSON.stringify(o.body)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    }
  } else if (o.form) {
    body = new URLSearchParams(o.form).toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  const ms = Math.min(Math.max(Number(timeout) || 12000, 1000), 30000)
  const r = await rawRequest(u.href, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, timeout: ms })
  const h = {}
  for (const [k, v] of Object.entries(r.headers)) h[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
  return { statusCode: r.statusCode, headers: h, bodyRaw: r.buf.toString('utf8') }
}

// 取回图片二进制并转 base64 dataURL：供渲染进程用 Canvas 抹掉封面角落的平台 logo / 播放量水印。
// 第三方 CDN 图片跨域无法在渲染进程 getImageData（会污染 canvas），必须走主进程拿原始字节。
// 仍走 rawRequest 的 SSRF 防护与超时，只接受 image/*，限制 2MB，避免被当任意文件读取通道。
async function fetchImageBase64(url, timeout = 8000) {
  let u
  try { u = new URL(String(url)) } catch { throw new Error('无效 URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (isPrivateHost(u.hostname) && (process.env.OM_ALLOW_PRIVATE || process.env.QM_ALLOW_PRIVATE) !== '1') throw new Error('禁止访问内网')
  const r = await rawRequest(u.href, {
    method: 'GET', timeout: Math.min(Math.max(Number(timeout) || 8000, 1000), 15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', Referer: `${u.protocol}//${u.host}/` },
  })
  if (r.statusCode < 200 || r.statusCode >= 400) throw new Error(`HTTP ${r.statusCode}`)
  const type = String(r.headers['content-type'] || r.headers['Content-Type'] || '')
  if (!/^image\//i.test(type)) throw new Error('非图片：' + type)
  if (r.buf.length > 2 * 1024 * 1024) throw new Error('图片过大（>2MB）')
  return `data:${type.split(';')[0]};base64,${r.buf.toString('base64')}`
}

module.exports = { proxyNet, resolveMediaUrl, fetchImageBase64 }
