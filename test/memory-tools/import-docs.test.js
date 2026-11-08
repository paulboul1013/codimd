/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { collectDocuments, importDocuments, readDocument, scopeForDir, markerFor } = require('../../tools/memory/importDocs')
const { run } = require('../../tools/memory/import-docs')
const { TOOLS } = require('../../tools/memory/tools')

function tempDir (name) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)))
}

function write (file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// An in-memory memory API that stores notes the way the server does: front matter, then `# title`.
function fakeApi () {
  const notes = new Map()
  const calls = []
  let next = 1
  function handle (method, route, body) {
    calls.push({ method, route, body })
    const url = new URL(route, 'http://fake')
    const id = decodeURIComponent(url.pathname.split('/')[2] || '')
    if (method === 'GET' && url.pathname === '/notes') {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      return { status: 'ok', notes: [...notes.values()].filter(note => note.content.toLowerCase().includes(q)).map(({ id }) => ({ id })) }
    }
    if (method === 'GET' && notes.has(id)) return { status: 'ok', note: notes.get(id) }
    if (method === 'POST' && url.pathname === '/notes') {
      const note = {
        id: `n${next++}`,
        scope: body.scope,
        type: body.type,
        tags: body.tags,
        url: `http://fake/n${next - 1}`,
        content: `---\ntags: memory, ${body.scope}, ${body.type}\n---\n# ${body.title}\n\n${body.body}\n`
      }
      notes.set(note.id, note)
      return { status: 'ok', note }
    }
    if (method === 'PUT' && notes.has(id)) {
      notes.get(id).content = body.content
      return { status: 'ok', note: notes.get(id) }
    }
    throw new Error(`unexpected ${method} ${route}`)
  }
  return { notes, calls, client: { request: async (method, route, body) => handle(method, route, body) } }
}

describe('memory import-docs: reading documents', function () {
  let dir
  beforeEach(function () { dir = tempDir('codimd-docs-') })
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }) })

  it('takes the title from the first heading and drops it from the body', function () {
    const file = path.join(dir, 'ch01.md')
    write(file, '# 第一章：最小編譯器\r\n\r\n內文第一行\r\n')
    assert.deepStrictEqual(readDocument(file), { title: '第一章：最小編譯器', body: `內文第一行\n\n${markerFor(file)}` })
  })

  it('falls back to the file name and keeps the body whole', function () {
    const file = path.join(dir, 'notes.txt')
    write(file, 'no heading here\n## sub\n')
    assert.deepStrictEqual(readDocument(file), { title: 'notes', body: `no heading here\n## sub\n\n${markerFor(file)}` })
  })

  it('keeps the heading in the body when a title is given', function () {
    const file = path.join(dir, 'a.md')
    write(file, '# Heading\nbody\n')
    assert.strictEqual(readDocument(file, 'Custom').body, `# Heading\nbody\n\n${markerFor(file)}`)
  })

  it('needs no git repo and adds no GitHub link', function () {
    const file = path.join(dir, 'Local Notes', 'plan.md')
    write(file, '# Plan\nstep\n')
    const [doc] = collectDocuments([file])
    assert.strictEqual(doc.scope, 'project:local-notes')
    assert.ok(!readDocument(file).body.includes('github'))
  })

  it('uses the repo name when the directory is in a git repo', function () {
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/someone/Lemon_CC.git'])
    fs.mkdirSync(path.join(dir, 'docs'))
    assert.strictEqual(scopeForDir(path.join(dir, 'docs')), 'project:lemon_cc')
  })

  it('expands directories to document files, skipping dot directories and node_modules', function () {
    write(path.join(dir, 'b.md'), 'b')
    write(path.join(dir, 'a', 'c.markdown'), 'c')
    write(path.join(dir, 'image.png'), 'x')
    write(path.join(dir, '.git', 'x.md'), 'x')
    write(path.join(dir, 'node_modules', 'y.md'), 'y')
    const files = collectDocuments([dir, path.join(dir, 'b.md')], { scope: 'global' }).map(doc => path.relative(dir, doc.file))
    assert.deepStrictEqual(files, [path.join('a', 'c.markdown'), 'b.md'])
  })

  it('names a missing path', function () {
    assert.throws(() => collectDocuments(['nope.md'], { cwd: dir }), /nope\.md: no such file or directory/)
  })
})

