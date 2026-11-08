/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFile, execFileSync } = require('child_process')

const { parseMemoryFile, projectScopeFor } = require('../../tools/memory/import')

const IMPORT = path.join(__dirname, '..', '..', 'tools', 'memory', 'import.js')
// The importer skips project directories under /tmp, so command fixtures live in the ignored repo tmp/.
const FIXTURE_BASE = path.join(__dirname, '..', '..', 'tmp')

function tempDir (base = os.tmpdir()) {
  fs.mkdirSync(base, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(base, 'codimd-import-test-')))
}

function encode (dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

describe('memory import: parsing', function () {
  it('reads name, description, and type nested under metadata', function () {
    const text = [
      '---',
      'name: approximate-python-parity',
      'description: "For new native features, roughly \\"matching\\" is enough"',
      'metadata:',
      '  node_type: memory',
      '  type: feedback',
      '  modified: 2026-10-29T12:15:30.028Z',
      '---',
      '',
      'User said **this**.',
      ''
    ].join('\n')
    assert.deepStrictEqual(parseMemoryFile(text, 'fallback'), {
      name: 'approximate-python-parity',
      description: 'For new native features, roughly "matching" is enough',
      type: 'feedback',
      body: 'User said **this**.'
    })
  })

  it('reads an older file with type at the top level and CRLF line endings', function () {
    const text = "---\r\nname: old-style\r\ndescription: 'It''s plain'\r\ntype: user\r\n---\r\nBody line\r\n"
    assert.deepStrictEqual(parseMemoryFile(text, 'fallback'), {
      name: 'old-style',
      description: "It's plain",
      type: 'user',
      body: 'Body line'
    })
  })

  it('falls back to the file name when there is no frontmatter', function () {
    assert.deepStrictEqual(parseMemoryFile('Just text\n', 'loose-note'), {
      name: 'loose-note',
      description: '',
      type: '',
      body: 'Just text'
    })
  })
})

describe('memory import: project scope', function () {
  let root, home

  beforeEach(function () {
    root = tempDir()
    home = path.join(root, 'home', 'paul')
    fs.mkdirSync(home, { recursive: true })
  })

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('uses the git remote name of a repo the encoded name resolves to', function () {
    const repo = path.join(home, 'my.repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Paul/Real-Name.git'])
    assert.strictEqual(projectScopeFor(encode(repo), home), 'project:real-name')
  })

  it('matches an underscore directory that the encoding turned into a dash', function () {
    fs.mkdirSync(path.join(home, 'tai'))
    fs.mkdirSync(path.join(home, 'tai_ci'))
    assert.strictEqual(projectScopeFor(encode(path.join(home, 'tai_ci')), home), 'project:tai_ci')
  })

  it('uses the repo of a deleted worktree under .claude', function () {
    const repo = path.join(home, 'tai_ci')
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true })
    execFileSync('git', ['init', '-q', repo])
    const gone = path.join(repo, '.claude', 'worktrees', 'browser-progress-927aae')
    assert.strictEqual(projectScopeFor(encode(gone), home), 'project:tai_ci')
  })

  it('falls back to the part after the home prefix when nothing exists', function () {
    assert.strictEqual(projectScopeFor(encode(path.join(home, 'Gone_Project')), home), 'project:gone-project')
  })
})

// A stand-in for /api/memory that keeps notes in memory and records each request.
function fakeApi () {
  const notes = []
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake')
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization })
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/notes') {
        const q = (url.searchParams.get('q') || '').toLowerCase()
        const hits = notes.filter(note => note.content.toLowerCase().includes(q))
        return send(200, { status: 'ok', notes: hits.map(({ id, title }) => ({ id, title })) })
      }
      const one = url.pathname.match(/^\/api\/memory\/notes\/([^/]+)$/)
      if (req.method === 'GET' && one) {
        const note = notes.find(note => note.id === one[1])
        return note ? send(200, { status: 'ok', note }) : send(404, { status: 'error', message: 'Not found' })
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/notes') {
        const input = JSON.parse(raw)
        const note = Object.assign({ id: `n${notes.length + 1}`, content: `---\ntags: memory\n---\n# ${input.title}\n\n${input.body}\n` }, input)
        notes.push(note)
        return send(201, { status: 'ok', note })
      }
      send(404, { status: 'error', message: 'Not found' })
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ notes, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
  }))
}

