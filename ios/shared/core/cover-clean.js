// 封面角标清洗：只抹掉「其它音乐平台叠在封面角上的 logo / 水印」，
// 并且**自动识别**——没检测到平台角标的封面一律原样保留，绝不裁切。
//
// 为什么不在 CSS 直接裁：logo 实测并不贴边（距边约 4%、直径约 9%），
// 纯 CSS 要切到 15% 才够，会毁掉大量正常画面。这里做像素级抹除，只动真正的角标。
//
// 跨域：第三方 CDN 图片在渲染进程 <img> 里 getImageData 会污染 canvas，
// 所以先由 Electron 主进程把图片原始字节取回成 dataURL（native.fetchImage），
// dataURL 与页面同源、不污染 canvas，才能读像素。纯网页（iOS）没宿主 → 返回 null。
//
// 检测（自动判断，宁可漏删也不误伤）：只有当角落出现「紧凑 + 致密 + 扁平色」的
// 孤立小块（典型平台 logo / 水印形态）时才判定有角标；整片纹理 / 亮斑的画面
// 不满足「紧凑致密」，自动跳过，不做任何裁切。抹除时只填角标自身的紧致包围盒，
// 不碰周围正常画面 —— 解决「封面裁切过多」。
import { native } from '../protocol/bridge.js'

const SIZE = 256                  // 处理尺寸（封面通常 200~500，缩到 256 足够且快）
const CORNER = 0.18               // 每角「扫描」18% 见方找 logo（但只抹 logo 本身）
const OUTLIER = 62                // 像素显著偏离角落中值亮度才算「标记像素」
const MIN_MARK = 22               // 标记像素太少（碎点 / 噪点）不算 logo
const MAX_MARK_RATIO = 0.35       // 标记超过角块 35% 大概率是画面而非 logo
const COMPACT_MAX = 0.55          // 紧凑：包围盒占角块 <55%
const DENSE_MIN = 0.32            // 致密：包围盒内标记像素占比 >=32%
const COLOR_STD_MAX = 64          // 扁平色：logo 颜色集中，画面亮斑颜色分散
const MAX_ENTRIES = 120           // 内存缓存上限
const TTL = 7 * 86400000          // 清洗结果缓存 7 天（同一封面 URL 不变）

const mem = new Map()             // url -> { dataUrl, at, cleaned }
let enabled = null

/** 封面去角标：已内置默认执行（设置页不再提供开关），始终开启。 */
export function isCleanEnabled() {
  return true
}
export function setCleanEnabled(on) {
  if (!on) mem.clear()
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

// 用「内侧相邻边缘」逐行镜像填充一个矩形，保留背景色渐变，不留突兀纯色块。
// dirX=-1 表示左侧角（向右取参照列）+1 右侧角；dirY=-1 上角 +1 下角。
function fillCorner(data, w, h, x0, y0, bw, bh, dirX, dirY) {
  const idx = (x, y) => ((y * w + x) << 2)
  const edgeX = dirX < 0 ? x0 + bw : x0 - 1      // 紧贴矩形的内侧列
  const edgeY = dirY < 0 ? y0 + bh : y0 - 1      // 紧贴矩形的内侧行
  for (let y = y0; y < y0 + bh; y++) {
    const sy = dirY < 0 ? Math.min(h - 1, edgeY + (y - y0)) : Math.max(0, edgeY - (y0 + bh - 1 - y))
    for (let x = x0; x < x0 + bw; x++) {
      const sx = dirX < 0 ? Math.min(w - 1, edgeX + (x - x0)) : Math.max(0, edgeX - (x0 + bw - 1 - x))
      const px = Math.max(0, Math.min(w - 1, sx))
      const py = Math.max(0, Math.min(h - 1, sy))
      const s = idx(px, py), d = idx(x, y)
      data[d] = data[s]; data[d + 1] = data[s + 1]; data[d + 2] = data[s + 2]; data[d + 3] = 255
    }
  }
}

/**
 * 自动识别「角落里的平台角标 / 水印」：必须是紧凑 + 致密 + 扁平色的孤立小块。
 * 返回紧致包围盒 { x, y, w, h }（绝对坐标）；判定不是 logo 返回 null（调用方原样跳过）。
 */
function detectLogoBlock(data, w, h, x0, y0, bw, bh) {
  const idx = (x, y) => ((y * w + x) << 2)
  // 角块亮度中值作背景（logo 是少数像素，中值≈画面背景）
  const lums = []
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = idx(x0 + x, y0 + y)
      lums.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)
    }
  lums.sort((a, b) => a - b)
  const bg = lums[lums.length >> 1]

  // 标记像素：显著偏离背景亮度（logo / 水印通常比画面亮很多或暗很多）
  const mark = new Uint8Array(bw * bh)
  let count = 0, minX = bw, minY = bh, maxX = 0, maxY = 0, sR = 0, sG = 0, sB = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = idx(x0 + x, y0 + y)
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
      if (Math.abs(lum - bg) > OUTLIER) {
        mark[y * bw + x] = 1
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        sR += data[i]; sG += data[i + 1]; sB += data[i + 2]
      }
    }
  }

  const total = bw * bh
  if (count < MIN_MARK || count > total * MAX_MARK_RATIO) return null
  const bwBox = maxX - minX + 1, bhBox = maxY - minY + 1
  const bboxArea = bwBox * bhBox
  if (bboxArea > total * COMPACT_MAX) return null            // 太散 = 画面纹理，不是 logo
  if (count / bboxArea < DENSE_MIN) return null              // 框内稀疏 = 不是实体 logo

  // 扁平色：logo / 水印颜色集中；画面亮斑颜色分散
  const mr = sR / count, mg = sG / count, mb = sB / count
  let v = 0
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++)
      if (mark[y * bw + x]) {
        const i = idx(x0 + x, y0 + y)
        v += (data[i] - mr) ** 2 + (data[i + 1] - mg) ** 2 + (data[i + 2] - mb) ** 2
      }
  const colorStd = Math.sqrt(v / (count * 3))
  if (colorStd > COLOR_STD_MAX) return null                  // 颜色发散 = 画面，不是扁平 logo

  // 紧致包围盒 + 2px 余量 = 只抹 logo 本身，不碰周围画面
  const pad = 2
  const bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad)
  return {
    x: x0 + bx,
    y: y0 + by,
    w: Math.min(bw - bx, bwBox + pad * 2),
    h: Math.min(bh - by, bhBox + pad * 2),
  }
}

