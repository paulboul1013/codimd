/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const EventEmitter = require('events')

const { createWriteAdmission } = require('../../lib/memory/writeAdmission')

describe('memory write admission', function () {
  const flush = () => new Promise(resolve => setImmediate(resolve))

  function request (admit, userId = 'user-1') {
    const res = new EventEmitter()
    res.status = code => { res.statusCode = code; return res }
    res.json = body => { res.body = body; res.emit('finish'); res.emit('close') }
    const write = { res, started: false }
    const handler = () => new Promise((resolve, reject) => {
      write.started = true
      write.finish = () => { resolve(); return flush() }
      write.fail = error => { reject(error); return flush() }
    })
    admit(handler)({ apiToken: { userId } }, res, error => { write.error = error })
    write.abort = () => res.emit('close')
    return write
  }

  it('starts the next queued write when the running one finishes', async function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    const second = request(admit)
    await flush()
    assert.deepStrictEqual([first.started, second.started], [true, false])
    await first.finish()
    assert.strictEqual(second.started, true)
  })

  it('skips a queued write whose client went away', async function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    const gone = request(admit)
    const third = request(admit)
    await flush()
    gone.abort()
    await first.finish()
    assert.deepStrictEqual([gone.started, third.started], [false, true])
  })

  it('holds the slot of a running write until its handler settles, even if the client went away', async function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    await flush()
    first.abort()
    const second = request(admit)
    await flush()
    assert.strictEqual(second.started, false)
    await first.finish()
    assert.strictEqual(second.started, true)
  })

  it('passes a failed write to the error handler and frees the slot', async function () {
    const admit = createWriteAdmission()
    const first = request(admit)
    const second = request(admit)
    await flush()
    const error = new Error('boom')
    await first.fail(error)
    assert.strictEqual(first.error, error)
    assert.strictEqual(second.started, true)
  })

  it('answers 429 once five writes wait, and only for that user', async function () {
    const admit = createWriteAdmission()
    for (let i = 0; i < 6; i++) request(admit)
    const rejected = request(admit)
    assert.strictEqual(rejected.res.statusCode, 429)
    assert.deepStrictEqual(rejected.res.body, { status: 'error', message: 'Too many concurrent writes' })
    const other = request(admit, 'user-2')
    await flush()
    assert.strictEqual(other.started, true)
  })
})
