/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const mock = require('mock-require')

const { removeLibModuleCache } = require('../realtime/utils')

describe('auth return-to', function () {
  let utils

  function load (serverURL) {
    removeLibModuleCache()
    mock('../../lib/config', { serverURL })
    mock('../../lib/models', {})
    utils = require('../../lib/auth/utils')
  }

  function request (referer, session = {}) {
    return { session, get: () => referer }
  }

  afterEach(function () {
    mock.stopAll()
    removeLibModuleCache()
  })

  it('keeps a shared note and its editor mode from the next parameter', function () {
    load('http://localhost:3000')
    const req = request('http://localhost:3000/?next=%2Fabc%3Fboth')
    utils.setReturnToFromReferer(req)
    assert.strictEqual(req.session.returnTo, 'http://localhost:3000/abc?both')
    assert.strictEqual(utils.signinPageURL(req), 'http://localhost:3000/?next=%2Fabc%3Fboth')
  })

  it('keeps the deployment sub-path', function () {
    load('https://example.com/codimd')
    const req = request('https://example.com/codimd/?next=%2Fabc%3Fboth')
    utils.setReturnToFromReferer(req)
    assert.strictEqual(req.session.returnTo, 'https://example.com/codimd/abc?both')
    assert.strictEqual(utils.signinPageURL(req), 'https://example.com/codimd/?next=%2Fabc%3Fboth')
  })

  it('rejects off-site and out-of-deployment targets', function () {
    load('https://example.com/codimd')
    for (const target of ['//evil.test/x', '/\\evil.test/x', 'https://evil.test/x', 'https://example.com/other', 'javascript:alert(1)']) {
      assert.strictEqual(utils.safeReturnTo(target), null, target)
    }
    const req = request('https://example.com/codimd/?next=' + encodeURIComponent('/\\evil.test'))
    utils.setReturnToFromReferer(req)
    assert.strictEqual(req.session.returnTo, 'https://example.com/codimd')
    assert.strictEqual(utils.signinPageURL(req), 'https://example.com/codimd/')
  })

  it('keeps the session destination through passport login and failures in every provider', function () {
    const directory = path.join(__dirname, '../../lib/auth')
    for (const provider of fs.readdirSync(directory)) {
      const file = path.join(directory, provider, 'index.js')
      if (!fs.existsSync(file)) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.match(/failureRedirect: [^\n]+/g) || []) {
        assert.strictEqual(match.replace(/,$/, ''), "failureRedirect: config.serverURL + '/auth/failure'", provider)
      }
      // passport 0.6 regenerates the session on login and drops returnTo without this flag
      const successes = (source.match(/successReturnToOrRedirect/g) || []).length
      assert.strictEqual((source.match(/keepSessionInfo: true/g) || []).length, successes, provider)
    }
  })
})
