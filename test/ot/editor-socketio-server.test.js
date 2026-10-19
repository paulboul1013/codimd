/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')
const sinon = require('sinon')

const { createFakeLogger } = require('../testDoubles/loggerFake')

describe('EditorSocketIOServer read checks', function () {
  let EditorSocketIOServer
  let handlers
  let socket

  beforeEach(function () {
    mock('../../lib/logger', createFakeLogger())
    delete require.cache[require.resolve('../../lib/ot/editor-socketio-server')]
    EditorSocketIOServer = require('../../lib/ot/editor-socketio-server')
    handlers = {}
    socket = {
      id: 'revoked',
      join: sinon.stub(),
      emit: sinon.stub(),
      on: (event, handler) => { handlers[event] = handler },
      broadcast: { in: () => ({ emit: sinon.stub() }), to: () => ({ emit: sinon.stub() }) }
    }
  })

  afterEach(function () {
    mock.stopAll()
    sinon.restore()
  })

  it('does not send operation history to a socket that lost read access', function () {
    let readable = true
    const server = new EditorSocketIOServer('text', [], 'note', (s, decide) => decide(true), null, () => readable)
    server.addClient(socket)
    socket.emit.resetHistory()
    readable = false
    handlers.get_operations(0, 0)
    assert(socket.emit.called === false)
    readable = true
    handlers.get_operations(0, 0)
    assert(socket.emit.calledWith('operations', 0, []))
  })

  it('does not send a delayed doc after a failed operation once read access is gone', function () {
    const clock = sinon.useFakeTimers()
    let readable = true
    const server = new EditorSocketIOServer('text', [], 'note', (s, decide) => decide(true), null, () => readable)
    server.addClient(socket)
    socket.emit.resetHistory()
    handlers.operation(0, 'not an operation', null)
    readable = false
    clock.tick(200)
    assert(socket.emit.called === false)
    clock.restore()
  })
})
