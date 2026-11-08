/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const crypto = require('crypto')
const mock = require('mock-require')

const { createApiTokenModelFake } = require('../testDoubles/apiTokenModelFake')
const { removeLibModuleCache } = require('../realtime/utils')

describe('memory API token', function () {
  let apiToken
  let ApiToken

  beforeEach(function () {
    removeLibModuleCache()
    ApiToken = createApiTokenModelFake()
    mock('../../lib/models', { ApiToken })
    apiToken = require('../../lib/memory/apiToken')
  })

  afterEach(function () {
    mock.stopAll()
    removeLibModuleCache()
  })

  describe('generateToken', function () {
    it('returns a cmdm_ token carrying 32 random bytes in base64url', function () {
      const { token } = apiToken.generateToken()
      assert(token.startsWith('cmdm_'))
      const random = token.slice('cmdm_'.length)
      assert(/^[A-Za-z0-9_-]+$/.test(random))
      assert.strictEqual(Buffer.from(random, 'base64url').length, 32)
    })

    it('returns the SHA-256 hex of the token, never the token itself', function () {
      const { token, tokenHash } = apiToken.generateToken()
      assert.strictEqual(tokenHash, crypto.createHash('sha256').update(token).digest('hex'))
      assert.notStrictEqual(tokenHash, token)
    })

    it('returns a short display prefix taken from the start of the token', function () {
      const { token, prefix } = apiToken.generateToken()
      assert(token.startsWith(prefix))
      assert.strictEqual(prefix.length, 'cmdm_'.length + 6)
    })

    it('returns a different token each call', function () {
      assert.notStrictEqual(apiToken.generateToken().token, apiToken.generateToken().token)
    })
  })

  describe('authenticate', function () {
    async function issue (userId) {
      const generated = apiToken.generateToken()
      const row = await ApiToken.create({ userId, name: 'laptop', tokenHash: generated.tokenHash, prefix: generated.prefix })
      return { token: generated.token, row }
    }

    it('returns the owner of a valid bearer token', async function () {
      const { token, row } = await issue('user-1')
      const result = await apiToken.authenticate(`Bearer ${token}`)
      assert.deepStrictEqual(result, { id: row.id, userId: 'user-1' })
    })

    it('accepts the scheme in any case', async function () {
      const { token } = await issue('user-1')
      assert.strictEqual((await apiToken.authenticate(`bearer ${token}`)).userId, 'user-1')
    })

    it('records the time of each successful use', async function () {
      const { token } = await issue('user-1')
      const before = Date.now()
      await apiToken.authenticate(`Bearer ${token}`)
      const lastUsedAt = ApiToken.rows[0].lastUsedAt
      assert(lastUsedAt instanceof Date)
      assert(lastUsedAt.getTime() >= before)
    })

    it('returns null when the header is missing', async function () {
      assert.strictEqual(await apiToken.authenticate(undefined), null)
    })

    it('returns null for a non-Bearer scheme', async function () {
      const { token } = await issue('user-1')
      assert.strictEqual(await apiToken.authenticate(`Basic ${token}`), null)
    })

    it('returns null for an unknown token', async function () {
      await issue('user-1')
      assert.strictEqual(await apiToken.authenticate('Bearer cmdm_unknown'), null)
    })

    it('returns null once the token row is deleted', async function () {
      const { token, row } = await issue('user-1')
      await ApiToken.destroy({ where: { id: row.id } })
      assert.strictEqual(await apiToken.authenticate(`Bearer ${token}`), null)
    })

    it('does not touch lastUsedAt on a failed attempt', async function () {
      await issue('user-1')
      await apiToken.authenticate('Bearer cmdm_unknown')
      assert.strictEqual(ApiToken.rows[0].lastUsedAt, null)
    })
  })
})
