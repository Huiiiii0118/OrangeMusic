// 所有非 UI 数据结构的唯一定义。双端 WebView / 网页加载同一个 shared/，天然同步。
export const ADS_ENABLED = false            // 硬开关：零广告位、零追踪 SDK、零遥测
export const TRACKING_ENABLED = false

// 板块与 QQ 音乐对齐：首页 / 乐馆 / 搜索 / 我的 / 播放页。
export const SECTIONS = Object.freeze([
  { id: 'home', label: '首页', icon: '⌂' },
  { id: 'hall', label: '乐馆', icon: '♫' },
  { id: 'search', label: '搜索', icon: '⌕' },
  { id: 'library', label: '我的', icon: '♥' },
  { id: 'settings', label: '设置', icon: '⚙' },   // 只在侧栏出现，不占底部 Tab
  { id: 'player', label: '播放页', icon: '▶' },   // 全屏页，不进主导航
])

export const HALL_TABS = Object.freeze(['歌单广场', '歌手', '专辑', '电台'])
export const LIBRARY_TABS = Object.freeze(['总览', '我喜欢', '最近播放', '自建歌单', '本地歌曲', '已购'])
export const SEARCH_TABS = Object.freeze(['单曲', '歌手', '专辑', '歌单'])
// 播放模式：随机 / 顺序 / 单曲循环 / 列表循环（与 QQ 音乐一致）
export const PLAY_MODES = Object.freeze(['shuffle', 'order', 'single', 'list'])

// 以下为导航元数据（榜单名 / 分类 / 热搜词），不含任何曲目或音频数据。
export const CHARTS = Object.freeze([
  { id: 'hot', name: '巅峰榜·热歌', sub: '全网最热' },
  { id: 'new', name: '巅峰榜·新歌', sub: '最新上架' },
  { id: 'soar', name: '飙升榜', sub: '涨幅最快' },
  { id: 'cn', name: '内地榜', sub: '华语' },
  { id: 'hkt', name: '港台榜', sub: '粤语 / 国语' },
  { id: 'west', name: '欧美榜', sub: 'Western' },
  { id: 'jpkr', name: '日韩榜', sub: 'J / K Pop' },
  { id: 'classic', name: '古典榜', sub: 'Classical' },
])
export const PLAYLIST_CATEGORIES = Object.freeze([
  '华语', '流行', '摇滚', '电子', '古风', '轻音乐', '爵士', '说唱', 'ACG', '治愈', '古典', '民谣',
])
// 歌单广场分类板块：覆盖 QQ 音乐全量分类（语种/流派/主题/心情/场景）+ 网易云分类。
// 不足 2 个歌单的板块不会单独成区，所以多写几个不会让页面变碎。
export const PLAZA_CATEGORIES = Object.freeze([
  '华语', '流行', '摇滚', '民谣', '电子', '说唱', '古风', 'ACG', '轻音乐', '影视', '治愈', '欧美',
  '国语', '粤语', '韩语', '日语', '英语', '小语种', 'R&B', '爵士', '古典', '乡村', '拉丁', '嘻哈',
  '经典', '网络歌曲', 'KTV热歌', '儿歌', '伤感', '安静', '快乐', '励志', '甜蜜', '睡前', '学习',
  '运动', '开车', '约会', '夜晚', '校园', '高品质', '推荐',
])
// 电台：每个台就是一个「有固定口味的池子」，点进去 100 首同类型热门（按热度排序）。
// keyword 只用于向公开搜索接口要同类型的歌，不内置任何曲目或音频。
export const RADIO_STATIONS = Object.freeze([
  { id: 'foryou', name: '猜你喜欢', desc: '按口味推送', keyword: '华语流行 热歌', taste: 'hot' },
  { id: 'random', name: '随心听', desc: '随手一首好歌', keyword: '华语热歌', taste: 'hot' },
  { id: 'douyin', name: '抖音神曲', desc: '短视频爆款', keyword: '抖音 热歌', taste: 'hot' },
  { id: 'netpop', name: '网络流行', desc: '网络热歌', keyword: '网络流行 歌曲', taste: 'hot' },
  { id: 'ktv', name: 'KTV', desc: '必点金曲', keyword: 'KTV 经典 金曲', taste: 'hot' },
  { id: 'baby', name: '宝宝胎教', desc: '胎教 · 儿歌', keyword: '胎教 音乐 儿歌', taste: 'hot' },
  { id: 'dj', name: 'DJ舞曲', desc: '电音 · 蹦迪', keyword: 'DJ 舞曲 电音', taste: 'hot' },
  { id: 'whitenoise', name: '助眠白噪音', desc: '雨声 · 白噪音', keyword: '白噪音 助眠', taste: 'hot' },
  { id: 'yueyu', name: '粤语', desc: '粤语经典', keyword: '粤语 经典 金曲', taste: 'hot' },
  { id: 'sad', name: '忧伤', desc: '伤感情歌', keyword: '伤感 情歌', taste: 'hot' },
  { id: 'cover', name: '热门翻唱', desc: '翻唱热单', keyword: '翻唱 热门', taste: 'hot' },
  { id: 'fitness', name: '健身', desc: '燃脂节奏', keyword: '健身 燃脂 节奏', taste: 'hot' },
  { id: 'calm', name: '平静', desc: '轻音乐 · 纯音乐', keyword: '轻音乐 纯音乐 治愈', taste: 'hot' },
  { id: 'classical', name: '古典', desc: '古典 · 名曲', keyword: '古典 名曲 交响', taste: 'hot' },
  { id: 'car', name: '车载', desc: '开车必听', keyword: '车载 音乐 劲爆', taste: 'hot' },
  { id: 'ost', name: '影视原声', desc: '影视剧金曲', keyword: '影视原声 主题曲', taste: 'hot' },
  { id: 'morning', name: '起床', desc: '清晨提神', keyword: '清晨 轻快 元气', taste: 'hot' },
  { id: 'love', name: '情歌', desc: '经典情歌', keyword: '经典 情歌', taste: 'hot' },
  { id: 'bedtime', name: '睡前', desc: '睡前轻音乐', keyword: '睡前 助眠 轻音乐', taste: 'hot' },
  { id: 'travel', name: '旅游', desc: '路上听的歌', keyword: '旅行 民谣 公路', taste: 'hot' },
])

