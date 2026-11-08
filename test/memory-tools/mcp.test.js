/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')

const MCP = path.join(__dirname, '..', '..', 'tools', 'memory', 'mcp.js')

const NOTES = {
  aaa: { id: 'aaa', title: 'Prefers zh-TW', scope: 'global', type: 'user', tags: ['memory'], archived: false, updatedAt: '2026-11-08T00:00:00.000Z' },
  bbb: { id: 'bbb', title: 'Deploy steps', scope: 'project:codimd', type: 'project', tags: ['memory', 'ops'], archived: false, updatedAt: '2026-11-08T00:00:00.000Z' }
}

function fakeMemoryApi (requests) {
  return http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const url = new URL(req.url, 'http://fake')
      if (req.headers.authorization !== 'Bearer test-token') return reply(401, { status: 'error', message: 'Invalid token' })
      if (req.method === 'GET' && url.pathname === '/api/memory/notes') {
        const scope = url.searchParams.get('scope')
        return reply(200, { status: 'ok', notes: Object.values(NOTES).filter(note => !scope || note.scope === scope) })
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/notes') {
        return reply(409, { status: 'error', message: 'A memory note with this title already exists' })
      }
      reply(404, { status: 'error', message: 'Note not found' })
    })
  })
}

// Speaks newline-delimited JSON-RPC to a spawned mcp.js and pairs responses by id.
function startMcp (env, cwd) {
  const child = spawn(process.execPath, [MCP], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const stdoutLines = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`mcp.js exited with ${code}: ${stderr}`))
    pending.clear()
  })
  readline.createInterface({ input: child.stdout }).on('line', line => {
    stdoutLines.push(line)
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })
  function waitFor (id) {
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  let nextId = 1
  return {
    child,
    stdoutLines,
    send (line) { child.stdin.write(line + '\n') },
    notify (method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') },
    call (method, params) {
      const id = nextId++
      const response = waitFor(id)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return response
    },
    waitFor
  }
}

describe('memory MCP server over stdio', function () {
  this.timeout(15000)
  let server
  let requests
  let home
  let mcp

  beforeEach(function (done) {
    requests = []
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codimd-memory-mcp-'))
    server = fakeMemoryApi(requests).listen(0, '127.0.0.1', () => {
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        CODIMD_MEMORY_TOKEN: 'test-token',
        CODIMD_URL: `http://127.0.0.1:${server.address().port}`
      }
      mcp = startMcp(env, home)
      done()
    })
  })

  afterEach(function (done) {
    mcp.child.kill()
    fs.rmSync(home, { recursive: true, force: true })
    server.close(done)
  })

  it('initializes, lists the memory tools, and searches through the REST API', async function () {
    const init = await mcp.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.deepStrictEqual(init.result.protocolVersion, '2025-03-26')
    assert.deepStrictEqual(init.result.capabilities, { tools: {} })
    assert.strictEqual(init.result.serverInfo.name, 'codimd-memory')
    mcp.notify('notifications/initialized')

    const list = await mcp.call('tools/list', {})
    assert.deepStrictEqual(list.result.tools.map(tool => tool.name), [
      'memory_index', 'memory_search', 'memory_read', 'memory_create', 'memory_import_files', 'memory_update', 'memory_append', 'memory_archive'
    ])
    for (const tool of list.result.tools) assert.strictEqual(tool.inputSchema.type, 'object')

    const search = await mcp.call('tools/call', { name: 'memory_search', arguments: { q: 'deploy', type: 'project', includeArchived: true } })
    assert.deepStrictEqual(search.result.content, [{
      type: 'text',
      text: '- [user] Prefers zh-TW (aaa) global, tags: memory\n- [project] Deploy steps (bbb) project:codimd, tags: memory, ops'
    }])
    assert.strictEqual(search.result.isError, undefined)
    assert.deepStrictEqual(requests.map(request => [request.url, request.authorization]), [
      ['/api/memory/notes?q=deploy&type=project&includeArchived=true', 'Bearer test-token']
    ])
    assert.deepStrictEqual(mcp.stdoutLines.map(line => JSON.parse(line).jsonrpc), ['2.0', '2.0', '2.0'])
  })

  it('groups the index into global and the requested project', async function () {
    const index = await mcp.call('tools/call', { name: 'memory_index', arguments: { project: 'codimd' } })
    assert.strictEqual(index.result.content[0].text, '## global\n- [user] Prefers zh-TW (aaa)\n\n## project:codimd\n- [project] Deploy steps (bbb)')
  })

  it('returns API errors as tool errors with the server message', async function () {
    const read = await mcp.call('tools/call', { name: 'memory_read', arguments: { id: 'missing' } })
    assert.deepStrictEqual(read.result, { content: [{ type: 'text', text: 'Note not found' }], isError: true })

    const create = await mcp.call('tools/call', { name: 'memory_create', arguments: { title: 'Deploy steps', body: 'x', scope: 'global', type: 'doc' } })
    assert.deepStrictEqual(create.result, { content: [{ type: 'text', text: 'A memory note with this title already exists' }], isError: true })
    assert.deepStrictEqual(JSON.parse(requests[1].body), { title: 'Deploy steps', body: 'x', scope: 'global', type: 'doc' })
  })

  it('rejects bad arguments without calling the API', async function () {
    const call = await mcp.call('tools/call', { name: 'memory_create', arguments: { title: 't', body: 'b', scope: 'Global', type: 'doc' } })
    assert.strictEqual(call.result.isError, true)
    assert.match(call.result.content[0].text, /^scope must match/)
    assert.strictEqual(requests.length, 0)
  })

  it('answers protocol errors per JSON-RPC', async function () {
    const unknownTool = await mcp.call('tools/call', { name: 'memory_delete', arguments: {} })
    assert.strictEqual(unknownTool.error.code, -32602)

    const unknownMethod = await mcp.call('resources/list', {})
    assert.strictEqual(unknownMethod.error.code, -32601)

    const parseError = mcp.waitFor(null)
    mcp.send('{not json')
    assert.strictEqual((await parseError).error.code, -32700)

    const pong = await mcp.call('ping')
    assert.deepStrictEqual(pong.result, {})
  })
})
