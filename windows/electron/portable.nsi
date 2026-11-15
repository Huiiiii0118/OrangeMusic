; 橙子音乐 · 免安装单文件封装脚本（NSIS 3）
;
; 目标：双击 OrangeMusic.exe 就能用，不需要安装、不建快捷方式；
; 而且**只在第一次**解压运行时，之后直接启动已解压的副本（1~2 秒），
; 不像 electron-builder 的 portable 目标那样每次启动都重解压 300MB。
;
; 解压位置：%LOCALAPPDATA%\OrangeMusic\app-<版本>-<构建号>
;   - 目录名带构建号 → 换了 exe 一定会重新解压，不会出现「更新了却还在跑旧内容」；
;   - 卸载 = 删掉这个 exe，再删 %LOCALAPPDATA%\OrangeMusic 即可。
;
; 编译：makensis /INPUTCHARSET UTF8 /DAPPVER=1.3.0 /DAPPBUILD=<构建号> portable.nsi
;       （由 tools/build_exe.mjs 调用，工作目录为 windows/electron）

!ifndef APPBUILD
  !define APPBUILD "0"
!endif

; 中间产物目录（由 tools/build_exe.mjs 用 /DUNPACKED=... 覆盖；
; 默认目录被占用时脚本会换一个暂存目录，避免「正在运行的 exe 锁住文件」导致构建失败）
!ifndef UNPACKED
  !define UNPACKED "..\dist\win-unpacked"
!endif

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on
CRCCheck on

Name "Orange Music · 橙子音乐"
OutFile "..\dist\OrangeMusic.exe"
Icon "build\icon.ico"
BrandingText "Orange Music · 橙子音乐"
RequestExecutionLevel user
AutoCloseWindow true

; 注意：不要带 /LANG=2052 —— 本脚本没 LoadLanguageFile 加载简体中文，
; 带 lang 的版本键会被 NSIS 直接丢弃，导致整个 VERSIONINFO 块为空（外壳在资源管理器里没有版本信息）。
; Unicode 版 NSIS 会把下面这些中文串以 UTF-16 存进默认语言块，中文正常显示。
VIProductVersion "${APPVER}.${APPBUILD}"
VIFileVersion "${APPVER}.${APPBUILD}"
VIAddVersionKey "ProductName" "Orange Music · 橙子音乐"
VIAddVersionKey "FileDescription" "Orange Music · 橙子音乐 无广告音乐播放器"
VIAddVersionKey "FileVersion" "${APPVER}.${APPBUILD}"
VIAddVersionKey "ProductVersion" "${APPVER}.${APPBUILD}"
VIAddVersionKey "LegalCopyright" "OrangeMusic"

Var APPDIR

Function .onInit
  SetSilent silent
FunctionEnd

Section
  StrCpy $APPDIR "$LOCALAPPDATA\OrangeMusic\app-${APPVER}-${APPBUILD}"

  ; ── 注册 AppUserModelID 显示名（系统媒体面板 / 音量混合器据此显示「橙子音乐」而不是「未知应用」）──
  ; 用 NSIS 原生 WriteRegStr 直接写，**不依赖 reg.exe / powershell**（这台机器上它们被执行安全策略拦截，
  ; 导致应用内注册表写入全部失败 → 一直「未知应用」）。每次启动都写一遍，自愈。
  ; 注意：AUMID 必须与 main.cjs 的 app.setAppUserModelId / 开始菜单 .lnk 的 appUserModelId 完全一致，
  ; 否则 Windows 用进程实际 AUMID 查不到 DisplayName → 仍显示「未知应用」。
  WriteRegStr HKCU "Software\Classes\AppUserModelId\OrangeMusic.Desktop.Player" "DisplayName" "橙子音乐"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\OrangeMusic.Desktop.Player" "IconUri" "$APPDIR\橙子音乐.exe"

  ; ── 已经解压过（含升级后版本号相同的重复启动）：直接拉起，毫秒级 ──
  ; --om-launcher= 把外层壳自身路径传给内层：应用内「一键更新」要用它替换壳文件（参考 OrangeIsland）
  IfFileExists "$APPDIR\橙子音乐.exe" 0 firstRun
    Exec '"$APPDIR\橙子音乐.exe" --om-launcher="$EXEDIR\$EXEFILE"'
    Quit
  firstRun:

  ; ── 首次运行 / 升级：放一张闪屏，别让人对着空屏幕等 ──
  ; AdvSplash 只有一个 show 函数（没有 stop），所以给一个足够长的停留时间；
  ; 解压结束 Exec 之后 Quit，窗口随本进程一起销毁。
  InitPluginsDir
  File /oname=$PLUGINSDIR\splash.bmp "build\splash.bmp"
  AdvSplash::show 90000 400 400 0x00000000 -1 "$PLUGINSDIR\splash.bmp"
  Pop $0

  ; 清掉旧版本的解包目录（同版本残留也一起清，保证干净）
  RMDir /r "$LOCALAPPDATA\OrangeMusic"
  CreateDirectory "$APPDIR"
  SetOutPath "$APPDIR"
  File /r "${UNPACKED}\*.*"

  ; 如果目录没建起来（磁盘满 / 被杀软锁住），退回到直接提示
  IfFileExists "$APPDIR\橙子音乐.exe" 0 failed

  Exec '"$APPDIR\橙子音乐.exe" --om-launcher="$EXEDIR\$EXEFILE"'
  Quit

  failed:
    MessageBox MB_ICONSTOP "解压失败：无法写入 $APPDIR$\r$\n请检查磁盘空间，或把 exe 换个目录再试。" /SD IDOK
SectionEnd
