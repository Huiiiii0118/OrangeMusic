// 官方免费授权音源的公开凭据。留空 = 该源自动禁用并给出提示，绝不回落到非授权接口。
// Jamendo: https://developer.jamendo.com/ （非商用约 35000 次/月，逐曲按 license_ccurl 校验）
// FMA / Musopen / Pixabay / 淘声网 / 耳聆网：仅收录明确 CC0 / CC-BY / 公有领域条目。
export const sourceKeys = Object.freeze({
  jamendoClientId: '',
  fmaApiKey: '',
})

// 合规边界：只解析歌单元数据（标题/艺人/专辑），不抓取、不解锁、不绕过任何受保护音频。
// 插件协议允许挂载「用户自行配置且有合法授权的端点」，仓库不内置任何第三方解析脚本。
export const LICENSE_POLICY = Object.freeze({
  allowNC: false,        // 拒绝 CC-BY-NC / CC-BY-NC-SA
  allowND: false,        // 拒绝 ND（禁止演绎）
  requireLicenseUrl: true,
  metadataOnlyImport: true,
  builtinThirdPartyResolvers: false,
})