async function cleanDataUrl(dataUrl) {
  const img = await loadImage(dataUrl)
  const w = SIZE
  const h = Math.max(1, Math.round(SIZE * (img.naturalHeight / img.naturalWidth)))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  let image
  try { image = ctx.getImageData(0, 0, w, h) } catch { return null }   // 理论上不会（同源 dataURL）
  const bw = Math.max(12, Math.round(w * CORNER))
  const bh = Math.max(12, Math.round(h * CORNER))
  const data = image.data
  let cleaned = 0

  const corners = [
    { x: 0, y: 0, dx: -1, dy: -1 },                       // 左上
    { x: w - bw, y: 0, dx: 1, dy: -1 },                   // 右上
    { x: 0, y: h - bh, dx: -1, dy: 1 },                   // 左下
    { x: w - bw, y: h - bh, dx: 1, dy: 1 },               // 右下
  ]
  for (const c of corners) {
    const box = detectLogoBlock(data, w, h, c.x, c.y, bw, bh)
    if (box) {
      fillCorner(data, w, h, box.x, box.y, box.w, box.h, c.dx, c.dy)   // 只抹 logo 包围盒
      cleaned++
    }
  }
  if (!cleaned) return { dataUrl, cleaned: 0 }             // 无平台角标：原图原样返回，绝不裁切
  ctx.putImageData(image, 0, 0)
  try { return { dataUrl: cv.toDataURL('image/jpeg', 0.9), cleaned } } catch { return { dataUrl, cleaned: 0 } }
}

/**
 * 清洗一张封面。成功返回 dataURL（可能是原图，表示没检测到角标）；
 * 不可用 / 失败返回 null，调用方继续用原始 <img src>，不受影响。
 */
export async function cleanCover(url) {
  if (!url || !/^https?:\/\//i.test(String(url))) return null
  if (!isCleanEnabled()) return null
  const hit = mem.get(url)
  if (hit && Date.now() - hit.at < TTL) return hit.dataUrl
  try {
    const dataUrl = await native.fetchImage(url, 8000)
    if (!dataUrl) { mem.set(url, { dataUrl: null, at: Date.now() }); return null }
    const out = await cleanDataUrl(dataUrl)
    const result = out?.dataUrl || null
    if (mem.size >= MAX_ENTRIES) {
      const oldest = [...mem.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) mem.delete(oldest[0])
    }
    mem.set(url, { dataUrl: result, at: Date.now(), cleaned: out?.cleaned || 0 })
    return result
  } catch { return null }
}

export const coverCleanInfo = () => ({ enabled: isCleanEnabled(), entries: mem.size, cleaned: [...mem.values()].filter((x) => x.cleaned > 0).length })
