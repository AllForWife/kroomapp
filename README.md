# K ROOM for Windows · macOS

多人 KTV 包廂 **K ROOM** 的 Windows／Mac App：用自己的視窗開 K ROOM（https://ktv2.548754321.xyz）。

## 下載

**[⬇ 下載安裝檔 KRoom-Setup.exe](https://github.com/AllForWife/kroomapp/releases/latest/download/KRoom-Setup.exe)**　（Windows 10／11，64 位元，一般使用者帳號就能安裝）

免安裝版：[KRoom-win-x64.zip](https://github.com/AllForWife/kroomapp/releases/latest/download/KRoom-win-x64.zip)，解壓後執行「K ROOM.exe」。所有版本：[Releases](https://github.com/AllForWife/kroomapp/releases)。

第一次執行時 Windows 可能顯示 SmartScreen 警告（App 沒有程式碼簽章）：按「其他資訊 → 仍要執行」。

### Mac

**[⬇ 下載 KRoom-mac.dmg](https://github.com/AllForWife/kroomapp/releases/latest/download/KRoom-mac.dmg)**　（macOS 12 以上，Apple 晶片和 Intel 都能用）

打開 dmg，把 K ROOM 拖到「應用程式」。App 沒有 Apple 簽章，第一次打開會被擋下：到「系統設定 → 隱私權與安全性」按「強制打開」（或在 Finder 對 K ROOM 按右鍵 →「打開」）。第一次用麥克風時 macOS 會問一次，按「允許」。

## 和用瀏覽器玩有什麼不同

- 聲音直接播放，不會出現「點一下開啟聲音」
- 視窗縮小或切到背景也不會卡頓（歌曲對時、語音照常）
- 優先使用獨立顯示卡
- 「🌐 用瀏覽器登入」：瀏覽器已經登入的話，按一下就能登入 App
- 「使用的麥克風」可以選任何一支麥克風
- 細的深色捲軸，不是 Windows 灰色的舊捲軸
- 點歌平板 → 🖥 畫面設定：畫質、FPS 上限、在左下角顯示 FPS，也可以解除螢幕更新率限制
- 連不上伺服器時自動重試
- F11 全螢幕、F5 重新整理（Mac：⌃⌘F 全螢幕、⌘R 重新整理）

App 只是 K ROOM 網站的視窗，網站更新後不用重新安裝。

**自動更新**：Windows 安裝版（KRoom-Setup.exe）會自動檢查新版本，在背景下載，下載好會問你要不要現在重新啟動；選「稍後」的話，下次關閉 App 時自動更新。更新時如果你在房間裡，重新啟動後會自動回到同一個房間。（免安裝的 zip 版不會自動更新。）Mac 版沒有 Apple 簽章，不能自己更新：有新版本時會問你要不要下載新的 dmg。

## 開發

這個 repo 的程式碼來自 K ROOM 主專案的 `desktop/` 資料夾。

```bash
npm ci
node node_modules/electron/install.js
npm start             # 執行
npm run release       # 打包 Windows：dist/KRoom-Setup.exe、dist/KRoom-win-x64.zip
npm run release:mac   # 打包 Mac（要在 Mac 上）：dist/KRoom-mac.dmg、dist/KRoom-mac.zip
```

發行新版：改 `package.json` 的 `version`，然後推送同名 tag（例如 `v1.0.1`），GitHub Actions 會自動打包 Windows 和 Mac 版並建立 Release，上面的下載連結會自動指向最新版。
