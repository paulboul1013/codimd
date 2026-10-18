# Markdown 匯入的 pstack 詳細流程

日期：2026-10-18。需求依據：[實作計畫](../plans/markdown-import.md)。

## 0. 範圍與工作區

使用者授權依既有計畫實作，並保存詳細流程與重點報告。起始工作區已有未追蹤的 `CONTEXT.md` 與 `docs/plans/markdown-import.md`。保留既有內容，不修改 README，不提交或合併。

採用的 pstack skills：`how`、`architect`、`blast-radius`、`principle-build-the-lever`、`principle-prove-it-works`、`technical-writing`、`unslop`。另採用測試先行、Playwright 與安全邊界檢查。這是依任務選用的 skill 流程，沒有假設存在單一 pstack 執行器。

## 1. How：沿入口追查現況

| 入口或擁有者 | 來源 | 已確認行為 |
| --- | --- | --- |
| 歷史工具列 | `public/views/index/body.ejs` | JSON 匯入在桌面工具列內，未有限制副檔名 |
| 歷史匯入事件 | `public/js/cover.js` | FileReader 讀取 JSON 並合併歷史，不建立筆記 |
| HTTP 邊界 | `lib/routes.js`、`lib/utils.js` | POST /new 使用文字 parser，接受 Markdown 與純文字，限制 10 MiB |
| 建立流程 | `lib/response.js:newNote` | 檢查 documentMaxLength、移除 CR、檢查資格、建立、更新登入者歷史、重新導向 |
| 模型生命週期 | `lib/models/note.js` | 空正文載入範本，beforeCreate 決定權限，afterCreate 儲存初始修訂 |
| 標題規則 | `Note.parseNoteTitle` | front matter 優先，其次 H1，再使用 Untitled |
| 翻譯 | `app.js`、`locales/*.json` | EJS 呼叫 __，以英文鍵保存文案 |

差異：非空正文建立時沒有寫入 title。使用者可能在首次編輯之前讀到空的資料庫標題。需要在 controller 建立資料時重用現有 parser。

## 2. Architect：先確定介面與責任

呼叫方式：`setupMarkdownImport({ input, button, error, serverURL })`。

- EJS 擁有可見文字、資格顯示、單檔選擇器與翻譯後的錯誤訊息。
- 首頁只負責將 DOM 元素與部署網址傳入匯入模組。
- 匯入模組擁有 idle → reading → posting → navigating 的流程。失敗回到 idle，清空 input，恢復控制項。忙碌時不接受第二次處理。
- FileReader 與 fetch 是瀏覽器邊界。只檢查副檔名，不依賴 MIME。UTF-8 文字只用移除 CR 的結果判斷是否為空，送出原始讀取文字。
- POST /new 擁有筆記建立與授權。匯入模組不自行指定 owner、permission 或 revision。
- 導頁只接受成功且經過重新導向的回應，最終 URL 必須符合目前站點、部署路徑與 22 字元編碼筆記 ID，拒絕首頁登入跳轉與其他 URL。

### 比較過的設計

| 方案 | 結果與取捨 |
| --- | --- |
| 全部寫進 cover.js | 修改檔案較少，但讀檔及網路失敗分支依賴整個首頁初始化，難以獨立重跑驗證 |
| 獨立匯入模組，由 cover.js 接線 | 採用。模組直接管理一個完整操作，能用相同入口測試瀏覽器邊界，不需抽象通用上傳框架 |
| 先建立空白筆記，再更新內容 | 不採用。增加寫入、範本與部分失敗狀態，偏離計畫 |

不新增 API、依賴、資料欄位或相容層。既有 JSON 匯入不改寫。

## 3. Blast radius：必須成立的安全事實

1. 空正文不提供解析後的 title，模型仍能載入範本與標題。
2. 非空 POST /new 的其他呼叫者也會取得正文標題，這是共用建立路徑的行為修正。
3. 權限與初始修訂仍由既有模型 hooks 擁有。
4. HTTP 200 的登入頁不能當成匯入成功。
5. 子路徑部署必須同時限定 POST 與最終導頁範圍。
6. 網路失敗不自動重送。伺服器可能已建立筆記，提示需說明不確定性。

後續以測試和實機證據逐項補上結果。

## 4. 測試先行與實作紀錄

### Red → Green