describe('memory import-docs: writing notes', function () {
  let dir
  beforeEach(function () { dir = tempDir('codimd-docs-') })
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }) })

  it('creates one note per file with the imported tag, then skips them on a rerun', async function () {
    write(path.join(dir, 'a.md'), '# A\nalpha\n')
    write(path.join(dir, 'b.md'), '# B\nbeta\n')
    const api = fakeApi()
    const documents = collectDocuments([dir], { scope: 'project:demo' })
    const first = await importDocuments(api.client, documents, { tags: ['kb'] })
    assert.deepStrictEqual(first.map(r => r.action), ['create', 'create'])
    const posts = api.calls.filter(call => call.method === 'POST')
    assert.deepStrictEqual(posts.map(call => [call.body.title, call.body.type, call.body.scope, call.body.tags]), [
      ['A', 'doc', 'project:demo', ['imported', 'kb']],
      ['B', 'doc', 'project:demo', ['imported', 'kb']]
    ])
    const second = await importDocuments(api.client, documents)
    assert.deepStrictEqual(second.map(r => r.action), ['skip', 'skip'])
    assert.strictEqual(api.notes.size, 2)
  })

  it('updates the content of an imported note and keeps its front matter', async function () {
    const file = path.join(dir, 'a.md')
    write(file, '# A\nold\n')
    const api = fakeApi()
    const documents = collectDocuments([file], { scope: 'project:demo' })
    await importDocuments(api.client, documents)
    write(file, '# A2\nnew\n')
    const [result] = await importDocuments(api.client, documents, { update: true })
    assert.strictEqual(result.action, 'update')
    assert.strictEqual(api.notes.get('n1').content, `---\ntags: memory, project:demo, doc\n---\n# A2\n\nnew\n\n${markerFor(file)}\n`)
  })

  it('writes nothing in a dry run', async function () {
    write(path.join(dir, 'a.md'), 'alpha')
    const api = fakeApi()
    const [result] = await importDocuments(api.client, collectDocuments([dir], { scope: 'global' }), { dryRun: true })
    assert.strictEqual(result.action, 'create')
    assert.ok(api.calls.every(call => call.method === 'GET'))
  })

  it('reports a failed file and goes on with the rest', async function () {
    write(path.join(dir, 'a.md'), 'alpha')
    write(path.join(dir, 'b.md'), 'beta')
    const api = fakeApi()
    const request = api.client.request
    api.client.request = async (method, route, body) => {
      if (method === 'POST' && body.title === 'a') throw new Error('Note is too long')
      return request(method, route, body)
    }
    const results = await importDocuments(api.client, collectDocuments([dir], { scope: 'global' }))
    assert.deepStrictEqual(results.map(r => [r.action, r.error]), [['error', 'Note is too long'], ['create', undefined]])
  })
})

describe('memory import-docs: MCP tool and script', function () {
  let dir
  beforeEach(function () { dir = tempDir('codimd-docs-') })
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }) })

  it('imports files through memory_import_files and refuses title with many files', async function () {
    write(path.join(dir, 'a.md'), '# A\nalpha\n')
    write(path.join(dir, 'b.md'), '# B\nbeta\n')
    const tool = TOOLS.find(t => t.name === 'memory_import_files')
    const api = fakeApi()
    const text = await tool.run(api.client, { paths: [dir], scope: 'project:demo' })
    assert.match(text, /created 2, updated 0, skipped 0, failed 0/)
    await assert.rejects(tool.run(api.client, { paths: [dir], title: 'X' }), /title only works when importing one file/)
  })

  it('runs the script against the memory API over HTTP', async function () {
    write(path.join(dir, 'a.md'), '# A\nalpha\n')
    const requests = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: body && JSON.parse(body) })
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(req.method === 'POST'
          ? { status: 'ok', note: { id: 'x1', url: 'http://fake/x1' } }
          : { status: 'ok', notes: [] }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const lines = []
    try {
      await run({
        argv: ['--scope', 'project:demo', '--tag', 'kb', 'a.md'],
        env: { CODIMD_MEMORY_TOKEN: 'test-token', CODIMD_URL: `http://127.0.0.1:${server.address().port}` },
        home: dir,
        cwd: dir,
        log: line => lines.push(line)
      })
    } finally {
      server.close()
    }
    const post = requests.find(r => r.method === 'POST')
    assert.deepStrictEqual([post.url, post.body.title, post.body.tags], ['/api/memory/notes', 'A', ['imported', 'kb']])
    assert.match(lines.join('\n'), /created 1, updated 0, skipped 0, failed 0/)
  })
})
