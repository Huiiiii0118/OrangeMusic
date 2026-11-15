/* 预加载脚本：只暴露窗口控制，页面其它能力一律走 Web API。
   故意不暴露 fs / child_process / ipc 任意通道，保持上下文隔离。 */
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('orangeWindow', {
  host: 'electron',
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMax: () => ipcRenderer.send('win:toggleMax'),
  // 全屏（播放页右上角按钮）；状态由主进程回推，页面据此切换图标
  toggleFull: () => ipcRenderer.send('win:full'),
  onFullscreen: (cb) => ipcRenderer.on('win:fullscreen', (_e, on) => { try { cb(!!on) } catch { /* ignore */ } }),
  // 精简模式（迷你播放器）：缩到小窗并置顶，退出时还原
  setMini: (on) => ipcRenderer.send('win:mini', !!on),
  // 主进程改完窗口后回推的真实精简状态：页面据此对齐界面（防止两边不同步出现空白小窗）
  onMiniState: (cb) => ipcRenderer.on('win:miniState', (_e, on) => { try { cb(!!on) } catch { /* ignore */ } }),
  // 精简模式里展开播放队列：把窗口往下拉高 / 收回
  setMiniQueue: (on) => ipcRenderer.send('win:miniQueue', !!on),
  // 精简模式小窗拖动：整条播放栏可拖（不用 -webkit-app-region，避免吞掉 hover 事件）
  dragStart: (x, y) => ipcRenderer.send('win:dragStart', Number(x) || 0, Number(y) || 0),
  dragMove: (x, y) => ipcRenderer.send('win:dragMove', Number(x) || 0, Number(y) || 0),
  dragEnd: () => ipcRenderer.send('win:dragEnd'),
  // 外观模式：light / dark / system（同时驱动窗口底色与系统控件）
  setTheme: (mode) => ipcRenderer.send('win:theme', mode),
  // 托盘菜单「播放 / 暂停」
  onTrayPlay: (cb) => ipcRenderer.on('tray:playpause', () => { try { cb() } catch { /* ignore */ } }),
  // 托盘：推送当前曲目状态（菜单弹窗展示）与接收菜单指令
  trayState: (s) => ipcRenderer.send('tray:state', s),
  onTrayCmd: (cb) => ipcRenderer.on('tray:cmd', (_e, cmd, val) => { try { cb(cmd, val) } catch { /* ignore */ } }),
  // 开机启动
  setAutoStart: (on) => ipcRenderer.invoke('app:autoStart', !!on),
  // 关闭确认弹窗（应用内自绘）：主进程请求 -> 页面弹窗 -> 回传选择
  onAskClose: (cb) => ipcRenderer.on('app:askClose', () => { try { cb() } catch { /* ignore */ } }),
  answerClose: (action, remember) => ipcRenderer.send('app:closeAnswer', { action, remember: !!remember }),
  // 关闭按钮行为：ask 询问 / tray 最小化到托盘 / quit 退出
  getCloseAction: () => ipcRenderer.invoke('app:getCloseAction'),
  setCloseAction: (a) => ipcRenderer.invoke('app:setCloseAction', a),
  // 选择下载目录
  chooseDir: () => ipcRenderer.invoke('app:chooseDir'),
  // 封面角标清洗：取回第三方 CDN 图片原始字节（渲染进程跨域拿不到），返回 dataURL
  fetchImage: (url, timeout) => ipcRenderer.invoke('image:fetch', url, timeout),
  // SMTC 封面：主进程取回跨域封面原始字节，返回 dataURL（file:// 会被系统媒体面板丢弃）
  smtcArt: (url) => ipcRenderer.invoke('smtc:art', url),
})

// 应用内一键自更新：下载暂存 / 进度 / 重启安装（主进程核对，见 main.cjs 的 app:upd* 通道）
contextBridge.exposeInMainWorld('orangeUpdater', {
  info: () => ipcRenderer.invoke('app:updInfo'),
  download: (url, size) => ipcRenderer.invoke('app:updDownload', String(url || ''), Number(size) || 0),
  apply: (size) => ipcRenderer.invoke('app:updApply', Number(size) || 0),
  cleanup: () => ipcRenderer.invoke('app:updCleanup'),
  onProgress: (cb) => ipcRenderer.on('upd:progress', (_e, p) => { try { cb(p) } catch { /* ignore */ } }),
})
