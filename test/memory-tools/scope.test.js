/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { loadRealNoteModel } = require('../testDoubles/noteModelFake')
const { removeLibModuleCache } = require('../realtime/utils')
const { TOOLS, invalidArguments } = require('../../tools/memory/tools')

describe('memory tools scope rule', function () {
  let memoryTags

  beforeEach(function () {
    removeLibModuleCache()
    mock('../../lib/logger', createFakeLogger())
    mock('../../lib/models', { Note: loadRealNoteModel() })
    memoryTags = require('../../lib/memory/memoryTags')
  })

  afterEach(function () {
    mock.stopAll()
    removeLibModuleCache()
  })

  const samples = [
    'global',
    'Global',
    'project:codimd',
    'project:CodiMD',
    'PROJECT:codimd',
    'project:My.App_x-1',
    'project:' + 'a'.repeat(100),
    'project:' + 'a'.repeat(101),
    'project:',
    'project:-lead',
    'project:bad name',
    'project:a/b'
  ]

  for (const tool of TOOLS.filter(tool => tool.inputSchema.properties.scope)) {
    it(`${tool.name} accepts exactly the scopes the server accepts`, function () {
      for (const scope of samples) {
        const args = { scope }
        for (const key of tool.inputSchema.required) if (key !== 'scope') args[key] = key === 'type' ? 'doc' : 'x'
        assert.strictEqual(invalidArguments(tool, args) === null, memoryTags.isValidScope(scope), scope)
      }
    })
  }
})
