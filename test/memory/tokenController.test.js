/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const crypto = require('crypto')
const mock = require('mock-require')
const sinon = require('sinon')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { createApiTokenModelFake } = require('../testDoubles/apiTokenModelFake')
const { removeLibModuleCache } = require('../realtime/utils')

describe('API token management', function () {
  let ApiToken
  let controller
  let errorForbidden

  beforeEach(function () {
    removeLibModuleCache()
    ApiToken = createApiTokenModelFake()
    errorForbidden = sinon.stub()
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/models', { ApiToken })
    mock('../../lib/response', { errorForbidden })
    controller = require('../../lib/memory/tokenController')
  })

  afterEach(function () {
    mock.stopAll()
    sinon.restore()
    removeLibModuleCache()
  })

  function request (userId, extra) {
    return Object.assign({
      params: {},
      body: {},
      user: userId ? { id: userId } : undefined,
      isAuthenticated: () => !!userId,
      csrfToken: () => 'csrf-token'
    }, extra)
  }

  function response () {
    const res = { render: sinon.stub() }
    res.status = sinon.stub().returns(res)
    res.json = sinon.stub().returns(res)
    return res
  }

  function sentStatus (res) {
    return res.status.called ? res.status.lastCall.args[0] : 200
  }

  function sentBody (res) {
    return res.json.lastCall.args[0]
  }

  async function create (userId, name) {
    const res = response()
    await controller.createToken(request(userId, { body: { name } }), res)
    return res
  }

  describe('createToken', function () {
    it('returns the full token once and stores only its hash', async function () {
      const res = await create('user-1', 'laptop')
      assert.strictEqual(sentStatus(res), 201)
      const body = sentBody(res)
      assert.strictEqual(body.status, 'ok')
      assert(body.token.startsWith('cmdm_'))
      assert.strictEqual(body.apiToken.name, 'laptop')
      assert(body.token.startsWith(body.apiToken.prefix))
      const row = ApiToken.rows[0]
      assert.strictEqual(row.userId, 'user-1')
      assert.strictEqual(row.tokenHash, crypto.createHash('sha256').update(body.token).digest('hex'))
      assert(!Object.values(row).includes(body.token))
    })

    it('trims the name', async function () {
      await create('user-1', '  laptop  ')
      assert.strictEqual(ApiToken.rows[0].name, 'laptop')
    })

    it('rejects a blank name with 400', async function () {
      const res = await create('user-1', '   ')
      assert.strictEqual(sentStatus(res), 400)
      assert.strictEqual(sentBody(res).status, 'error')
      assert.strictEqual(ApiToken.rows.length, 0)
    })

    it('rejects a missing name with 400', async function () {
      const res = response()
      await controller.createToken(request('user-1', { body: undefined }), res)
      assert.strictEqual(sentStatus(res), 400)
    })

    it('rejects a name over 100 characters with 400', async function () {
      const res = await create('user-1', 'x'.repeat(101))
      assert.strictEqual(sentStatus(res), 400)
      assert.strictEqual(ApiToken.rows.length, 0)
    })

    it('rejects a signed-out caller with 401', async function () {
      const res = await create(null, 'laptop')
      assert.strictEqual(sentStatus(res), 401)
      assert.strictEqual(ApiToken.rows.length, 0)
    })
  })

  describe('listTokens', function () {
    it('lists only the caller\'s tokens without hashes', async function () {
      await create('user-1', 'mine')
      await create('user-2', 'theirs')
      const res = response()
      await controller.listTokens(request('user-1'), res)
      const { status, tokens } = sentBody(res)
      assert.strictEqual(status, 'ok')
      assert.strictEqual(tokens.length, 1)
      assert.deepStrictEqual(Object.keys(tokens[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix'])
      assert.strictEqual(tokens[0].name, 'mine')
    })

    it('rejects a signed-out caller with 401', async function () {
      const res = response()
      await controller.listTokens(request(null), res)
      assert.strictEqual(sentStatus(res), 401)
    })
  })

  describe('deleteToken', function () {
    async function remove (userId, tokenId) {
      const res = response()
      await controller.deleteToken(request(userId, { params: { tokenId } }), res)
      return res
    }

    it('deletes the caller\'s own token', async function () {
      const { apiToken } = sentBody(await create('user-1', 'laptop'))
      const res = await remove('user-1', apiToken.id)
      assert.deepStrictEqual(sentBody(res), { status: 'ok' })
      assert.strictEqual(ApiToken.rows.length, 0)
    })

    it('answers 404 for another user\'s token and keeps it', async function () {
      const { apiToken } = sentBody(await create('user-2', 'theirs'))
      const res = await remove('user-1', apiToken.id)
      assert.strictEqual(sentStatus(res), 404)
      assert.strictEqual(ApiToken.rows.length, 1)
    })

    it('answers 404 for an id that is not a UUID without querying', async function () {
      ApiToken.destroy = sinon.stub().rejects(new Error('invalid input syntax for type uuid'))
      const res = await remove('user-1', 'not-a-uuid')
      assert.strictEqual(sentStatus(res), 404)
      assert(ApiToken.destroy.called === false)
    })

    it('rejects a signed-out caller with 401', async function () {
      const { apiToken } = sentBody(await create('user-1', 'laptop'))
      const res = await remove(null, apiToken.id)
      assert.strictEqual(sentStatus(res), 401)
      assert.strictEqual(ApiToken.rows.length, 1)
    })
  })

  it('answers 500 JSON when the database fails', async function () {
    ApiToken.findAll = async () => { throw new Error('db down') }
    const res = response()
    await controller.listTokens(request('user-1'), res)
    assert.strictEqual(sentStatus(res), 500)
    assert.deepStrictEqual(sentBody(res), { status: 'error', message: 'Internal error' })
  })

  describe('showTokenPage', function () {
    it('renders the caller\'s tokens with a CSRF token', async function () {
      await create('user-1', 'mine')
      await create('user-2', 'theirs')
      const res = response()
      await controller.showTokenPage(request('user-1'), res)
      const [view, data] = res.render.lastCall.args
      assert.strictEqual(view, 'api-token.ejs')
      assert.strictEqual(data.csrfToken, 'csrf-token')
      assert.deepStrictEqual(data.tokens.map(t => t.name), ['mine'])
      assert.strictEqual(data.tokens[0].tokenHash, undefined)
    })

    it('sends a signed-out visitor to the existing forbidden flow', async function () {
      const res = response()
      await controller.showTokenPage(request(null), res)
      assert(errorForbidden.calledOnce)
      assert(res.render.called === false)
    })
  })
})
