// 品牌更名兼容：旧版本地数据用 quietmusic: 前缀，新版用 orangemusic:。
// 用户升级后收藏、自建歌单、最近播放、设置、榜单/封面缓存都不能丢，所以在这里做一次性迁移。
// 本模块由 bridge.js 顶部静态引入，保证在任何 core 模块（repo / chart-tracks / covers…）
// 读取 localStorage 之前执行；只复制，不删除旧数据，出问题还能回退。
const OLD = 'quietmusic:'
const NEW = 'orangemusic:'
const FLAG = 'orangemusic:migrated:v1'

try {
  const ls = globalThis.localStorage
  if (ls && !ls.getItem(FLAG)) {
    const legacy = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k && k.startsWith(OLD)) legacy.push(k)
    }
    let moved = 0
    for (const k of legacy) {
      const nk = NEW + k.slice(OLD.length)
      // 新版已经写过同名的 key 就以新版为准，不覆盖用户新产生的数据
      if (ls.getItem(nk) !== null) continue
      try { ls.setItem(nk, ls.getItem(k) || ''); moved += 1 } catch { /* 配额满：跳过这一项 */ }
    }
    try { ls.setItem(FLAG, String(Date.now())) } catch { /* noop */ }
    if (moved) console.info(`[Orange Music] 已迁移旧版本地数据 ${moved} 项`)
  }
} catch { /* 隐私模式 / 非浏览器环境 */ }