1. 先新增 `test/response/newNote.test.js`。使用真正的 Note 標題解析器，以 mock-require 隔離資料庫。初次結果為 7 passing、4 failing，失敗都是建立資料缺少 title。
2. 新增前端行為測試。模組尚未存在時先出現 Cannot find module。完成模組及接線後，37 個專項測試通過。
3. 獨立審查發現登入導向不帶尾斜線。補上實際後端產生的 `/team?next=%2Fnew` 測試，先看到 failed 與 login 不符的失敗，再修正判定。專項測試增至 39 passing。
4. 首次 npm test 的 lint 指出測試物件排版問題。只對新增測試執行 Standard 自動排版，再重跑 lint。
5. 第一次正式編譯顯示 default export 不存在。專案的 Babel transform-runtime 會插入 ES import，新增 CommonJS 前端模組因此變成混合模組。改用鄰近前端的 `export default`，測試用既有 Babel 的 CommonJS transform 載入，沒有新增依賴。最終正式編譯沒有此警告。

### 測試環境與失敗調查

- Node 使用既有 `/tmp/codimd-jfif-node16/node-v16.20.2-linux-x64/bin`，版本 v16.20.2。
- 原始 npm run build 啟動大量平行壓縮程序，與測試互相競爭。停止本次建置及其工作程序，在暫存 preload 將 os.cpus 回傳數量限為 2，再執行相同 npm run build。沒有修改儲存庫建置設定。
- 多次預設 npm test 出現 realtime 舊測試的 2 秒逾時，失敗位置會變動。從 HEAD 匯出到獨立目錄並共用 node_modules，未修改基準也出現 realtime#disconnect 逾時，結果為 128 passing、1 failing。
- 10 秒 timeout 仍出現既有 realtime 逾時。使用 `npm run coverage -- --no-timeouts` 後，完整工作區測試為 186 passing，沒有跳過測試或刪除斷言。預設 npm test 仍列為未通過，不能用這次結果冒稱原命令通過。
- 執行紀錄中出現負的測試時間和瀏覽器時間戳跳動。5 秒 wall clock 與 monotonic clock 取樣期間則正常，不能據此斷言已找到所有逾時的根因。
- 工作區既有被 gitignore 排除的 `test/imageRouter/` 也會被 npm test 收入。本次沒有修改或移除這些檔案。

### 五軸獨立審查

依 `code-review-and-quality` 的 Multi-Model Review Pattern 使用唯讀審查代理。審查涵蓋正確性、閱讀負擔、架構、安全與效能，沒有要求代理修改共享檔案。

- Important：子路徑登入導向缺尾斜線。已補 Red 測試並修正。
- 驗收工具修正：無標題分頁應顯示 CodiMD 預設名稱，資料庫才存 Untitled。兩者分別檢查。
- 驗收工具修正：JSON 歷史 fixture 在匯入前必須不存在，避免重跑時誤判成功。
- 已排除新增任意導頁、HTML 注入、重複建立流程與歷史 JSON handler 共用問題。
- Consider：同步 title parser 位於 create 的 Promise catch 之外。現有 extractMeta 已自行處理 YAML 解析失敗，未找到正常字串能觸發未捕捉例外，不將假設列為已證實缺陷。

### 實機啟動調整

SQLite driver 安裝在暫存目錄，由 NODE_PATH 提供。沒有修改 package.json、lockfile 或正式設定。隔離 app 綁定 127.0.0.2:3219，公開測試 proxy 綁定 127.0.0.1:3219，將 /team 前綴移除後轉發，符合既有子路徑部署方式。

啟動調整過程發現 config 已 deepFreeze，不能靠啟動後改 port。改以不同 loopback 位址使用相同 port。正式模式會快取 EJS，因此建置完成後重啟本次隔離 app，確認頁面載入最終 bundle。這些都是驗證環境修正，未改動產品設定程式。

## 5. 可重跑驗證工具

交付三個可重跑的驗證工具：

| 工具 | 作用 | 前提 |
| --- | --- | --- |
| `bin/check-markdown-import-browser.js` | 產生 fixtures，或由 Playwright CLI 執行 48 項操作與斷言 | 全新瀏覽器 context、隔離服務允許匿名建立及 email 註冊、預設權限 editable、documentMaxLength=100000 |
| `bin/check-markdown-import-login.js` | 驗證入口資格、過期登入、留在歷史頁、只送一次與恢復控制項 | 全新 context、隔離服務禁止匿名建立、允許 email 註冊 |
| `bin/check-markdown-import-db.py` | 唯讀檢查 SQLite 中的 title、owner、permission 與初始 revision | 指向上述隔離資料庫，已完成前端驗收 |

