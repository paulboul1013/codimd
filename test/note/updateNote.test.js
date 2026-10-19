/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')
const sinon = require('sinon')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { removeLibModuleCache } = require('../realtime/utils')

describe('note#updateNote API', function () {
  let noteController
  let note
  let errorForbidden

  beforeEach(function () {
    removeLibModuleCache()
    note = { ownerId: 'owner', permission: 'private', update: sinon.stub().resolves(true) }
    errorForbidden = sinon.stub()
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/config', { allowAnonymousEdits: true })
    mock('../../lib/history', { updateHistory: sinon.stub(), historyDelete: sinon.stub() })
    mock('../../lib/models', {
      Note: {
        parseNoteIdAsync: sinon.stub().resolves('note-id'),
        findOne: sinon.stub().callsFake(async () => note),
        parseNoteTitle: () => 'title',
        encodeNoteId: id => id
      },
      Revision: { saveNoteRevision: (n, callback) => callback(null, {}) },
      User: {}
    })
    mock('../../lib/response', {
      errorForbidden,
      errorNotFound: sinon.stub(),
      errorInternalError: sinon.stub(),
      newCheckViewPermission: sinon.stub(),
      responseCodiMD: sinon.stub()
    })
    mock('../../lib/realtime/realtime', {
      isNoteExistsInPool: () => false,
      canEditNote: require('../../lib/realtime/realtime').canEditNote
    })
    mock('../../lib/note/noteActions', {})
    noteController = require('../../lib/note')
  })

  afterEach(function () {
    mock.stopAll()
    sinon.restore()
    removeLibModuleCache()
  })

  function request (userId) {
    return {
      params: { noteId: 'note-id' },
      body: { content: 'overwrite' },
      user: userId ? { id: userId } : undefined,
      isAuthenticated: () => !!userId
    }
  }

  function response () {
    return { send: sinon.stub(), status: sinon.stub().returnsThis(), json: sinon.stub() }
  }

  it('rejects a signed-in nonowner on a private note without writing', async function () {
    await noteController.updateNote(request('other'), response())
    assert(errorForbidden.calledOnce)
    assert(note.update.called === false)
  })

  it('rejects a guest on a limited note without writing', async function () {
    note.permission = 'limited'
    await noteController.updateNote(request(null), response())
    assert(errorForbidden.calledOnce)
    assert(note.update.called === false)
  })

  it('lets the owner update a private note', async function () {
    const res = response()
    await noteController.updateNote(request('owner'), res)
    assert(errorForbidden.called === false)
    assert(note.update.calledOnce)
    assert(res.send.calledWith({ status: 'ok' }))
  })
})
