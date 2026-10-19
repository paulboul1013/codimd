# 分享功能自動化驗收報告

結論：分享與雙帳號共同編輯已實作，雙帳號自動化驗收通過。最終 run `2026-10-19T05-53-22-454Z-e72724` 的結果為 **42 項 PASS、0 項 FAIL、0 項 BLOCKED**，判定 `ACCEPTED`，程式返回碼為 `0`。前一次完整 run `2026-10-19T05-51-23-488Z-aa9a50` 也是 42 項全數通過。

驗收以驗收腳本內定義的 15 組需求（Q1 至 Q14 與游標名稱）為準。[計畫](../plans/sharing-collaborative-editing.md)驗收矩陣中未列入腳本的項目，見「尚未自動驗證的項目」。

## 接手範圍

先前的 Codex 工作階段完成需求訪談、計畫與驗收腳本，基準結果為 17 PASS、10 FAIL、16 BLOCKED，且尚未修改應用程式。本次接手後實作功能，並把原本 16 項 BLOCKED 改寫為實際操作的檢查。

## 實作內容

| 範圍 | 修改 |
| --- | --- |
| 分享入口 | 桌面頁首在「發布」與「選單」之間加入「分享」，手機選單也有同一入口 |
| 分享視窗 | 顯示編輯連結（`?both`）、目前開放範圍、複製按鈕；只有擁有者看到「啟用登入者共同編輯」與「停止分享」。開啟視窗與複製都不會變更權限 |
| 權限確認 | `permission` 事件新增可選的確認回覆，回傳 `{ ok, permission }` 或 `{ ok: false, code }`。前端收到確認才顯示成功，10 秒未確認時顯示「尚未確認」 |
| 撤權 | 停止分享時，失去權限的連線先離開房間、標記為撤權，再收到 403 並斷線。OT 伺服器回補歷史與延遲 `doc` 前會再次檢查讀取權限 |
| 撤權後救回 | 前端先凍結同步、擷取尚未確認的本機修改，再清除正文，顯示「分享已停止」以及複製或下載的救回選項；不會重送修改 |
| 更新 API | `PUT /api/notes/:noteId` 加入筆記寫入權限檢查 |
| 房間保留 | 拒絕無權連線時，只在房間沒有其他使用者時才移除房間 |
| 顏色 | 新增 `lib/realtime/participants.js`，以固定色盤分配帳號顏色。協作期間同帳號維持同色，所有人離開後才重新分配 |
| 同名帳號 | 同份筆記出現同名帳號時附加帳號短碼，例如 `root1 · F6A9`。短碼相撞時自動加長；同一帳號的多個分頁視為同一身分 |
| 遠端游標 | 名稱常駐於游標上方，頂端空間不足時才移到下方。名稱以純文字寫入。失焦或閒置時保留最後位置並淡化；離線則移除 |
| 登入返回 | 首頁帶 `next` 時自動開啟登入視窗。登入失敗、註冊成功或失敗後都保留原筆記目標；返回目標限本站及部署子路徑 |

## 已找出的根本原因

- **登入後沒有回到筆記**：passport 0.6 登入時會重建 session，未設定 `keepSessionInfo: true` 時會丟棄 `session.returnTo`。所有登入供應商均已加上這個選項，結構測試會檢查每個供應商。
- **登入失敗後遺失目標**：各供應商失敗時導向純首頁。現在統一導向 `/auth/failure`，再依 session 中的目標導回帶 `next` 的登入頁。
- **私密筆記可被他人覆寫**：更新 API 原本只檢查是否登入。
- **名稱兩秒後消失**：舊的游標標籤會在兩秒後淡出，只在滑鼠移入時顯示。
- **失焦後游標消失**：伺服器在失焦時清空游標座標。現在保留座標並送出 `blur` 狀態。
- **線上名單清理比對錯誤**：原本以 DOM `id` 比對，但游標元素使用 `data-clientid`。

## 驗收方式

入口為 [bin/check-sharing-collaboration](../../bin/check-sharing-collaboration)。主程式為 [check-sharing-collaboration.js](../../bin/check-sharing-collaboration.js)，角色腳本為 [owner](../../bin/lib/sharing-owner-actor.js) 與 [collaborator](../../bin/lib/sharing-collaborator-actor.js)。owner 與 collaborator 在兩個隔離的瀏覽器中並行操作，再由協調器執行登入、註冊與同名帳號等跨帳號檢查。

部分情境必須在固定條件下才能重現，腳本用下列方式模擬外部環境，沒有修改應用程式介面：

