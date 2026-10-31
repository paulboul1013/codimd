/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const sinon = require('sinon')
const moment = require('moment')
const Module = require('module')
const path = require('path')
const { transformFileSync } = require('@babel/core')
const filename = path.resolve(__dirname, '../../public/js/lib/my-notes.js')
const { code } = transformFileSync(filename, {
  configFile: false,
  babelrc: false,
  plugins: ['@babel/plugin-transform-modules-commonjs']
})
const frontendModule = new Module(filename, module)
frontendModule._compile(code, filename)
const { toMyNoteItems, loadMyNotes, deleteMyNote } = frontendModule.exports

const serverURL = 'https://example.test/team'

function response (status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('my notes', function () {
  describe('toMyNoteItems', function () {
    it('escapes the title and tags', function () {
      const [item] = toMyNoteItems([{
        id: 'a',
        text: '<img src=x onerror=alert(1)>',
        tags: ['<b>', 'plain'],
        createdAt: '2026-01-01T00:00:00Z',
        lastchangeAt: '2026-01-02T00:00:00Z'
      }], moment)
      assert.strictEqual(item.text, '&lt;img src=x onerror=alert(1)&gt;')
      assert.deepStrictEqual(item.tags, ['&lt;b&gt;', 'plain'])
    })

    it('uses lastchangeAt for the time and falls back to createdAt when it is null', function () {
      const items = toMyNoteItems([
        { id: 'changed', text: 'c', tags: [], createdAt: '2026-01-01T00:00:00Z', lastchangeAt: '2026-03-01T00:00:00Z' },
        { id: 'unchanged', text: 'u', tags: [], createdAt: '2026-02-01T00:00:00Z', lastchangeAt: null }
      ], moment)
      const byId = Object.fromEntries(items.map(item => [item.id, item]))
      assert.strictEqual(byId.changed.timestamp, Date.parse('2026-03-01T00:00:00Z'))
      assert.strictEqual(byId.unchanged.timestamp, Date.parse('2026-02-01T00:00:00Z'))
      assert.strictEqual(byId.unchanged.time, moment(Date.parse('2026-02-01T00:00:00Z')).format('llll'))
      assert.strictEqual(byId.unchanged.fromNow, moment(Date.parse('2026-02-01T00:00:00Z')).fromNow())
    })

    it('orders notes newest first', function () {
      const items = toMyNoteItems([
        { id: 'old', text: 'o', tags: [], createdAt: '2026-01-01T00:00:00Z', lastchangeAt: null },
        { id: 'new', text: 'n', tags: [], createdAt: '2026-01-01T00:00:00Z', lastchangeAt: '2026-05-01T00:00:00Z' },
        { id: 'mid', text: 'm', tags: [], createdAt: '2026-03-01T00:00:00Z', lastchangeAt: null }
      ], moment)
      assert.deepStrictEqual(items.map(item => item.id), ['new', 'mid', 'old'])
    })

    it('names a note without a title Untitled and tolerates missing tags', function () {
      const items = toMyNoteItems([
        { id: 'empty', text: '', createdAt: '2026-01-01T00:00:00Z', lastchangeAt: null },
        { id: 'missing', createdAt: '2026-01-02T00:00:00Z', lastchangeAt: null }
      ], moment)
      assert.deepStrictEqual(items.map(item => item.text), ['Untitled', 'Untitled'])
      assert.deepStrictEqual(items.map(item => item.tags), [[], []])
    })
  })

  describe('loadMyNotes', function () {
    it('fetches the owner notes with the session cookie and returns items', async function () {
      const fetch = sinon.stub().resolves(response(200, {
        myNotes: [{ id: 'a', text: '<i>', tags: [], createdAt: '2026-01-01T00:00:00Z', lastchangeAt: null }]
      }))
      const items = await loadMyNotes({ serverURL, fetch, moment })
      sinon.assert.calledOnce(fetch)
      assert.deepStrictEqual(fetch.firstCall.args, [`${serverURL}/api/notes/myNotes`, { credentials: 'same-origin' }])
      assert.deepStrictEqual(items.map(item => [item.id, item.text]), [['a', '&lt;i&gt;']])
    })

    for (const status of [403, 500]) {
      it(`rejects on ${status}`, async function () {
        const fetch = sinon.stub().resolves(response(status, {}))
        await assert.rejects(loadMyNotes({ serverURL, fetch, moment }))
      })
    }

    it('rejects when the request fails', async function () {
      const fetch = sinon.stub().rejects(new TypeError('network'))
      await assert.rejects(loadMyNotes({ serverURL, fetch, moment }), TypeError)
    })
  })

  describe('deleteMyNote', function () {
    it('sends DELETE to the URL-encoded note id', async function () {
      const fetch = sinon.stub().resolves(response(200, {}))
      await deleteMyNote({ serverURL, fetch, id: 'a/b' })
      sinon.assert.calledOnce(fetch)
      assert.deepStrictEqual(fetch.firstCall.args, [`${serverURL}/api/notes/a%2Fb`, { method: 'DELETE', credentials: 'same-origin' }])
    })

    it('resolves on 204', async function () {
      const fetch = sinon.stub().resolves(response(204))
      await deleteMyNote({ serverURL, fetch, id: 'a' })
    })

    it('rejects on 404', async function () {
      const fetch = sinon.stub().resolves(response(404, {}))
      await assert.rejects(deleteMyNote({ serverURL, fetch, id: 'a' }))
    })

    it('rejects when the request fails', async function () {
      const fetch = sinon.stub().rejects(new TypeError('network'))
      await assert.rejects(deleteMyNote({ serverURL, fetch, id: 'a' }), TypeError)
    })
  })
})