前兩個檔案是 Node CommonJS 驗證工具，產品前端模組則使用 ES module。工具會註冊測試帳號並建立筆記，只對可丟棄的測試環境執行。

### 重跑命令

從 repository root 執行。產品命令使用 Node v16.20.2。Playwright CLI 使用環境可執行的較新 Node，未安裝成專案依賴。

```bash
npm run lint
npm run jsonlint
./node_modules/.bin/mocha --require intelli-espower-loader --exit test/response/newNote.test.js test/frontend/markdown-import.test.js
npm test
npm run coverage -- --no-timeouts
npm run build
```

最後一個 coverage 命令是調查計時失敗時的額外驗證，不取代預設 npm test。若建置平行程序耗盡主機資源，可在儲存庫外建立 preload，再透過 NODE_OPTIONS 指定：

```js
const os = require('os')
const cpus = os.cpus()
os.cpus = () => cpus.slice(0, 2)
```

正式模式會快取 EJS，編譯完成後再啟動隔離服務。允許匿名的測試網址是 `http://127.0.0.1:3219/team`，proxy 轉發至 `127.0.0.2:3219` 並移除 `/team`。登入失效測試網址是 `http://127.0.0.1:3220`，urlPath 為空。兩者共用暫存 SQLite。資料庫 driver 用 `npm install --prefix /tmp/codimd-markdown-import-runtime --no-audit --no-fund sqlite3@5.1.7` 安裝，再以 NODE_PATH 提供，不改動專案依賴。

測試服務的 defaultNotePath 應指向 UTF-8 檔案，內容如下，最後一行也要有換行：

```markdown
# 預設範本

範本正文
```

其他必要設定是 useCDN=false、allowEmailRegister=true、autoVersionCheck=false、defaultPermission=editable。session secret 僅放暫存設定。不要使用正式資料庫。

下列 CLI 路徑是本次環境的 Playwright skill wrapper，其他安裝位置請替換。先 open 取得 snapshot，再執行工具：

```bash
node bin/check-markdown-import-browser.js
PWCLI=/home/paulboul/.codex/skills/playwright/scripts/playwright_cli.sh
bash "$PWCLI" -s=markdown-import-check open http://127.0.0.1:3219/team
bash "$PWCLI" -s=markdown-import-check run-code "$(node -p "require('./bin/check-markdown-import-browser.js').toString()")"
python3 bin/check-markdown-import-db.py /tmp/codimd-markdown-import-runtime/codimd.sqlite
bash "$PWCLI" -s=markdown-import-expired open http://127.0.0.1:3220/
bash "$PWCLI" -s=markdown-import-expired run-code "$(node -p "require('./bin/check-markdown-import-login.js').toString()")"
```

每輪使用新的 CLI session 名稱，避免既有 JSON 歷史 fixture 影響驗收。資料庫腳本會檢查重複匯入產生的每一份筆記，匯入語意本來就是建立新筆記。

### 實機驗收結果

| 項目 | 實際結果 | 證據 |
| --- | --- | --- |
| 空檔、CR-only、副檔名拒絕、取消 | 沒有建立請求，控制項恢復 | [瀏覽器結果](markdown-import-evidence/browser-result.json) |
| documentMaxLength 與 10 MiB parser | 都由原有後端拒絕 | 同上 |
| 500 與網路中斷 | 顯示訊息，沒有自動重送。這兩個失敗使用 Playwright route 注入 | 同上 |
| 三種大小寫副檔名、中文與 CRLF | 各建立一次，下載正文一致 | 同上 |
| 空白與 LF | 保留非空語意，資料庫 title 為 Untitled | [資料庫結果](markdown-import-evidence/database.json) |
| 初始修訂 | API 的 JSON content 為正文，資料庫初始正文可能在 lastContent | 瀏覽器與資料庫結果 |
| GET /new、空 POST /new | 保留測試部署的非空預設範本 | 瀏覽器結果 |
| 登入者 | server history 標題與標籤正確，owner 有值，permission=editable | 瀏覽器與資料庫結果 |
| 訪客 | owner 為空，permission=freely | 資料庫結果 |
| JSON 歷史匯入 | 無副檔名 fixture 成功匯入 | 瀏覽器結果 |
| 禁止匿名及登入失效 | 訪客看不到入口，過期登入不導頁，顯示登入提示，只送一次請求 | [登入結果](markdown-import-evidence/login-result.json) |
| 登入失效是否寫入 | 測試前後均為 18 份筆記，沒有建立 | [資料庫筆數](markdown-import-evidence/login-database-count.json) |
| 子路徑及窄螢幕 | /team 的 POST 與導頁正確，375px 螢幕按鈕可操作 | 瀏覽器結果與截圖 |

