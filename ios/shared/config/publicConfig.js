// CloudBase 配置
// 新环境（2026-11-17 迁移自 WorkBuddy Cloud Service）
// publishableKey 由 cloudbase 连接器读取环境配置填入；本地开发用占位符
export const publicConfig = Object.freeze({
  // CloudBase 环境 ID（Web SDK 需要，客户端公开，不影响安全——实际安全靠数据库 RLS）
  env: 'puny-quelea-d5g4j2ay84845d168',
  // CloudBase 地域（手机短信登录仅上海支持）
  region: 'ap-shanghai',
  // 已废弃：旧 WorkBuddy Cloud Service
  endpoint: '',
  oauthRelayBaseUrl: '',
  publishableKey: '',
})

// 应用发布域名。双端 WebView 必须加载此 origin，否则云 SDK 的 Origin 校验会拒绝。
export const RELEASE_ORIGIN = window?.location?.origin || ''
export const APPLICATION_ID = ''