function runImport (args, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [IMPORT].concat(args), { env }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stdout}${stderr}`))
      resolve(stdout)
    })
  })
}

describe('memory import: command', function () {
  this.timeout(10000)
  let root, home, projects, api, env

  function memoryFile (projectPath, file, text) {
    const dir = path.join(projects, encode(projectPath), 'memory')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }

  beforeEach(async function () {
    root = tempDir(FIXTURE_BASE)
    home = path.join(root, 'home')
    projects = path.join(home, '.claude', 'projects')
    fs.mkdirSync(path.join(home, 'tai_ci'), { recursive: true })
    execFileSync('git', ['init', '-q', path.join(home, 'tai_ci')])
    memoryFile(path.join(home, 'tai_ci'), 'MEMORY.md', '- [Parity](parity.md)\n')
    memoryFile(path.join(home, 'tai_ci'), 'parity.md', '---\nname: parity\ndescription: "Roughly match Python"\nmetadata:\n  type: feedback\n---\n\nBody of parity.\n')
    memoryFile(path.join(home, 'tai_ci'), 'odd.md', '---\nname: odd\ntype: doc\n---\nOdd body.\n')
    memoryFile(path.join(home, 'zenc'), 'me.md', '---\nname: me\ntype: user\n---\nAbout me.\n')
    fs.mkdirSync(path.join(projects, encode(path.join(home, 'empty')), 'memory'), { recursive: true })
    memoryFile('/tmp/scratch', 'tmp.md', '---\nname: scratch\ntype: user\n---\nScratch.\n')
    api = await fakeApi()
    env = { PATH: process.env.PATH, HOME: home, CODIMD_URL: api.url, CODIMD_MEMORY_TOKEN: 'test-token' }
  })

  afterEach(function () {
    api.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates one memory note per file with scope, type, imported tag, and marker', async function () {
    const output = await runImport([], env)
    const created = api.notes.map(({ title, scope, type, tags, body }) => ({ title, scope, type, tags, body }))
    assert.deepStrictEqual(created.sort((a, b) => a.body < b.body ? -1 : 1), [
      { title: 'me', scope: 'global', type: 'user', tags: ['imported'], body: 'About me.\n\n<!-- imported-from: global/me -->' },
      { title: 'Roughly match Python', scope: 'project:tai_ci', type: 'feedback', tags: ['imported'], body: 'Body of parity.\n\n<!-- imported-from: project:tai_ci/parity -->' },
      { title: 'odd', scope: 'project:tai_ci', type: 'reference', tags: ['imported'], body: 'Odd body.\n\n<!-- imported-from: project:tai_ci/odd -->' }
    ])
    assert.ok(api.requests.every(request => request.auth === 'Bearer test-token'))
    assert.match(output, /^create +project:tai_ci +feedback +parity$/m)
    assert.match(output, /type "doc" is not importable, using reference/)
    assert.match(output, /created 3, skipped 0/)
    assert.doesNotMatch(output, /scratch|MEMORY/)
  })

  it('skips every file on a rerun because the marker is already there', async function () {
    await runImport([], env)
    const output = await runImport([], env)
    assert.strictEqual(api.notes.length, 3)
    assert.match(output, /^skip +global +user +me$/m)
    assert.match(output, /created 0, skipped 3/)
    const searches = api.requests.filter(request => request.method === 'GET' && request.path === '/api/memory/notes')
    assert.deepStrictEqual(searches.find(request => request.query.q.includes('parity')).query, { q: '<!-- imported-from: project:tai_ci/parity -->', includeArchived: 'true' })
  })

  it('creates the note when a search hit lacks the exact, case-sensitive marker', async function () {
    api.notes.push({ id: 'x', content: 'text\n<!-- IMPORTED-FROM: PARITY -->\n' })
    await runImport([], env)
    assert.strictEqual(api.notes.filter(note => note.body && note.body.includes('/parity -->')).length, 1)
  })

  it('imports same-named memories of two projects once each', async function () {
    memoryFile(path.join(home, 'zenc'), 'parity.md', '---\nname: parity\ntype: feedback\n---\nZenc parity.\n')
    await runImport([], env)
    const output = await runImport([], env)
    const parity = api.notes.filter(note => note.body && note.body.includes('/parity -->'))
    assert.deepStrictEqual(parity.map(note => note.scope).sort(), ['project:tai_ci', 'project:zenc'])
    assert.match(output, /created 0, skipped 4/)
  })

  it('treats a note with the old name-only marker in the same scope as imported', async function () {
    api.notes.push({ id: 'old', scope: 'project:tai_ci', content: 'Body of parity.\n\n<!-- imported-from: parity -->\n' })
    api.notes.push({ id: 'other', scope: 'project:zenc', content: 'Other odd.\n\n<!-- imported-from: odd -->\n' })
    const output = await runImport([], env)
    assert.match(output, /^skip +project:tai_ci +feedback +parity$/m)
    assert.match(output, /^create +project:tai_ci +reference +odd\b/m)
    assert.match(output, /created 2, skipped 1/)
  })

  it('lists what it would do with --dry-run and sends no POST', async function () {
    await runImport([], env)
    memoryFile(path.join(home, 'zenc'), 'new.md', '---\nname: new\ntype: project\n---\nNew.\n')
    const output = await runImport(['--dry-run'], env)
    assert.strictEqual(api.requests.filter(request => request.method === 'POST').length, 3)
    assert.match(output, /^create +project:zenc +project +new$/m)
    assert.match(output, /would create 1, would skip 3/)
  })

  it('needs no token or server with --dry-run --offline', async function () {
    const output = await runImport(['--dry-run', '--offline', '--root', projects], { PATH: process.env.PATH, HOME: home })
    assert.strictEqual(api.requests.length, 0)
    assert.match(output, /would create 3, would skip 0/)
  })

  it('refuses --offline without --dry-run', async function () {
    await assert.rejects(runImport(['--offline'], env), /--offline only works with --dry-run/)
    assert.strictEqual(api.requests.length, 0)
  })
})
