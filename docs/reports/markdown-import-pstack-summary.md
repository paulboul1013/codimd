# Markdown 匯入的 pstack 重點流程報告

已依 [實作計畫](../plans/markdown-import.md) 完成功能。歷史介面提供「匯入 Markdown」按鈕，可將單一本機 UTF-8 的 `.md`、`.markdown`、`.txt` 建成新筆記，成功後在目前分頁開啟。副檔名不分大小寫，檔名不參與標題解析。

## 流程與產出

| 階段 | 本次做法 | 產出 |
| --- | --- | --- |
| How | 追查歷史入口、POST /new、模型 hooks、標題與翻譯 | 確認既有路徑已處理建立、權限、歷史、初始修訂 |
| Architect | 比較首頁內嵌邏輯與獨立模組，保留單次 POST 建立 | 首頁接線，匯入模組管理完整操作，後端僅補正文標題 |
| Blast radius | 檢查空正文範本、共用建立路徑、登入跳轉、子路徑及 JSON 匯入 | 每項對應回歸或實機驗收 |
| 測試先行 | 先重現建立資料缺 title，再實作；登入導向問題也先補失敗測試 | 39 個專項測試通過 |
| Build the lever | 保存可重跑的瀏覽器與資料庫檢查工具 | 三個 bin/check-markdown-import-* 工具 |
| 獨立審查 | 五軸唯讀審查 | 修正不帶尾斜線的登入導向，改善驗收工具 |
| Prove it works | 正式編譯、真實服務、子路徑 proxy、瀏覽器、SQLite、截圖 | 53 項瀏覽器驗收與資料庫核對通過 |
| 文件整理 | 保留決策、失敗、修正、命令與證據 | [完整流程](markdown-import-pstack-detail.md)、[原始輸出](markdown-import-evidence/) |

## 完成的行為

- 拒絕空檔與只有 CR 的檔案，保留空白和 LF 的非空語意。
- 以原始讀取內容呼叫既有 POST /new，後端沿用 CR 正規化與標題解析。
- 顯示格式、讀檔、超限、登入、伺服器與網路錯誤，恢復控制項，支援再次選取同一檔案。
- 導頁限定目前站點、部署路徑及筆記 ID；失敗不自動重送。
- 24 個語系補齊 8 個文案鍵，繁體中文提供翻譯，其餘使用英文回退文案。
- 訪客與登入者權限、歷史標題與標籤、初始修訂、預設範本及既有 JSON 歷史匯入均已驗證。

## 驗證結果與限制

| 驗證 | 結果 |
| --- | --- |
| 專項回歸 | 39 通過 |
| 瀏覽器 | 48 項通過，登入失效另 5 項通過 |
| 資料庫 | 標題、正文、owner、permission、初始修訂一致；登入失效前後筆記數均為 18 |
| lint、JSON、正式 build | 通過 |
| 預設 npm test | 舊 realtime 測試逾時，未修改 HEAD 基準也重現 |
| 完整 coverage，使用 --no-timeouts | 186 通過，保留全部斷言，沒有跳過測試 |

預設 npm test 尚未通過，需在穩定環境重跑。正式編譯仍有 Browserslist 資料過期與資產大小提示。網路中斷時，伺服器可能已建立筆記，畫面會提示先查看歷史再重試。

未修改 README、套件依賴、API 或資料庫結構。實作驗收當時尚未提交、推送或合併，後續提交依使用者授權執行。

## 畫面證據

[歷史按鈕](../../output/playwright/markdown-import-history.png) · [空檔提示](../../output/playwright/markdown-import-empty.png) · [匯入成功](../../output/playwright/markdown-import-success.png) · [窄螢幕](../../output/playwright/markdown-import-mobile.png) · [登入失效](../../output/playwright/markdown-import-login.png)
