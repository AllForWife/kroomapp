# K ROOM for Windows

多人 KTV 包廂 **K ROOM** 的 Windows App：用自己的視窗開 K ROOM（https://ktv2.548754321.xyz）。

## 下載

**[⬇ 下載安裝檔 KRoom-Setup.exe](https://github.com/AllForWife/kroomapp/releases/latest/download/KRoom-Setup.exe)**　（Windows 10／11，64 位元，免系統管理員權限）

免安裝版：[KRoom-win-x64.zip](https://github.com/AllForWife/kroomapp/releases/latest/download/KRoom-win-x64.zip)，解壓後執行「K ROOM.exe」。所有版本：[Releases](https://github.com/AllForWife/kroomapp/releases)。

第一次執行時 Windows 可能顯示 SmartScreen 警告（App 沒有程式碼簽章）：按「其他資訊 → 仍要執行」。

## 和用瀏覽器玩有什麼不同

- 聲音直接播放，不會出現「點一下開啟聲音」
- 視窗縮小或切到背景也不會卡頓（歌曲對時、語音照常）
- 優先使用獨立顯示卡
- 「🌐 用瀏覽器登入」：瀏覽器已經登入的話，按一下就能登入 App
- F11 全螢幕、F5 重新整理；管理員按 Ctrl+Shift+A 開管理員頁，Alt+Home 回遊戲

App 只是 K ROOM 網站的視窗，網站更新後不用重新安裝。

## 開發

這個 repo 的程式碼來自 K ROOM 主專案的 `desktop/` 資料夾。

```bash
npm ci
node node_modules/electron/install.js
npm start             # 執行
npm run release       # 打包：dist/KRoom-Setup.exe、dist/KRoom-win-x64.zip
```

發行新版：改 `package.json` 的 `version`，然後推送同名 tag（例如 `v1.0.1`），GitHub Actions 會自動打包並建立 Release，上面的下載連結會自動指向最新版。
