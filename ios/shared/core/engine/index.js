// 兜底音源引擎（v1.9 之后的唯一一套）：
//   · 主取链：波点（UNM bodian，按「歌名+歌手」直接拿完整链，见 local-api.cjs）——不在这里。
//   · 主搜索/解灰：Windows 内置 api-enhanced，走 localapi://，见 client.js。
//   · 这里只保留「酷狗公开接口」作为跨平台兜底：搜索质量高、免费曲能直接取链。
// 已删除的旧路线（weapi 加密直连 / QQ 免费 sign / 第三方脚本抓取）不再保留：
// 它们的搜索会被限流、取链已全面失效，留着只会拖慢每一次点歌。
import { createKugou } from './OrangeKugou.js'

export function createEngine(request) {
  const kg = createKugou(request)
  return { search: kg.search, resolve: kg.resolve, lyric: kg.lyric, kugou: kg }
}

export { createKugou }
