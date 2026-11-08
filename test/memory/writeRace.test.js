/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const http = require('http')
const express = require('express')
const mock = require('mock-require')
const sinon = require('sinon')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { createApiTokenModelFake } = require('../testDoubles/apiTokenModelFake')
const { createNoteModelFake } = require('../testDoubles/noteModelFake')
const { removeLibModuleCache, makeMockSocket } = require('../realtime/utils')
const realtimeJobStub = require('../testDoubles/realtimeJobStub')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Memory API writes through the real router and the real realtime note lock,
// against a Note model whose reads and writes take time like a database.
describe('concurrent memory API writes', function () {
  let Note
  let realtime
  let server
  let token
  let dbDelay

  beforeEach(function (done) {
    removeLibModuleCache()
    dbDelay = () => 1 + Math.random() * 5
    Note = createNoteModelFake()
    const findOne = Note.findOne
    Note.findOne = async options => {
      const note = await findOne(options)
      await delay(dbDelay())
      if (!note) return note
      if (options.include) return Object.assign(note, { authors: [] })
      const update = note.update
      note.update = async function (values) {
        await delay(dbDelay())
        return update.call(this, values)
      }
      return note
    }
    const ApiToken = createApiTokenModelFake()
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/history', {})
    mock('../../lib/models', {
      ApiToken,
      Note,
      User: { getProfile: user => user },
      Author: {},
      Revision: { saveNoteRevisionAsync: () => delay(dbDelay()) }
    })
    mock('../../lib/realtime/realtimeUpdateDirtyNoteJob', realtimeJobStub)
    mock('../../lib/realtime/realtimeCleanDanglingUserJob', realtimeJobStub)
    mock('../../lib/realtime/realtimeSaveRevisionJob', realtimeJobStub)
    realtime = require('../../lib/realtime/realtime')
    realtime.io = { to: () => ({ emit: () => {} }) }
    const apiToken = require('../../lib/memory/apiToken')
    const generated = apiToken.generateToken()
    token = generated.token
    ApiToken.create({ userId: 'user-1', name: 'agent', tokenHash: generated.tokenHash, prefix: generated.prefix }).then(() => {
      const app = express()
      app.use('/api/memory', require('../../lib/memory/router'))
      server = app.listen(0, '127.0.0.1', done)
    }, done)
  })

  afterEach(function (done) {
    realtime.terminate()
    mock.stopAll()
    sinon.restore()
    removeLibModuleCache()
    server.close(done)
  })

  function call (method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const headers = { Authorization: `Bearer ${token}` }
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const { port } = server.address()
      const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  function seed (content) {
    const row = Note.insert({ ownerId: 'user-1', permission: 'private', content })
    return { row, id: Note.encodeNoteId(row.id) }
  }

  const memory = '---\ntags: memory, global, doc\n---\n# race\n'

  it('keeps every line of concurrent appends to a closed note', async function () {
    const { row, id } = seed(memory)
    const lines = [0, 1, 2, 3, 4, 5].map(i => 'LINE' + i)

    const results = await Promise.all(lines.map(text => call('POST', `/api/memory/notes/${id}/append`, { text })))

    assert.deepStrictEqual(results.map(res => res.status), lines.map(() => 200))
    for (const line of lines) assert(row.content.includes('\n\n' + line), row.content)
  })

  it('does not archive away an append that landed first', async function () {
    const { row, id } = seed(memory)

    const results = await Promise.all([
      call('POST', `/api/memory/notes/${id}/append`, { text: 'kept' }),
      call('POST', `/api/memory/notes/${id}/archive`)
    ])

    assert.deepStrictEqual(results.map(res => res.status), [200, 200])
    assert(row.content.includes('\n\nkept'), row.content)
    assert(row.content.includes('archived'), row.content)
  })

  // Holds the note lock, lets `request` queue behind it, changes the row, then releases.
  async function changeWhileQueued (row, request, change) {
    let release
    const holding = realtime.withNoteLock(row.id, () => new Promise(resolve => { release = resolve }))
    const pending = request()
    await delay(30)
    change()
    release()
    await holding
    return pending
  }

  it('answers 404 to a write queued behind a change that removed the memory tag', async function () {
    const { row, id } = seed(memory)

    const res = await changeWhileQueued(row,
      () => call('POST', `/api/memory/notes/${id}/append`, { text: 'more' }),
      () => { row.content = '# not a memory any more\n' })

    assert.deepStrictEqual(res, { status: 404, body: { status: 'error', message: 'Not found' } })
    assert.strictEqual(row.content, '# not a memory any more\n')
  })

  it('answers 400 to an append that only became too long while queued', async function () {
    const { row, id } = seed(memory)
    const grown = memory + 'x'.repeat(100000 - memory.length - 2)

    const res = await changeWhileQueued(row,
      () => call('POST', `/api/memory/notes/${id}/append`, { text: 'more' }),
      () => { row.content = grown })

    assert.deepStrictEqual(res, { status: 400, body: { status: 'error', message: 'Note is too long' } })
    assert.strictEqual(row.content, grown)
  })

  describe('write admission', function () {
    function connectBrowsers () {
      realtime.maintenance = false
      const connected = new Map()
      sinon.stub(realtime, 'parseNoteIdFromSocketAsync').callsFake(async socket => socket.testNoteId)
      sinon.stub(realtime, 'checkViewPermission').returns(true)
      sinon.stub(realtime, 'updateHistory')
      sinon.stub(realtime, 'emitOnlineUsers')
      sinon.stub(realtime, 'emitRefresh').callsFake(socket => connected.get(socket)())
      return noteId => new Promise(resolve => {
        const socket = makeMockSocket()
        socket.join = sinon.fake()
        socket.request.user = { logged_in: true, id: 'user-1' }
        socket.testNoteId = noteId
        connected.set(socket, resolve)
        realtime.connection(socket)
      })
    }

    it('connects a browser to one note within about one write while many writes to another note wait', async function () {
      const DB_MS = 20
      dbDelay = () => DB_MS
      const busy = seed(memory)
      const other = seed('# other\n')
      const connect = connectBrowsers()

      const writes = Array.from({ length: 30 }, (_, i) =>
        call('PUT', `/api/memory/notes/${busy.id}`, { content: memory + 'x'.repeat(1000) + i }))
      await delay(DB_MS * 3)
      const busyConnected = connect(busy.row.id)
      await delay(5)
      const started = Date.now()
      await connect(other.row.id)
      const waited = Date.now() - started
      await busyConnected
      await Promise.all(writes)

      console.log(`      connect to the other note took ${waited} ms (one database call takes ${DB_MS} ms)`)
      assert(waited < DB_MS * 8, `waited ${waited} ms`)
    })

    it('admits one write per user plus five queued and answers 429 to the rest', async function () {
      const { id } = seed(memory)
      let release
      const gate = new Promise(resolve => { release = resolve })
      dbDelay = () => 1
      const findRow = Note.findOne
      Note.findOne = async options => {
        const note = await findRow(options)
        if (note && !options.include) await gate
        return note
      }

      const results = []
      const pending = Array.from({ length: 10 }, (_, i) =>
        call('POST', `/api/memory/notes/${id}/append`, { text: 'LINE' + i }).then(res => results.push(res)))
      for (let i = 0; i < 200 && results.length < 4; i++) await delay(5)
      const rejected = results.slice()
      release()
      await Promise.all(pending)

      assert.deepStrictEqual(rejected.map(res => res.status), [429, 429, 429, 429])
      assert.deepStrictEqual(rejected[0].body, { status: 'error', message: 'Too many concurrent writes' })
      assert.strictEqual(results.filter(res => res.status === 200).length, 6)
    })
  })
})
