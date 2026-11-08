# 第二大腦

## Problem

Agent 的記憶只存在本機的 `~/.claude/projects/*/memory`。這些記憶綁定 Claude Code 和這台機器，其他 agent 讀不到，使用者也很難在網頁上瀏覽或修改。CodiMD 目前的筆記 API 只認瀏覽器的 session cookie，沒有搜尋功能，筆記在瀏覽器開著時還會拒絕寫入，所以 agent 沒辦法拿它當記憶庫。

## Solution

CodiMD 成為第二大腦的唯一真相來源。使用者在設定頁產生一組 API token，token 只能存取記憶筆記。全域註冊的 MCP server 用這組 token 提供搜尋、讀取、寫入、封存等工具。寫入類工具每次都會跳出 Claude Code 的權限提示，由使用者同意。新 session 開始時，SessionStart hook 會注入記憶索引。本機 memory 先匯入一次，然後關閉。

## Acceptance

1. 已登入的使用者可以在「API token」設定頁產生具名的 token（完整值只顯示一次）、看到 token 清單（名稱、前綴、建立時間、最後使用時間），以及撤銷 token。資料庫只存 token 的雜湊值。
2. 帶有效的 `Authorization: Bearer <token>` 呼叫記憶 API 會成功。token 缺少、錯誤或已撤銷時，回 401 JSON，不會轉址到登入頁。
3. 建立記憶筆記時，筆記擁有者是 token 的帳號，權限是 `private`，標籤含 `memory`、記憶範圍、記憶類型。記憶範圍或記憶類型不合法時回 400。
4. 可以依記憶範圍、記憶類型、關鍵字（不分大小寫、比對全文）搜尋。結果只包含該帳號擁有的記憶筆記，預設排除已封存的筆記。
5. 可以讀取一份記憶筆記的全文與中繼資料。
6. 可以整份更新或在結尾追加內容。如果更新後的內容不再含 `memory` 標籤，回 400，筆記不變。
7. 封存會在標籤加上 `archived`，筆記本身保留。
8. token 碰不帶 `memory` 標籤的筆記，或別的帳號的筆記時，回 404，不透露筆記是否存在。
9. 筆記在瀏覽器開著時，寫入會透過即時協作套用。瀏覽器不用重新整理就看到新內容，其他人沒存的編輯也不會被蓋掉。
10. 筆記沒有人開著時，寫入直接存進資料庫，並留下一筆 revision。
11. MCP server 提供 `memory_index`、`memory_search`、`memory_read`、`memory_create`、`memory_update`、`memory_append`、`memory_archive`。它以 user scope 註冊；讀取類工具放進允許清單，寫入類工具每次都跳出權限提示。
12. MCP 和 hook 會先連 `http://localhost:3000`，連不上就從 GitHub Pages 的轉址頁查出目前的 tunnel 網址。兩個都連不上時，回報清楚的錯誤訊息。
13. SessionStart hook 會注入 `global` 範圍與目前專案範圍的記憶標題清單。專案名稱取自 git remote 的 repo 名稱，沒有 remote 時用 git 根目錄名稱。CodiMD 連不上時只印一行提示，不會讓 session 啟動失敗。
14. 匯入腳本把本機 memory 轉成記憶筆記：保留類型，`user` 類型歸 `global` 範圍，其他類型歸所屬專案範圍。重跑時不會重複建立。
15. 有一份 skill 規定 agent 什麼時候提議寫記憶、標籤怎麼取，並在全域設定關閉 `autoMemoryEnabled`。

## Design

**資料形狀**
- `ApiToken`：所屬帳號、名稱、token 雜湊（SHA-256）、顯示用前綴、建立時間、最後使用時間。撤銷就是刪除這筆資料。token 本身是 32 bytes 的亂數，加上可辨識的前綴。**One-way change door：新資料表 migration，而且屬於認證程式碼。**
- 記憶筆記沒有新增資料表。它就是一般筆記，記憶屬性全部放在 YAML frontmatter 的 `tags` 裡：`memory`、`global` 或 `project:<名稱>`、類型標籤，視情況再加 `archived`。所以「是不是記憶筆記」取決於筆記內容當下的標籤（ADR 0001）。

**模組**
- 記憶標籤模組（純函式）：從筆記內容解析記憶範圍、類型與封存狀態；組出含 frontmatter 的新筆記內容；在 frontmatter 加上 `archived`；驗證記憶範圍與類型。
- Token 模組：產生 token、雜湊、用 Bearer header 找出帳號，並更新最後使用時間。另有一組網頁端的管理介面，用 session 登入加 CSRF 保護。
- 記憶 API router：獨立掛在 `/api/memory`，只走 Bearer 認證，不碰 session 與 CSRF。**Design door：對外 REST 格式，MCP 依賴它。**
- 筆記寫入函式：輸入筆記、新內容和帳號。筆記在即時協作的 pool 裡時，算出從目前文件到新內容的 text operation，在目前 revision 上套用，再廣播給房間裡的人，並把筆記標為 dirty。不在 pool 裡時，直接更新資料庫並存一筆 revision。
- MCP server 與 hook 共用一個無依賴的 Node client，負責找出伺服器網址、讀設定檔裡的 token、呼叫 API。MCP 自己實作 stdio JSON-RPC 的 `initialize`、`tools/list`、`tools/call`。token 存在 repo 外、權限 600 的設定檔裡。

**測試 seam**
- 記憶標籤模組的單元測試：抓 frontmatter 解析和組裝的錯誤。
- 記憶 API handler 測試（沿用 repo 的 mock-require model doubles）：抓認證、範圍隔離、404 與 400 規則的錯誤。真實資料庫的路徑由 Proof plan 中的 curl 腳本覆蓋。
- 筆記寫入函式對 pool 中筆記的測試：抓 OT revision 與廣播的錯誤。
- MCP 的 stdio 測試：送 JSON-RPC，檢查 tools 清單與回傳格式。

## Proof plan

- 1：在瀏覽器產生 token、看到清單、撤銷，並截圖。
- 2 到 8、10：在本機伺服器上用 curl 跑完整的 CRUD 腳本，貼出狀態碼和回傳內容。
- 9：用 Playwright 開啟記憶筆記，接著用 curl 更新，截圖確認畫面不重新整理就出現新內容。
- 11 到 13：在 Claude Code 新 session 中呼叫 MCP 工具；確認寫入時會跳出權限提示；看 hook 輸出。也在 public 模式下跑一次 `memory_index`。
- 14：對本機 memory 跑匯入兩次，比較筆記數量。
- 15：確認設定檔內容，並在新 session 確認本機 memory 不再寫入。

## Out of scope

- 自動化測試和截圖工具（之後用 Playwright MCP 加 CodiMD 測試 skill 處理）。
- Codex 等其他 agent 的 hook 與說明。
- 和本機 memory 雙向同步。
- 語意搜尋。
- 修改既有的 `PUT /api/notes/:noteId` 行為。

## Open decisions

無。
