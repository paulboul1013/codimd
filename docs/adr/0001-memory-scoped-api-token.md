# Agent 用只限記憶筆記的 API token 存取第二大腦

Agent 要在任何專案中讀寫第二大腦，而 CodiMD 會透過 Cloudflare tunnel 對外公開。我們新增一種綁定帳號、可撤銷的 API token，由使用者在網頁設定頁產生，資料庫只存雜湊值。這種 token 只能存取標籤含 `memory` 的筆記，而且 API 不接受移除 `memory` 標籤的寫入。這樣 token 即使外洩，也碰不到一般筆記。

## Considered Options

- 用帳號密碼登入取得 session cookie：不需要 migration，但密碼會散落在各個 agent 的設定中，session 過期時還得重新登入。
- token 可以存取整個帳號：比較有彈性，但 API 對網路公開，token 外洩時損害最大。

## Consequences

- 「是不是記憶筆記」取決於筆記內容目前的標籤。使用者在網頁上替一般筆記加上 `memory` 標籤，等於把那份筆記交給 agent。
- 寫入是否需要使用者同意，靠 Claude Code 的工具權限提示控管，不是靠 token 本身：MCP 的寫入類工具不放進允許清單。
