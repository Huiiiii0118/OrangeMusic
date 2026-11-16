/* 橙子音乐 PWA：按机型写入与 iPhone 模拟器完全一致的安全区数值。
   背景：iOS 真机在 black-translucent 下 env(safe-area-inset-*) 有时返回 0 或与
   模拟器预期不符，导致「模拟器里看着对、真机顶部被压 / 底部空一大截」。
   这里在页面解析阶段按逻辑分辨率查表，把 --safe-t / --safe-b 写成真值；
   数值来源与 ios/test/iphone.html 的 DEVICES 表逐项相同（13~18 Pro 全系）。
   仅在「添加到主屏幕」的 standalone 竖屏 PWA 中生效；Safari 标签页、横屏、
   桌面浏览器以及表外机型都保留 CSS 里的 env() 原值，不会被误伤。 */
(function () {
  try {
    if (!window.matchMedia || !window.matchMedia('(display-mode: standalone)').matches) return
    var w = screen.width || 0
    var h = screen.height || 0
    if (!w || !h || w > h) return

    // [宽(pt), 高(pt), safe-top, safe-bottom] —— 与模拟器 DEVICES 一一对应
    var TABLE = [
      [390, 844, 47, 34],  // 13 Pro
      [428, 926, 47, 34],  // 13 Pro Max
      [393, 852, 59, 34],  // 14 Pro / 15 Pro
      [430, 932, 59, 34],  // 14 Pro Max / 15 Pro Max
      [402, 874, 62, 34],  // 16 / 17 / 18 Pro
      [440, 956, 62, 34],  // 16 / 17 / 18 Pro Max
      [375, 667, 20, 0],   // SE 3（无刘海，对照）
    ]

    for (var i = 0; i < TABLE.length; i++) {
      var d = TABLE[i]
      if (Math.abs(w - d[0]) <= 1 && Math.abs(h - d[1]) <= 1) {
        var s = document.documentElement.style
        s.setProperty('--safe-t', d[2] + 'px')
        s.setProperty('--safe-b', d[3] + 'px')
        document.documentElement.dataset.omSafe = d[2] + '/' + d[3]
        return
      }
    }
  } catch (e) { /* 查表失败时静默回落到 CSS 的 env() */ }
})()