### 視覺檢查修正

第一輪截圖發現原生 input 的 hidden 屬性被 Bootstrap 的 input 顯示規則蓋過。保留 hidden 並加入既有 Bootstrap 的 hidden class。加上實機斷言確認原生選檔欄位不可見，再重跑完整 48 項驗收。另等待歷史區塊 fadeIn 完成才截圖，避免把過場的低透明度當成最終畫面。

已開啟檢視桌面、空檔、成功頁面及窄螢幕截圖。另實際點擊文字按鈕，Playwright 回報原生 File chooser 開啟。CLI 的 snapshot 與 console 記錄已移至 `output/playwright/cli/`，原始輸出保留當時路徑。驗收中的 401、413、500 及 network failure 是預期的拒絕與故障案例；最終 bundle 未出現未捕捉的 JavaScript 例外。

- [歷史工具列](../../output/playwright/markdown-import-history.png)
- [空檔提示](../../output/playwright/markdown-import-empty.png)
- [成功匯入](../../output/playwright/markdown-import-success.png)
- [窄螢幕](../../output/playwright/markdown-import-mobile.png)
- [登入失效](../../output/playwright/markdown-import-login.png)

## 6. 最終審查與限制

需求已實作，未發現尚待處理的本次功能缺陷。產品程式沒有新增依賴、API 或資料庫欄位，未改寫歷史 JSON 匯入，README 與生成 bundle 均未納入變更。

| 驗證 | 結果 |
| --- | --- |
| 專項回歸 | 39 passing |
| 瀏覽器驗收 | 48 項通過，加上登入失效 5 項通過 |
| 真正資料庫 | 標題、正文、擁有者、權限、初始修訂一致 |
| npm run lint、npm run jsonlint | 通過，24 個 locale 各包含 8 個新翻譯鍵 |
| npm run build | 通過。仍有 Browserslist 資料過期與資產大小警告 |
| 預設 npm test | 未通過。最新一輪為 158 passing、1 failing，realtime#socket event 的 beforeEach 逾時。未修改 HEAD 的獨立基準也重現 realtime 逾時 |
| 完整 coverage，停用計時限制 | 186 passing，所有斷言保留，沒有 skip |

### 已排除與剩餘限制

- 已用實機及資料庫證明沒有插入中間範本版本，空檔也不送出建立請求。
- 限制來源、子路徑與筆記 ID 的 URL 檢查有專項測試，實機確實走過 /team 部署及登入失效。
- 讀檔 onerror、onabort、同步 throw 由單元測試注入。沒有在作業系統層強制重現磁碟讀取故障。
- 500 與網路錯誤的瀏覽器案例使用 route 注入，沒有停用真實資料庫來製造故障。
- 網路中斷後仍可能已建立筆記。UI 明確要求先查看歷史，程式不重送。此功能沒有設計伺服器端冪等鍵。
- 預設完整測試的計時問題仍未修正，合併前需在穩定環境重跑 npm test。沒有為本功能改動舊測試的 timeout 或業務邏輯。
- 沒有新增 fetch polyfill，沿用需求範圍及專案現況。
- 實作驗收當時尚未提交、推送、部署或合併。獨立代理審查不能替代儲存庫要求的兩位開發者 sign-off。

命令輸出保存在 [驗證證據目錄](markdown-import-evidence/)，包括 Red、Green、預設完整測試、未修改基準、完整 coverage 與正式編譯輸出。提交前僅移除文字輸出的行尾空白與末端空白行，保留測試結果及錯誤內容。

驗證完成後已停止本次啟動的兩個隔離 app、兩個 proxy 及四個 Playwright session，保留工作區原有服務。暫存資料庫未納入變更。

## 7. 後續手動測試與提交

依使用者要求，另行啟動 http://localhost:3000 的手動測試服務，允許訪客建立筆記。服務使用 Node v16.20.2 與儲存庫外的獨立 SQLite，已確認 HTTP 200 及最新前端資產。

使用者隨後授權本次 Git commit。提交前再次執行 lint 與 39 項專項回歸，均通過。提交包含產品程式、翻譯、測試、驗證工具、計畫、術語表、pstack 報告、驗證輸出與 UI 截圖。可由工具重新產生的測試輸入已移至儲存庫外保留。提交使用目前 Git 身分及 DCO sign-off，未執行 push 或 merge。
