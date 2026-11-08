#!/usr/bin/env node
'use strict'

// Claude Code SessionStart hook: prints the memory index, which Claude Code adds to the session context.

const { createClient, projectScope } = require('./client')
const { TOOLS } = require('./tools')

const DEADLINE_MS = 5000
const STDIN_WAIT_MS = 1000
const GROUP_CAP = 50
const HEADER = [
  '# 第二大腦記憶索引（CodiMD）',
  '以下是 CodiMD 第二大腦裡 global 範圍與目前專案範圍的記憶筆記標題，不含已封存的筆記。',
  '需要全文時用 memory_read 讀取。寫入一律透過 memory_* 工具，每次都要經過使用者同意；規則見 second-brain skill。'
].join('\n')

const memoryIndex = TOOLS.find(tool => tool.name === 'memory_index')

function readStdin () {
  return new Promise(resolve => {
    let data = ''
    const finish = () => {
      clearTimeout(timer)
      process.stdin.pause()
      resolve(data)
    }
    const timer = setTimeout(finish, STDIN_WAIT_MS)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

function hookCwd (input) {
  try {
    const { cwd } = JSON.parse(input)
    if (typeof cwd === 'string' && cwd) return cwd
  } catch (error) {}
  return process.cwd()
}

// memory_index renders each scope as "## <scope>" followed by one "- " line per note.
function capGroups (index) {
  return index.split('\n\n').map(section => {
    const lines = section.split('\n')
    const notes = lines.filter(line => line.startsWith('- '))
    if (notes.length <= GROUP_CAP) return section
    const kept = lines.filter(line => !line.startsWith('- ')).concat(notes.slice(0, GROUP_CAP))
    return kept.join('\n') + `\n（另有 ${notes.length - GROUP_CAP} 則未列出，用 memory_search 查詢。）`
  }).join('\n\n')
}

async function buildIndex () {
  const cwd = hookCwd(await readStdin())
  const index = await memoryIndex.run(createClient(), {}, projectScope(cwd))
  return `${HEADER}\n\n${capGroups(index)}\n`
}

// fetch() reports every network failure as "fetch failed" and keeps the real reason in cause.
function describe (error) {
  const cause = error.cause && (error.cause.code || error.cause.message)
  return cause ? `${error.message}: ${cause}` : error.message
}

function failureLine (reason) {
  return `第二大腦：CodiMD 無法連線（${String(reason).replace(/\s+/g, ' ').trim()}），本 session 沒有載入記憶索引。\n`
}

function main () {
  const deadline = new Promise(resolve => setTimeout(() => resolve(failureLine(`timed out after ${DEADLINE_MS / 1000} seconds`)), DEADLINE_MS))
  const work = buildIndex().catch(error => failureLine(describe(error)))
  Promise.race([work, deadline]).then(text => process.stdout.write(text, () => process.exit(0)))
}

main()
