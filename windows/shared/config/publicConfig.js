// 唯一来源：workbuddy_cloud_service activate 返回的 publicConfig。
// 禁止硬编码其它 endpoint、从 location / env / BFF 推导。重新发布时只需替换本文件。
export const publicConfig = Object.freeze({
  endpoint: 'https://quiet-music.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_4c7LTcTXWQ2oVclnwoJzFO_WZ1ZIedfRiwZiQMYQbbzorAKMQVEM9Df',
})

// 应用发布域名。双端 WebView 必须加载此 origin，否则云 SDK 的 Origin 校验会拒绝。
export const RELEASE_ORIGIN = publicConfig.endpoint
export const APPLICATION_ID = 'wbapp_4c7LTcTXWQ2oVclnwoJzFO'
