/* eslint-env node, mocha */
/* global Response */
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { createClient, projectScope } = require('../../tools/memory/client')

const PING = 'http://localhost:3000/api/memory/ping'
const PAGES = 'https://paulboul1013.github.io/codimd/target.json'

function json (body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function networkError (code) {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } })
}

// The cache-busting query on the GitHub Pages lookup changes on every call.
const withoutCacheBuster = url => url.replace(/\?t=\d+$/, '')

// Each route is a queue of responses or errors to throw; the last entry repeats.
function fakeFetch (routes) {
  const calls = []
  async function fetch (url, options = {}) {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {} })
    const queue = routes[withoutCacheBuster(url)]
    if (!queue) throw networkError('ECONNREFUSED')
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return next()
  }
  return { fetch, calls, urls: () => calls.map(call => withoutCacheBuster(call.url)) }
}

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codimd-memory-test-'))
}

describe('memory tools client', function () {
  let home

  beforeEach(function () {
    home = tempDir()
  })

  afterEach(function () {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function writeConfig (config, mode) {
    const dir = path.join(home, '.config', 'codimd-memory')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify(config))
    fs.chmodSync(file, mode)
  }

  describe('config', function () {
    it('reads the token from a chmod 600 config file and sends it as a bearer token', async function () {
      writeConfig({ token: 'file-token', serverUrl: 'http://memory.test/' }, 0o600)
      const fake = fakeFetch({ 'http://memory.test/api/memory/notes': [() => json({ status: 'ok', notes: [] })] })
      const result = await createClient({ env: {}, home, fetch: fake.fetch }).request('GET', '/notes')
      assert.deepStrictEqual(result, { status: 'ok', notes: [] })
      assert.strictEqual(fake.calls[0].headers.Authorization, 'Bearer file-token')
    })

    it('refuses a config file that group or others can read', async function () {
      writeConfig({ token: 'file-token' }, 0o644)
      const fake = fakeFetch({})
      await assert.rejects(createClient({ env: {}, home, fetch: fake.fetch }).request('GET', '/notes'), /chmod 600/)
      assert.strictEqual(fake.calls.length, 0)
    })

    it('lets CODIMD_MEMORY_TOKEN and CODIMD_URL override the file', async function () {
      writeConfig({ token: 'file-token', serverUrl: 'http://file.test' }, 0o600)
      const fake = fakeFetch({ 'http://env.test/api/memory/ping': [() => json({ status: 'ok', userId: 'u' })] })
      const env = { CODIMD_MEMORY_TOKEN: 'env-token', CODIMD_URL: 'http://env.test' }
      await createClient({ env, home, fetch: fake.fetch }).request('GET', '/ping')
      assert.deepStrictEqual(fake.urls(), ['http://env.test/api/memory/ping'])
      assert.strictEqual(fake.calls[0].headers.Authorization, 'Bearer env-token')
    })

    it('explains how to get a token when none is configured', async function () {
      await assert.rejects(createClient({ env: {}, home, fetch: fakeFetch({}).fetch }).request('GET', '/notes'), /\/settings\/api-tokens/)
    })
  })

  describe('server resolution', function () {
    const env = { CODIMD_MEMORY_TOKEN: 't' }
    const fixed = { CODIMD_MEMORY_TOKEN: 't', CODIMD_URL: 'http://env.test' }

    it('uses localhost when its memory API answers, even with 401', async function () {
      const fake = fakeFetch({
        [PING]: [() => json({ status: 'error', message: 'Invalid token' }, 401)],
        'http://localhost:3000/api/memory/notes': [() => json({ status: 'ok', notes: [] })]
      })
      await createClient({ env, home, fetch: fake.fetch }).request('GET', '/notes')
      assert.deepStrictEqual(fake.urls(), [PING, 'http://localhost:3000/api/memory/notes'])
    })

    it('falls back to the tunnel URL from GitHub Pages when localhost is down', async function () {
      const fake = fakeFetch({
        [PAGES]: [() => json({ url: 'https://tunnel.test' })],
        'https://tunnel.test/api/memory/notes': [() => json({ status: 'ok', notes: [] })]
      })
      await createClient({ env, home, fetch: fake.fetch }).request('GET', '/notes')
      assert.deepStrictEqual(fake.urls(), [PING, PAGES, 'https://tunnel.test/api/memory/notes'])
    })

    it('bypasses the GitHub Pages CDN cache when it looks up the tunnel', async function () {
      const fake = fakeFetch({
        [PAGES]: [() => json({ url: 'https://tunnel.test' })],
        'https://tunnel.test/api/memory/notes': [() => json({ status: 'ok', notes: [] })]
      })
      const before = Date.now()
      await createClient({ env, home, fetch: fake.fetch }).request('GET', '/notes')
      const lookup = fake.calls[1].url
      const match = /^https:\/\/paulboul1013\.github\.io\/codimd\/target\.json\?t=(\d+)$/.exec(lookup)
      assert(match, lookup)
      assert(Number(match[1]) >= before && Number(match[1]) <= Date.now(), lookup)
    })

    it('does not mistake another server on port 3000 for the memory API', async function () {
      const fake = fakeFetch({
        [PING]: [() => new Response('<html>Not found</html>', { status: 404 })],
        [PAGES]: [() => json({ url: 'https://tunnel.test' })],
        'https://tunnel.test/api/memory/notes': [() => json({ status: 'ok', notes: [] })]
      })
      await createClient({ env, home, fetch: fake.fetch }).request('GET', '/notes')
      assert.deepStrictEqual(fake.urls(), [PING, PAGES, 'https://tunnel.test/api/memory/notes'])
    })

    it('gives a clear error naming both places when nothing is reachable', async function () {
      await assert.rejects(
        createClient({ env, home, fetch: fakeFetch({}).fetch }).request('GET', '/notes'),
        error => /CodiMD is not reachable/.test(error.message) && error.message.includes('localhost:3000') && error.message.includes(PAGES)
      )
    })

    it('resolves once per process and re-resolves once after a connection failure', async function () {
      const fake = fakeFetch({
        [PAGES]: [() => json({ url: 'https://old.test' }), () => json({ url: 'https://new.test' })],
        'https://old.test/api/memory/notes': [() => json({ status: 'ok', notes: [] }), networkError('ENOTFOUND')],
        'https://new.test/api/memory/notes': [() => json({ status: 'ok', notes: [] })]
      })
      const client = createClient({ env, home, fetch: fake.fetch })
      await client.request('GET', '/notes')
      await client.request('GET', '/notes')
      assert.deepStrictEqual(fake.urls(), [
        PING, PAGES, 'https://old.test/api/memory/notes',
        'https://old.test/api/memory/notes', PING, PAGES, 'https://new.test/api/memory/notes'
      ])
    })

    it('does not resend a write whose connection broke after it was sent', async function () {
      const fake = fakeFetch({ 'http://env.test/api/memory/notes/a/append': [networkError('UND_ERR_SOCKET')] })
      const client = createClient({ env: fixed, home, fetch: fake.fetch })
      await assert.rejects(client.request('POST', '/notes/a/append', { text: 'x' }))
      assert.strictEqual(fake.calls.length, 1)
    })

    it('surfaces the API error message', async function () {
      const fake = fakeFetch({ 'http://env.test/api/memory/notes/x': [() => json({ status: 'error', message: 'Note not found' }, 404)] })
      const client = createClient({ env: fixed, home, fetch: fake.fetch })
      await assert.rejects(client.request('GET', '/notes/x'), { message: 'Note not found' })
    })
  })
})

describe('projectScope', function () {
  let dir

  beforeEach(function () {
    dir = tempDir()
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function repo (name, remote) {
    const root = path.join(dir, name)
    fs.mkdirSync(root)
    execFileSync('git', ['init', '-q', root])
    if (remote) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote])
    return root
  }

  it('takes the repo name from an ssh remote', function () {
    assert.strictEqual(projectScope(repo('checkout', 'git@github.com:Paul/CodiMD.git')), 'project:codimd')
  })

  it('takes the repo name from an https remote, from a subdirectory', function () {
    const root = repo('checkout', 'https://github.com/hackmdio/Second_Brain.git/')
    fs.mkdirSync(path.join(root, 'lib'))
    assert.strictEqual(projectScope(path.join(root, 'lib')), 'project:second_brain')
  })

  it('falls back to the toplevel directory name without a remote', function () {
    assert.strictEqual(projectScope(repo('My Notes', null)), 'project:my-notes')
  })

  it('returns null outside a git repository', function () {
    assert.strictEqual(projectScope(dir), null)
  })
})
