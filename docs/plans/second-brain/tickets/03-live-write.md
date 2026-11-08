# 03: 筆記開著時透過即時協作寫入

**Blocked by:** 02
**Status:** done

## Build

記憶筆記在瀏覽器開著時，API 寫入會變成一次即時協作的 operation，畫面不用重新整理就更新。

## Acceptance

- [x] 筆記在 pool 中時，寫入會以 text operation 套用到目前 revision 並廣播
- [x] 瀏覽器中其他人尚未存檔的編輯不會被覆蓋
- [x] 筆記被標為 dirty，之後由既有的工作存回資料庫
- [x] 筆記不在 pool 中時，仍然走 02 的資料庫路徑

## Proof

用 Playwright 打開記憶筆記，接著 curl 追加一段文字，截圖確認新內容出現，而且頁面沒有重新整理。
