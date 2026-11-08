/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')
const sinon = require('sinon')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { createNoteModelFake } = require('../testDoubles/noteModelFake')
const { removeLibModuleCache, makeMockSocket } = require('../realtime/utils')
const realtimeJobStub = require('../testDoubles/realtimeJobStub')

// A browser that read the note row before a memory API write but entered the
// collaboration pool after it must still end up with the API write.
describe('memory write while a browser opens the note', function () {
  let Note
  let realtime
  let writeMemoryNote
  let releaseBrowserRead

  beforeEach(function () {
    removeLibModuleCache()
    Note = createNoteModelFake()
    const findOne = Note.findOne
    // The browser's connect read (the one with includes) returns the row as it was
    // when the read started, but resolves only when the test releases it.
    Note.findOne = async options => {
      if (!options.include) return findOne(options)
      const snapshot = Object.assign({}, await findOne(options), { authors: [] })
      await new Promise(resolve => { releaseBrowserRead = resolve })
      return snapshot
    }
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/history', {})
    mock('../../lib/config', {})
    mock('../../lib/models', {
      Note,
      User: { getProfile: user => user },
      Author: {},
      Revision: { saveNoteRevisionAsync: async () => ({}) }
    })
    mock('../../lib/realtime/realtimeUpdateDirtyNoteJob', realtimeJobStub)
    mock('../../lib/realtime/realtimeCleanDanglingUserJob', realtimeJobStub)
    mock('../../lib/realtime/realtimeSaveRevisionJob', realtimeJobStub)
    realtime = require('../../lib/realtime/realtime')
    realtime.io = { to: () => ({ emit: () => {} }) }
    writeMemoryNote = require('../../lib/memory/writeMemoryNote')
  })

  afterEach(function () {
    realtime.terminate()
    mock.stopAll()
    sinon.restore()
    removeLibModuleCache()
  })

  function connectBrowser (noteId) {
    const socket = makeMockSocket()
    socket.join = sinon.fake()
    socket.request.user = { logged_in: true, id: 'user-1' }
    realtime.maintenance = false
    sinon.stub(realtime, 'parseNoteIdFromSocketAsync').resolves(noteId)
    sinon.stub(realtime, 'checkViewPermission').returns(true)
    sinon.stub(realtime, 'updateHistory')
    sinon.stub(realtime, 'emitOnlineUsers')
    sinon.stub(realtime, 'emitRefresh')
    realtime.connection(socket)
  }

  const tick = () => new Promise(resolve => setImmediate(resolve))

  async function until (condition) {
    for (let i = 0; i < 100 && !condition(); i++) await tick()
    assert(condition(), 'timed out')
  }

  it('brings a browser that loaded the old row forward', async function () {
    const row = Note.insert({ ownerId: 'user-1', permission: 'private', content: 'old' })
    connectBrowser(row.id)
    await until(() => releaseBrowserRead)

    const note = await Note.findOne({ where: { id: row.id } })
    const base = writeMemoryNote.readBase(note)
    const writing = writeMemoryNote.writeMemoryNote(note, base, 'old\n\nnew', 'user-1')
    for (let i = 0; i < 5; i++) await tick()
    releaseBrowserRead()
    await writing
    await until(() => realtime.getNoteFromNotePool(row.id))

    assert.strictEqual(realtime.getNoteFromNotePool(row.id).server.document, 'old\n\nnew')
  })

  it('makes a browser that connects during the database write read the new row', async function () {
    const row = Note.insert({ ownerId: 'user-1', permission: 'private', content: 'old' })
    const note = await Note.findOne({ where: { id: row.id } })
    const update = note.update
    let releaseWrite
    note.update = async function (values) {
      await new Promise(resolve => { releaseWrite = resolve })
      return update.call(this, values)
    }
    const writing = writeMemoryNote.writeMemoryNote(note, writeMemoryNote.readBase(note), 'old\n\nnew', 'user-1')
    await until(() => releaseWrite)

    connectBrowser(row.id)
    for (let i = 0; i < 5; i++) await tick()
    releaseWrite()
    await writing
    await until(() => releaseBrowserRead)
    releaseBrowserRead()
    await until(() => realtime.getNoteFromNotePool(row.id))

    assert.strictEqual(realtime.getNoteFromNotePool(row.id).server.document, 'old\n\nnew')
  })
})
