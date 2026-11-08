# 04: 全域 MCP server

**Blocked by:** 02
**Status:** done

## Build

在任何專案的 Claude Code 中，都能用 memory_* 工具操作第二大腦。寫入類工具每次都會跳出權限提示。

## Acceptance

- [x] 無依賴的 Node client：先連 localhost:3000，連不上再從 GitHub Pages 查出 tunnel 網址；token 從權限 600 的設定檔讀取
- [x] MCP 透過 stdio 提供 memory_index、memory_search、memory_read、memory_create、memory_update、memory_append、memory_archive
- [x] 以 user scope 註冊；只有讀取類工具放進允許清單
- [x] 兩個網址都連不上時，工具回傳清楚的錯誤

## Proof

stdio 測試：送 JSON-RPC，檢查 tools/list 和 tools/call。在新的 Claude Code session 搜尋並建立一則記憶，確認寫入時會跳出權限提示。
