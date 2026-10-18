/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const sinon = require('sinon')
const Module = require('module')
const path = require('path')
const { transformFileSync } = require('@babel/core')
const filename = path.resolve(__dirname, '../../public/js/lib/markdown-import.js')
const { code } = transformFileSync(filename, {
  configFile: false,
  babelrc: false,
  plugins: ['@babel/plugin-transform-modules-commonjs']
})
const frontendModule = new Module(filename, module)
frontendModule._compile(code, filename)
const setupMarkdownImport = frontendModule.exports.default

function element () {
  return { disabled: false, hidden: true, value: 'selected', files: [], dataset: {}, addEventListener (name, callback) { this[name] = callback } }
}

describe('history Markdown import', function () {
  let input
  let button
  let error
  let browser
  let reader
  const noteURL = 'https://example.test/team/AAAAAAAAAAAAAAAAAAAAAA'

  beforeEach(function () {
    input = element()
    input.click = sinon.spy()
    button = element()
    error = element()
    error.dataset = {
      extension: 'extension',
      empty: 'empty',
      read: 'read',
      tooLarge: 'tooLarge',
      login: 'login',
      failed: 'failed',
      network: 'network'
    }
    browser = {
      location: { href: 'https://example.test/team/' },
      fetch: sinon.stub().resolves({ ok: true, redirected: true, url: noteURL }),
      FileReader: class {
        constructor () { reader = this }

        readAsText (file, encoding) { this.encoding = encoding }
      }
    }
    setupMarkdownImport({ input, button, error, serverURL: 'https://example.test/team', browser })
  })

  afterEach(() => sinon.restore())

  function select (name = 'note.md') {
    input.files = [{ name }]
    input.change()
  }

  async function load (body = '# 中文\r\n正文') {
    reader.result = body
    await reader.onload()
  }

  it('opens the file chooser from the labelled button', function () {
    button.click()
    assert.strictEqual(input.click.callCount, 1)
  })

  it('ignores a cancelled selection', function () {
    input.change()
    assert.strictEqual(browser.fetch.callCount, 0)
    assert.strictEqual(input.disabled, false)
  })

  for (const name of ['article.MD', 'article.Markdown', 'article.TXT']) {
    it(`posts UTF-8 content unchanged and navigates for ${name}`, async function () {
      select(name)
      assert.strictEqual(reader.encoding, 'UTF-8')
      assert.strictEqual(input.disabled, true)
      assert.strictEqual(button.disabled, true)
      await load()
      assert.deepStrictEqual(browser.fetch.firstCall.args, ['https://example.test/team/new', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
        body: '# 中文\r\n正文'
      }])
      assert.strictEqual(browser.location.href, noteURL)
      assert.strictEqual(input.value, '')
    })
  }

  for (const body of ['', '\r\r']) {
    it(`rejects empty normalized content ${JSON.stringify(body)} without a request`, async function () {
      select()
      await load(body)
      assert.strictEqual(browser.fetch.callCount, 0)
      assert.strictEqual(error.textContent, 'empty')
      assert.strictEqual(error.hidden, false)
      assert.strictEqual(input.disabled, false)
      assert.strictEqual(input.value, '')
    })
  }

  for (const body of ['   ', '\n']) {
    it(`preserves nonempty whitespace ${JSON.stringify(body)}`, async function () {
      select()
      await load(body)
      assert.strictEqual(browser.fetch.firstCall.args[1].body, body)
    })
  }

  it('rejects unsupported extensions regardless of MIME type', function () {
    select('article.md.exe')
    assert.strictEqual(error.textContent, 'extension')
    assert.strictEqual(input.value, '')
    assert.strictEqual(browser.fetch.callCount, 0)
  })

  for (const event of ['onerror', 'onabort']) {
    it(`recovers from FileReader ${event}`, function () {
      select()
      reader[event]()
      assert.strictEqual(error.textContent, 'read')
      assert.strictEqual(button.disabled, false)
      assert.strictEqual(input.value, '')
      assert.strictEqual(browser.fetch.callCount, 0)
    })
  }

  it('recovers if reading throws synchronously', function () {
    browser.FileReader = class { readAsText () { throw new Error('read failed') } }
    select()
    assert.strictEqual(error.textContent, 'read')
    assert.strictEqual(button.disabled, false)
  })

  for (const [status, message] of [[413, 'tooLarge'], [500, 'failed'], [403, 'login']]) {
    it(`shows an error for HTTP ${status} and permits selecting the same file`, async function () {
      browser.fetch.resolves({ ok: false, status })
      select()
      await load()
      assert.strictEqual(error.textContent, message)
      assert.strictEqual(input.disabled, false)
      assert.strictEqual(input.value, '')
      assert.strictEqual(browser.location.href, 'https://example.test/team/')
      select()
      await load()
      assert.strictEqual(browser.fetch.callCount, 2)
    })
  }

  for (const url of [
    'https://example.test/team?next=%2Fnew',
    'https://example.test/team/?next=%2Fnew',
    'https://evil.test/team/AAAAAAAAAAAAAAAAAAAAAA',
    'https://example.test/AAAAAAAAAAAAAAAAAAAAAA',
    'https://example.test/team/500',
    'https://example.test/team/AAAAAAAAAAAAAAAAAAAAAA/extra',
    'https://example.test/team/AAAAAAAAAAAAAAAAAAAAAA?next=bad'
  ]) {
    it(`rejects an unexpected final URL: ${url}`, async function () {
      browser.fetch.resolves({ ok: true, redirected: true, url })
      select()
      await load()
      assert.strictEqual(error.hidden, false)
      assert.strictEqual(browser.location.href, 'https://example.test/team/')
    })
  }

  it('recognizes the login redirect returned by the backend on a subpath', async function () {
    browser.fetch.resolves({ ok: true, redirected: true, url: 'https://example.test/team?next=%2Fnew' })
    select()
    await load()
    assert.strictEqual(error.textContent, 'login')
  })

  it('rejects a successful response without a redirect', async function () {
    browser.fetch.resolves({ ok: true, redirected: false, url: noteURL })
    select()
    await load()
    assert.strictEqual(error.textContent, 'failed')
  })

  it('shows network uncertainty without retrying', async function () {
    browser.fetch.rejects(new Error('offline'))
    select()
    await load()
    assert.strictEqual(error.textContent, 'network')
    assert.strictEqual(browser.fetch.callCount, 1)
    assert.strictEqual(button.disabled, false)
  })

  it('ignores another selection while a request is pending', async function () {
    let finish
    browser.fetch.returns(new Promise(resolve => { finish = resolve }))
    select()
    const pending = load()
    select()
    assert.strictEqual(browser.fetch.callCount, 1)
    finish({ ok: true, redirected: true, url: noteURL })
    await pending
  })

  it('supports a relative server URL at the site root', async function () {
    setupMarkdownImport({ input, button, error, serverURL: '', browser })
    browser.fetch.resolves({ ok: true, redirected: true, url: 'https://example.test/AAAAAAAAAAAAAAAAAAAAAA' })
    select()
    await load()
    assert.strictEqual(browser.fetch.firstCall.args[0], 'https://example.test/new')
    assert.strictEqual(browser.location.href, 'https://example.test/AAAAAAAAAAAAAAAAAAAAAA')
  })
})
