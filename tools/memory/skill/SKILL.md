---
name: second-brain
description: Rules for reading and writing the user's second brain, the memory notes stored in CodiMD through the memory_* tools. Use when you learn something worth remembering across sessions (a user preference, a correction, a project fact, a useful reference), when the user says remember, 記住, 記下來, or 存到 CodiMD, when you are about to change or remove a memory, and at the end of a session to write a handoff.
---

# 第二大腦

CodiMD 是記憶的唯一真相來源。本機 auto memory 已關閉，不要寫 `~/.claude/projects/*/memory` 或 MEMORY.md。session 開始時注入的記憶索引只有標題，需要全文時用 `memory_read`。

## 記憶範圍

- `global`：跨專案都適用，例如使用者的偏好與習慣。
- `project:<repo>`：只屬於一個專案。`<repo>` 是 git remote 的 repo 名稱，沒有 remote 時用 git 根目錄名稱，與索引裡的專案標題相同。

拿不準時選 `project:<repo>`。

## 記憶類型

- `user`：使用者是誰、偏好什麼、怎麼工作。通常放 `global`。
- `feedback`：使用者對你做法的糾正或肯定，之後要照做。
- `project`：專案的事實、決策、限制，從程式碼看不出來的部分。
- `reference`：外部資源的位置，例如網址、儀表板、文件、帳號名稱。
- `doc`：較長的說明或筆記，例如操作步驟。
- `handoff`：交接給下一個 session 的進度與待辦。

## 怎麼寫

- 一則筆記只記一件事。標題寫成一句簡短的主張，例如「部署一律用 start-public」，不要寫「部署筆記」。
- 建立前先 `memory_search`。已有相關筆記就用 `memory_append` 或 `memory_update` 更新，不要重複建立。
- `feedback` 和 `project` 筆記在內容裡加兩行：
  - `**Why:**` 為什麼這樣做。
  - `**How to apply:**` 什麼情況下、怎麼套用。
- 不要存密碼、token、私鑰或其他機密。
- 內容寫成之後的 agent 看得懂的完整句子，附上日期。

## 匯入既有文件

- 要把本機的 Markdown 或文字檔存進 CodiMD 時，用 `memory_import_files` 傳檔案或資料夾路徑，由伺服器自己讀檔。不要把檔案全文貼進 `memory_create`，那會很慢。
- 一次呼叫可以匯入整個資料夾，只需要使用者同意一次。先用 `dryRun: true` 列出會建立哪些筆記，給使用者看過再正式匯入。
- 文件不必在 git repo 或 GitHub 上，也不用在內文加 GitHub 連結。
- 同一個檔案再匯入一次會被略過；要用新內容覆蓋時加 `update: true`。

## 一律經過使用者同意

每次寫入都會跳出權限提示，由使用者決定。先用一兩句話說明你想記什麼、放哪個範圍和類型，再呼叫工具。不要趁別的操作順手寫入，也不要在使用者拒絕後換個方式再寫。

## 封存，不刪除

記憶錯了或過時了，用 `memory_archive` 封存。沒有刪除工具，也不要把內容清空來代替刪除。內容只是需要修正時，用 `memory_update`。

## 交接

session 結束、工作沒做完時，提議寫交接：

- 每個專案只有一則 `handoff` 筆記。先 `memory_search` 找 `type: handoff` 和本專案範圍的筆記。
- 找到就用 `memory_append` 把新的一段加在結尾，開頭寫日期（YYYY-MM-DD）；找不到才建立。
- 寫做到哪裡、下一步、卡住的地方，以及相關的分支或檔案。