| 情境 | 模擬方式 |
| --- | --- |
| 權限確認遺失 | 攔截 WebSocket，丟棄送出的 `permission` 訊息，確認畫面顯示「尚未確認」而非成功 |
| 撤權時有未確認修改 | 丟棄 collaborator 送出的 `operation` 訊息，讓修改停留在未確認狀態 |
| 剪貼簿被拒絕 | 將該頁的 `navigator.clipboard.writeText` 改為拒絕，確認連結被選取並提示手動複製 |
| 閒置五分鐘 | 以 Playwright clock 每次推進 2 秒、共 320 秒；每步間隔讓 socket 心跳正常往返 |
| 協定層攻擊 | 以 collaborator 的 session cookie 建立原始 socket.io 連線，送出非擁有者權限事件；撤權後再要求歷史與寫入 |

同名帳號與全新註冊共用一個臨時帳號，email 為 `<owner 名稱>@sharing-<run 短碼>.test`。run 結束時透過帳號自己的刪除連結移除，並確認無法再登入。

事件先後以單調時鐘比較。本機 WSL 的系統時鐘會跳動數分鐘，以系統時間比較曾導致誤判。

## 帳號與資料

只使用 `root1@example.test` 與 `root2@example.test`，以及每次 run 自行建立再刪除的臨時帳號。[資料庫核對](sharing-collaborative-editing-evidence/database-check.txt)顯示帳號總數 4、原有帳號 2、殘留臨時帳號 0、殘留測試筆記 0。

開發期間的探測腳本建立過 4 份匿名筆記，已依建立時間與內容確認後刪除。資料庫中另有一份 03:32 建立、有擁有者的空白筆記，建立時間早於本次接手，因此保留未動。

## 其他驗證

- `npm run lint` 與 `npm run jsonlint` 通過。
- 新增測試：`test/realtime/participants.test.js`、`test/note/updateNote.test.js`、`test/ot/editor-socketio-server.test.js`、`test/auth/return-to.test.js`，並擴充 `socket-events` 與 `connection` 測試。這些測試單獨執行時全數通過。
- 完整 `npm run mocha` 每次都有一項逾時，失敗的測試每次不同，HEAD 原始版本也有同樣現象。原因是 Mocha 5 以系統時間判斷逾時，而本機時鐘會跳動；這個問題與本次修改無關，也尚未修正。

## 尚未自動驗證的項目

- 本機只啟用 email 登入。其他供應商的返回流程只由結構測試與 `return-to` 單元測試涵蓋，沒有實際登入外部供應商。
- 驗收矩陣中的特殊名稱（中文、超長、含 HTML 字元）、游標在插入或捲動後是否貼齊、明暗主題與部署子路徑，沒有列入腳本。名稱已改用純文字寫入，子路徑有單元測試，但兩者都沒有瀏覽器實測。
- 舊有的六種權限選單仍可用，但沒有逐一回歸測試。

## 重跑方式

```bash
./bin/start-local --build
export CODIMD_PLAYWRIGHT_MODULE=/home/paulboul/.cache/ms-playwright-go/1.50.1/package
export CODIMD_BROWSER_EXECUTABLE=/home/paulboul/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome
./bin/check-sharing-collaboration --credentials /tmp/codimd-sharing-accounts/credentials.json
```

憑證檔須放在 repository 外，權限為 `0600`。主機沒有 Node v16.20.2 時，設定 `CODIMD_NODE_BINARY` 指向該版本。完整執行約 2 分鐘。

## 證據

- [機器可讀結果](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/results.json)
- [逐項報告與全部 PNG 連結](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/report.md)
- [PNG 尺寸與 SHA-256 索引](sharing-collaborative-editing-evidence/evidence-index.json)
- [分享視窗與啟用確認](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/owner/owner-share-enabled.png)
- [手機分享視窗](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/owner/owner-mobile-share-modal.png)
- [同段落同時編輯收斂](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/owner/owner-concurrent-converged.png)
- [遠端名稱位於游標上方](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/collaborator/collaborator-remote-cursor-after-three-seconds.png)
- [失焦後淡化保留](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/owner/owner-remote-cursor-blurred.png)
- [同名帳號短碼](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/coordinator/same-name-two-owner-tabs.png)
- [閒置者對新加入者顯示為淡化](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/coordinator/new-join-sees-idle-collaborator.png)
- [撤權後救回未確認修改](../../output/playwright/sharing-collaborative-editing/2026-10-19T05-53-22-454Z-e72724/collaborator/collaborator-revoked-recovery.png)

所有 PNG 都是瀏覽器原始截圖，沒有後製。
