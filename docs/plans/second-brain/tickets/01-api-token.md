# 01: API token 產生、撤銷與 Bearer 認證

**Blocked by:** None
**Status:** done

## Build

已登入的使用者可以在設定頁產生、查看、撤銷 API token。帶 Bearer token 呼叫 `/api/memory` 底下的 API 會認出帳號；token 無效時回 401 JSON。

## Acceptance

- [x] migration 建立 ApiTokens 資料表，資料庫只存雜湊值
- [x] 設定頁可以產生 token（只顯示一次）、列出、撤銷
- [x] 管理端點需要 session 登入；會改變狀態的端點（建立、撤銷）另外需要 CSRF token
- [x] `/api/memory/ping` 用有效 token 回 200 和帳號 id；token 缺少、錯誤或已撤銷時回 401 JSON
- [x] 每次成功認證都會更新最後使用時間

## Proof

`./bin/start-local --build`，在瀏覽器產生 token 並截圖，用 curl 呼叫 ping（有效 token、錯誤 token、撤銷後的 token），貼出狀態碼。
