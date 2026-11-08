# 02: 記憶筆記 CRUD、搜尋與封存（離線路徑）

**Blocked by:** 01
**Status:** done

## Build

Agent 帶 token 可以建立、搜尋、讀取、更新、追加、封存自己的記憶筆記。這張票只處理筆記沒有人開著的情況。

## Acceptance

- [x] 建立的筆記是 private、擁有者正確、frontmatter 標籤含 memory、記憶範圍、記憶類型
- [x] 記憶範圍或記憶類型不合法時回 400
- [x] 搜尋支援記憶範圍、記憶類型、關鍵字，預設排除 archived
- [x] 讀取回傳全文和中繼資料
- [x] 更新後少了 memory 標籤時回 400；追加內容接在結尾
- [x] 封存會加上 archived 標籤
- [x] 一般筆記和別人的筆記一律回 404
- [x] 寫入會留下一筆 revision

## Proof

在本機伺服器用 curl 跑完整的 CRUD 腳本，貼出每一步的狀態碼和回傳內容；另外在瀏覽器打開建立的筆記確認內容。
