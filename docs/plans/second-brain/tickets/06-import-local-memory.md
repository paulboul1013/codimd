# 06: 匯入本機 memory

**Blocked by:** 04
**Status:** done

## Build

使用者執行一次匯入腳本，就能把 ~/.claude/projects/*/memory 的記憶搬進 CodiMD。

## Acceptance

- [x] 讀取各記憶檔的 frontmatter（name、description、type）和內文
- [x] user 類型歸 global 範圍，其他類型歸所屬專案範圍
- [x] 重跑不會重複建立（依 name 比對）
- [x] 支援 --dry-run，列出將要建立的筆記

## Proof

先跑 --dry-run 並貼出清單，再實際匯入兩次，比較兩次執行後的筆記數量。
