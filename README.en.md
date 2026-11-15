# Orange Music · 橙子音乐

> **Two clients, one Web UI**: a Windows desktop app (single portable `.exe`) and an iOS web app / PWA.
> Ad-free, no tracking, no analytics SDK. For personal learning and research only — please respect each
> music platform's terms of service and copyright.

- Home / repo: <https://github.com/Huiiiii0118/OrangeMusic>
- Author: **12**
- Version: **v1.0.0** (first stable release across both clients)

---

## 1. The two apps

### Windows desktop — `OrangeMusic.exe`

| | |
|---|---|
| Form | **One portable single-file exe** (~117 MB, bundled Chromium runtime) |
| Install | Double-click to run. No registry writes, no services; delete the file to uninstall |
| First launch | Extracts to `%LOCALAPPDATA%\OrangeMusic\app-<version>-<build>` (20–30 s, with splash); later launches 1–2 s |
| User data | `%APPDATA%\橙子音乐` (survives upgrades) |
| UI | Frameless, content fills the window, translucent sidebar, system blue `#0a84ff`, desktop player bar, thin scrollbars |
| OS integration | Tray, configurable close behaviour (ask / minimize to tray / quit), launch at login, compact player mode, **global media keys** |
| Music engine | **Runs entirely on the local machine**: resolves full audio by "title + artist" from Bodian / Kuwo, with NetEase unblocking, Kugou and QQ as fallbacks. No hosted service, no login, no membership |
| Auto-update | Silent GitHub Releases check on start → orange dot on the About icon → "What's new" dialog after an upgrade |

### iOS — web app / PWA

| | |
|---|---|
| Form | An HTTPS web app; open it in Safari and **Add to Home Screen** for an app-like experience |
| UI | Large titles, frosted-glass mini player, bottom tab bar, full-screen lyrics, animated visualiser |
| Streaming | Resolved by the **same-origin server** (`/api/search`, `/api/url`, `/api/charts`). The server races Bodian against a GD mirror and validates title / artist / duration to return a full 320 kbps link |
| Lock screen | Line 1 `Title - Artist`, line 2 the current lyric line; controls are **previous · play/pause · next** |
| Offline shell | A service worker caches the app shell so it opens instantly even if the network is flaky (audio still needs the network) |

> **Note**: on iOS, the lock-screen card's "tap to open" target is decided by the system app identity.
> A pure web app cannot control it, so it may open a different music app. This is WebKit behaviour, not a bug here.

---

## 2. Shared features

- **Search**: multi-platform aggregated search with strict title/artist matching to avoid covers and same-name tracks.
- **Charts**: real tracks from QQ Music and NetEase charts, grouped into smart sections.
- **Discovery**: playlist plaza, popular artists, taste-based recommendations, radio stations.
- **Lyrics**: multi-channel LRC racing, full-screen synced lyrics; iOS also shows the current line on the lock screen.
- **Playback**: queue, play modes (order / single / shuffle / list loop), quality preference, volume visualiser.
- **Account & sync**: after signing in with an email / phone verification code, favourites, recently played,
  audition list and playback position sync across devices — **deleting on one device also removes it on the other**
  (tombstone-based). In anonymous sessions data stays on the local device only.
- **Privacy**: no behaviour reporting, no ads, no analytics SDK, no third-party iframes.
- **Updates**: manual check in Settings / About, or a silent check on start.
- **Changelog**: view the release notes of the last three versions in one tap.

---

## 3. Getting started

### Windows

1. Download `OrangeMusic.exe` from [Releases](https://github.com/Huiiiii0118/OrangeMusic/releases).
2. Double-click it (the first run extracts for 20–30 s).
3. Search, or tap a recommendation on the home page.

### iOS

1. Open the deployed URL in Safari and wait for the app to load.
2. Share → **Add to Home Screen**, then launch it from the icon.
3. The very first playback needs one tap (iOS audio activation policy).

---

## 4. Building

### iOS web app / PWA

```bash
cd ios
npm install
node tools/build_web.js --out www --platform ios   # assemble the site into ios/www
node server.js                                     # same-origin server: www + /api/*
```

The server exposes search / resolve / charts under `/api/*`, listens on `PORT` and binds `0.0.0.0`.

### Windows desktop

```bash
cd windows
npm install
node tools/build_web.js --out electron/www --platform windows
node tools/build_exe.mjs        # produces dist/OrangeMusic.exe
```

> Packaging: `electron-builder --win --dir` → `makensis` wraps it into a single exe.
> If `ELECTRON_RUN_AS_NODE` and similar variables are set in the shell, the build script clears them first.

---

## 5. Release workflow

1. Finish the changes on both clients and confirm they work.
2. Bump the version in `updater.js` (`CURRENT_VERSION`), `app.js` (`APP_VERSION`) and each `package.json`.
3. **Windows**: rebuild `OrangeMusic.exe` and attach it to a GitHub Release.
4. **iOS**: rebuild `ios/www` and deploy it to the cloud.
5. Keep a copy of the released binary under the local `GitHub/` folder (git-ignored — the exe goes to Release assets).

---

## 6. Layout

```
Orange Music/
├─ ios/              # iOS web app / PWA
│  ├─ shared/        #   Web UI, core logic, protocol bridge, service worker
│  ├─ server.js      #   same-origin server: static site + /api/search | url | charts
│  ├─ local-api.cjs  #   optional local engine adapter (not shipped in deployments)
│  ├─ tools/         #   build_web.js and friends
│  └─ www/           #   build output (git-ignored)
├─ windows/          # Windows desktop
│  ├─ shared/        #   Web UI, core logic, protocol bridge
│  ├─ electron/      #   main process, preload, custom protocol, packaging scripts
│  ├─ tools/         #   build_web.js, build_exe.mjs
│  └─ dist/          #   OrangeMusic.exe (git-ignored)
├─ GitHub/           # release archive (git-ignored, exe goes to Release assets)
├─ README.md         # Chinese README (primary)
└─ README.en.md      # this file
```

---

## 7. Compliance & copyright

Built on the following open-source and third-party components; all rights remain with their owners:

- Runtime: Electron, Chromium (BSD and other open-source licences); on iOS the app runs in the system Safari / WebKit.
- Music engines: `@neteasecloudmusicapienhanced/api`, `@unblockneteasemusic/server` and various aggregator
  gateways (Bodian / Kuwo / Kugou / QQ).
- Publicly licensed audio (optional, needs your own API key): Jamendo, Free Music Archive, Musopen, CC0 works.
- Covers and metadata come from public APIs of the music platforms.

**This project does not cache, transcode or store any audio content.** It is a technical aggregation for
personal study only. Audio copyright belongs to the original artists and distributors; responsibility for
third-party sources rests with the user. **Do not use commercially or redistribute publicly.**

---

## 8. Open source & contributing

The source code is **open source**: released under the **MIT Licence** — see the repository's
root [LICENSE](LICENSE) file for the full text.

- ✅ **Use freely** — personal, team or commercial use;
- ✅ **Modify freely** — fork it, change it, build your own player on top of it;
- ✅ **Redistribute** — ship modified versions, with or without publishing your changes;
- ⚠️ **The only requirement** — keep the original copyright and MIT licence notice.

> MIT covers **this project's own code** only. Third-party components (Electron / Chromium / the music
> engines) keep their own licences. Audio copyright stays with the original artists and distributors and is
> not changed by open-sourcing the code.

**Contributing**: issues and pull requests are welcome —
<https://github.com/Huiiiii0118/OrangeMusic/issues>. Please open an issue first to discuss larger changes.

---

**中文说明**: see [README.md](README.md).
