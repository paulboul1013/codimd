/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const http = require('http')
const express = require('express')
const mock = require('mock-require')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { createApiTokenModelFake } = require('../testDoubles/apiTokenModelFake')
const { removeLibModuleCache } = require('../realtime/utils')

// The app has no session, passport or csurf middleware, so a pass proves the router needs none of them.
describe('memory API router', function () {
  let ApiToken
  let apiToken
  let server

  beforeEach(function (done) {
    removeLibModuleCache()
    ApiToken = createApiTokenModelFake()
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/models', { ApiToken })
    apiToken = require('../../lib/memory/apiToken')
    const app = express()
    app.use('/api/memory', require('../../lib/memory/router'))
    server = app.listen(0, '127.0.0.1', done)
  })

  afterEach(function (done) {
    mock.stopAll()
    removeLibModuleCache()
    server.close(done)
  })

  function get (path, headers) {
    return new Promise((resolve, reject) => {
      const { port } = server.address()
      http.get({ host: '127.0.0.1', port, path, headers }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }).on('error', reject)
    })
  }

  async function issue (userId) {
    const generated = apiToken.generateToken()
    const row = await ApiToken.create({ userId, name: 'agent', tokenHash: generated.tokenHash, prefix: generated.prefix })
    return { token: generated.token, row }
  }

  function assertUnauthorized (res) {
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.headers.location, undefined)
    assert(res.headers['content-type'].startsWith('application/json'))
    assert.strictEqual(res.headers['www-authenticate'], 'Bearer')
    const body = JSON.parse(res.body)
    assert.strictEqual(body.status, 'error')
    assert.strictEqual(typeof body.message, 'string')
  }

  it('answers ping with the token owner id', async function () {
    const { token } = await issue('user-1')
    const res = await get('/api/memory/ping', { Authorization: `Bearer ${token}` })
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok', userId: 'user-1' })
  })

  it('updates lastUsedAt on a successful call', async function () {
    const { token } = await issue('user-1')
    await get('/api/memory/ping', { Authorization: `Bearer ${token}` })
    assert(ApiToken.rows[0].lastUsedAt instanceof Date)
  })

  it('rejects a request without a token with 401 JSON', async function () {
    assertUnauthorized(await get('/api/memory/ping'))
  })

  it('rejects a wrong token with 401 JSON', async function () {
    await issue('user-1')
    assertUnauthorized(await get('/api/memory/ping', { Authorization: 'Bearer cmdm_wrong' }))
  })

  it('rejects a revoked token with 401 JSON', async function () {
    const { token, row } = await issue('user-1')
    await ApiToken.destroy({ where: { id: row.id } })
    assertUnauthorized(await get('/api/memory/ping', { Authorization: `Bearer ${token}` }))
  })

  it('ignores a session cookie when no token is sent', async function () {
    assertUnauthorized(await get('/api/memory/ping', { Cookie: 'connect.sid=s%3Aabc' }))
  })

  it('answers an unknown path under the router with 404 JSON for an authenticated caller', async function () {
    const { token } = await issue('user-1')
    const res = await get('/api/memory/nope', { Authorization: `Bearer ${token}` })
    assert.strictEqual(res.status, 404)
    assert.strictEqual(JSON.parse(res.body).status, 'error')
  })

  it('answers 500 JSON when the token lookup fails', async function () {
    ApiToken.findOne = async () => { throw new Error('db down') }
    const res = await get('/api/memory/ping', { Authorization: 'Bearer cmdm_x' })
    assert.strictEqual(res.status, 500)
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'error', message: 'Internal error' })
  })
})
