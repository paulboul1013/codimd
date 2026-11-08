/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const HOOK = path.join(__dirname, '..', '..', 'tools', 'memory', 'session-start.js')
const TOKEN = 'test-token-0123456789'

function note (id, title, scope, type) {
  return { id, title, scope, type, tags: ['memory'], archived: false, updatedAt: '2026-11-08T00:00:00.000Z' }
}

// Serves GET /api/memory/notes from `notesByScope`; `hang` leaves every request unanswered.
function fakeMemoryApi ({ notesByScope = {}, hang = false, requests }) {
  return http.createServer((req, res) => {
    requests.push(req.url)
    if (hang) return
    const url = new URL(req.url, 'http://fake')
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { status: 'error', message: 'Invalid token' })
    if (url.pathname === '/api/memory/notes') return reply(200, { status: 'ok', notes: notesByScope[url.searchParams.get('scope')] || [] })
    reply(404, { status: 'error', message: 'Not found' })
  })
}

function listen (server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

function runHook ({ env, cwd, stdin }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [HOOK], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, stdout, stderr, elapsed: Date.now() - started }))
    if (stdin === null) return
    child.stdin.end(stdin)
  })
}

function gitRepo (parent, name, remote) {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir)
  execFileSync('git', ['init', '-q', dir])
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  return dir
}

describe('memory SessionStart hook', function () {
  this.timeout(15000)
  let home
  let server
  let requests

  beforeEach(function () {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codimd-memory-hook-'))
    requests = []
    server = null
  })

  afterEach(function (done) {
    fs.rmSync(home, { recursive: true, force: true })
    if (!server) return done()
    server.closeAllConnections()
    server.close(done)
  })

  function env (extra) {
    return Object.assign({ PATH: process.env.PATH, HOME: home }, extra)
  }

  it('prints the global and project index for the repo named by the stdin cwd', async function () {
    server = fakeMemoryApi({
      requests,
      notesByScope: {
        global: [note('aaa', 'Prefers zh-TW', 'global', 'user')],
        'project:other-repo': [note('bbb', 'Deploy with start-public', 'project:other-repo', 'project')]
      }
    })
    const url = await listen(server)
    const repo = gitRepo(home, 'checkout-dir', 'git@github.com:someone/Other-Repo.git')

    const result = await runHook({
      env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: TOKEN }),
      cwd: home,
      stdin: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup', cwd: repo })
    })

    assert.strictEqual(result.code, 0)
    assert.strictEqual(result.stderr, '')
    assert.deepStrictEqual(requests, ['/api/memory/notes?scope=global', '/api/memory/notes?scope=project%3Aother-repo'])
    assert.match(result.stdout, /^# 第二大腦記憶索引（CodiMD）\n/)
    assert.match(result.stdout, /memory_read/)
    assert.ok(result.stdout.endsWith('## global\n- [user] Prefers zh-TW (aaa)\n\n## project:other-repo\n- [project] Deploy with start-public (bbb)\n'), result.stdout)
    assert.ok(!result.stdout.includes(TOKEN))
  })

  it('falls back to the process cwd when stdin has no cwd', async function () {
    server = fakeMemoryApi({ requests })
    const url = await listen(server)
    const repo = gitRepo(home, 'codimd', null)

    const result = await runHook({ env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: TOKEN }), cwd: repo, stdin: '' })

    assert.strictEqual(result.code, 0)
    assert.deepStrictEqual(requests, ['/api/memory/notes?scope=global', '/api/memory/notes?scope=project%3Acodimd'])
    assert.ok(result.stdout.endsWith('## global\n(none)\n\n## project:codimd\n(none)\n'), result.stdout)
  })

  it('caps each group and says how many notes it left out', async function () {
    const many = Array.from({ length: 53 }, (_, i) => note(`g${i}`, `Fact ${i}`, 'global', 'reference'))
    server = fakeMemoryApi({ requests, notesByScope: { global: many } })
    const url = await listen(server)

    const result = await runHook({ env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: TOKEN }), cwd: home, stdin: '{}' })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /- \[reference\] Fact 49 \(g49\)\n（另有 3 則未列出，用 memory_search 查詢。）\n/)
    assert.ok(!result.stdout.includes('Fact 50'))
    assert.match(result.stdout, /\(No project detected/)
  })

  it('prints one line and exits 0 when CodiMD is unreachable', async function () {
    server = http.createServer()
    const url = await listen(server)
    await new Promise(resolve => server.close(resolve))
    server = null

    const result = await runHook({ env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: TOKEN }), cwd: home, stdin: '{}' })

    assert.strictEqual(result.code, 0)
    assert.strictEqual(result.stderr, '')
    assert.match(result.stdout, /^第二大腦：CodiMD 無法連線（.*ECONNREFUSED.*），本 session 沒有載入記憶索引。\n$/)
  })

  it('prints one line and exits 0 when no token is configured', async function () {
    const result = await runHook({ env: env({ CODIMD_URL: 'http://127.0.0.1:9' }), cwd: home, stdin: '{}' })

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /^第二大腦：CodiMD 無法連線（No CodiMD API token\..*），本 session 沒有載入記憶索引。\n$/)
  })

  it('prints one line without the token when CodiMD rejects it', async function () {
    server = fakeMemoryApi({ requests })
    const url = await listen(server)

    const result = await runHook({ env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: 'wrong-secret-token' }), cwd: home, stdin: '{}' })

    assert.strictEqual(result.code, 0)
    assert.strictEqual(result.stdout, '第二大腦：CodiMD 無法連線（Invalid token），本 session 沒有載入記憶索引。\n')
  })

  it('gives up within about five seconds when CodiMD never answers or stdin never closes', async function () {
    server = fakeMemoryApi({ requests, hang: true })
    const url = await listen(server)

    const result = await runHook({ env: env({ CODIMD_URL: url, CODIMD_MEMORY_TOKEN: TOKEN }), cwd: home, stdin: null })

    assert.strictEqual(result.code, 0)
    assert.ok(result.elapsed < 7000, `took ${result.elapsed} ms`)
    assert.match(result.stdout, /^第二大腦：CodiMD 無法連線（.*timed out.*），本 session 沒有載入記憶索引。\n$/)
  })
})
