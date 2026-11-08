# 05: SessionStart 記憶索引、skill 與關閉本機 memory

**Blocked by:** 04
**Status:** done

## Build

開新 session 時會自動看到 global 範圍和目前專案範圍的記憶標題。Agent 照 skill 的規則提議寫記憶，本機 memory 不再寫入。

## Acceptance

- [x] hook 依 git remote 的 repo 名稱決定專案，印出記憶索引
- [x] CodiMD 連不上時只印一行提示，hook 以狀態 0 結束
- [x] skill 說明記憶範圍、記憶類型、什麼時候提議寫入、封存而不刪除
- [x] 全域設定 autoMemoryEnabled 為 false

## Proof

在 codimd repo 和另一個 repo 各執行一次 hook，貼出輸出；停掉伺服器再執行一次，確認不會報錯。