// 电台／空白页的默认测试曲：用来快速验证「搜索 → 取链 → 播放」整条链路是通的。
export const DEMO_TRACK = Object.freeze({
  title: '叹云兮',
  artist: '鞠婧祎',
  query: '鞠婧祎 叹云兮',
})

export const HOT_SEARCHES = Object.freeze(['华语流行', '纯音乐', '古典钢琴', '轻音乐', '爵士', '电子', '民谣', '治愈'])

export const QUICK_ENTRIES = Object.freeze([
  { id: 'daily', label: '每日推荐', icon: '✦' },
  { id: 'fm', label: '私人 FM', icon: '◉' },
  { id: 'charts', label: '排行榜', icon: '▤' },
  { id: 'playlists', label: '歌单广场', icon: '☰' },
  { id: 'new', label: '新歌首发', icon: '♪' },
  { id: 'import', label: '导入歌单', icon: '⇩' },
])

// 音质优先级：无损 > 320k > 192k > 128k。多源聚合后取最优，失败自动降级。
export const QUALITY = Object.freeze({
  lossless: { rank: 4, label: '无损 FLAC/WAV' },
  hq: { rank: 3, label: '320k' },
  sq: { rank: 2, label: '192k' },
  lq: { rank: 1, label: '128k' },
})
export const qualityRank = (q) => QUALITY[q]?.rank ?? 0

export const normKey = (title, artist) =>
  `${String(title || '').trim().toLowerCase()}|${String(artist || '').trim().toLowerCase()}`

export const makeTrack = (raw) => ({
  key: normKey(raw.title, raw.artist),
  title: raw.title,
  artist: raw.artist || '未知艺人',
  album: raw.album || '',
  durationMs: raw.durationMs || 0,
  cover: raw.cover || '',
  license: raw.license || '',          // 授权类型，必须可溯源
  licenseUrl: raw.licenseUrl || '',
  sourceId: raw.sourceId,
  // 同一首歌在多源的候选流，按音质降序
  streams: (raw.streams || []).slice().sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality)),
  lyrics: raw.lyrics || '',
  // 发行时间（毫秒）。搜索结果按它倒序：最新在前，查不到时间的排最后。
  pubTime: Number(raw.pubTime) || 0,
  tags: raw.tags || [],
  // 待解析元数据：搜索结果先给列表（秒出），点播时再按 songmid/hash 取链接。
  pending: raw.pending || null,
})
