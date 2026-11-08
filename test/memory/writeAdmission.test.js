/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const EventEmitter = require('events')

const { createWriteAdmission } = require('../../lib/memory/writeAdmission')

describe('memory write admission', function () {
  function request (admit, userId = 'user-1') {
    const res = new EventEmitter()
    res.status = code => { res.statusCode = code; return res }
    res.json = body => { res.body = body; res.emit('finish'); res.emit('close') }
    const write = { res, started: false }
    admit({ apiToken: { userId } }, res, () => { write.started = true })
    write.finish = () => { res.emit('finish'); res.emit('close') }
    write.abort = () => res.emit('close')
    return write
  }

  it('starts the next queued write when the running one finishes', function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    const second = request(admit)
    assert.deepStrictEqual([first.started, second.started], [true, false])
    first.finish()
    assert.strictEqual(second.started, true)
  })

  it('skips a queued write whose client went away', function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    const gone = request(admit)
    const third = request(admit)
    gone.abort()
    first.finish()
    assert.deepStrictEqual([gone.started, third.started], [false, true])
  })

  it('frees the slot of a running write whose client went away', function () {
    const admit = createWriteAdmission()
    request(admit).abort()
    assert.strictEqual(request(admit).started, true)
  })

  it('answers 429 once five writes wait, and only for that user', function () {
    const admit = createWriteAdmission()
    for (let i = 0; i < 6; i++) request(admit)
    const rejected = request(admit)
    assert.strictEqual(rejected.res.statusCode, 429)
    assert.deepStrictEqual(rejected.res.body, { status: 'error', message: 'Too many concurrent writes' })
    assert.strictEqual(request(admit, 'user-2').started, true)
  })
})
