/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { loadRealNoteModel } = require('../testDoubles/noteModelFake')
const { removeLibModuleCache } = require('../realtime/utils')

describe('memory tags', function () {
  let Note
  let memoryTags

  beforeEach(function () {
    removeLibModuleCache()
    mock('../../lib/logger', createFakeLogger())
    Note = loadRealNoteModel()
    mock('../../lib/models', { Note })
    memoryTags = require('../../lib/memory/memoryTags')
  })

  afterEach(function () {
    mock.stopAll()
    removeLibModuleCache()
  })

  describe('validation', function () {
    it('accepts global and project scopes', function () {
      for (const scope of ['global', 'project:codimd', 'project:My.App_x-1', 'project:' + 'a'.repeat(100)]) {
        assert.strictEqual(memoryTags.isValidScope(scope), true, scope)
      }
    })

    it('rejects malformed scopes', function () {
      for (const scope of ['', 'Global', 'project:', 'project:-x', 'project:a b', 'project:a:b', 'project:' + 'a'.repeat(101), 'projects:x', undefined, 3]) {
        assert.strictEqual(memoryTags.isValidScope(scope), false, String(scope))
      }
    })

    it('accepts exactly the six memory types', function () {
      assert.deepStrictEqual(memoryTags.MEMORY_TYPES, ['user', 'feedback', 'project', 'reference', 'doc', 'handoff'])
      for (const type of memoryTags.MEMORY_TYPES) assert.strictEqual(memoryTags.isValidType(type), true)
      for (const type of ['User', 'note', '', undefined]) assert.strictEqual(memoryTags.isValidType(type), false)
    })

    it('rejects extra tags that would change the memory meaning or break the tag line', function () {
      for (const tag of ['memory', 'archived', 'global', 'project:x', 'user', '', ' ', 'a,b', 'a b', 'a: b', 'abc:', '#x', '"x"', 'a\nb', 'x'.repeat(101), 5]) {
        assert.strictEqual(typeof memoryTags.extraTagError(tag), 'string', JSON.stringify(tag))
      }
      for (const tag of ['testing', 'c++', 'a:b', '筆記', 'v1.2', 'k8s/helm']) {
        assert.strictEqual(memoryTags.extraTagError(tag), null, tag)
      }
    })
  })

  describe('buildMemoryContent', function () {
    it('writes frontmatter tags, a title heading, and the body', function () {
      const content = memoryTags.buildMemoryContent({ title: 'Prefer pnpm', body: 'Use pnpm here.', scope: 'project:codimd', type: 'feedback', tags: ['tooling'] })
      assert.strictEqual(content, '---\ntags: memory, project:codimd, feedback, tooling\n---\n# Prefer pnpm\n\nUse pnpm here.\n')
    })

    it('round-trips through the real Note parser', function () {
      const content = memoryTags.buildMemoryContent({ title: 'Who I am', body: 'Body', scope: 'project:my.app_x-1', type: 'user', tags: ['a:b', '筆記', 'c++'] })
      assert.deepStrictEqual(Note.parseNoteInfo(content), { title: 'Who I am', tags: ['memory', 'project:my.app_x-1', 'user', 'a:b', '筆記', 'c++'] })
      assert.deepStrictEqual(memoryTags.parseMemory(content), {
        isMemory: true,
        scope: 'project:my.app_x-1',
        type: 'user',
        archived: false,
        tags: ['memory', 'project:my.app_x-1', 'user', 'a:b', '筆記', 'c++']
      })
    })

    it('drops duplicate extra tags', function () {
      const content = memoryTags.buildMemoryContent({ title: 'T', body: '', scope: 'global', type: 'doc', tags: ['x', 'x'] })
      assert.deepStrictEqual(memoryTags.parseMemory(content).tags, ['memory', 'global', 'doc', 'x'])
    })
  })

  describe('parseMemory', function () {
    it('reports a note without the memory tag as not memory', function () {
      assert.strictEqual(memoryTags.parseMemory('---\ntags: global, user\n---\n# T').isMemory, false)
      assert.strictEqual(memoryTags.parseMemory('# plain note mentioning memory').isMemory, false)
      assert.strictEqual(memoryTags.parseMemory('').isMemory, false)
    })

    it('reads tags in YAML list form', function () {
      const parsed = memoryTags.parseMemory('---\ntitle: x\ntags:\n  - memory\n  - "project:codimd"\n  - handoff\n  - archived\n---\nbody')
      assert.deepStrictEqual(parsed, { isMemory: true, scope: 'project:codimd', type: 'handoff', archived: true, tags: ['memory', 'project:codimd', 'handoff', 'archived'] })
    })

    it('leaves scope and type null when the memory note lacks them', function () {
      assert.deepStrictEqual(memoryTags.parseMemory('---\ntags: memory\n---\n'), { isMemory: true, scope: null, type: null, archived: false, tags: ['memory'] })
    })

    it('treats unparseable frontmatter as having no tags', function () {
      assert.strictEqual(memoryTags.parseMemory('---\ntags: [memory\n---\n').isMemory, false)
    })
  })

  describe('archiveContent', function () {
    it('appends archived to a comma tag line and keeps the rest of the note', function () {
      const content = '---\ntitle: Keep me\ntags: memory, global, user\nrobots: noindex\n---\n# T\n\nbody\n'
      assert.strictEqual(memoryTags.archiveContent(content), '---\ntitle: Keep me\ntags: memory, global, user, archived\nrobots: noindex\n---\n# T\n\nbody\n')
    })

    it('replaces a YAML list tag block in place', function () {
      const content = '---\ntags:\n- memory\n- global\n- reference\ndescription: d\n---\nbody'
      const archived = memoryTags.archiveContent(content)
      assert.strictEqual(archived, '---\ntags: memory, global, reference, archived\ndescription: d\n---\nbody')
      assert.strictEqual(Note.extractMeta(archived).meta.description, 'd')
    })

    it('quotes tags that are unsafe as plain YAML', function () {
      const content = '---\ntags: ["memory", "global", "doc", "a: b"]\n---\nbody'
      const archived = memoryTags.archiveContent(content)
      assert.deepStrictEqual(memoryTags.parseMemory(archived).tags, ['memory', 'global', 'doc', 'a: b', 'archived'])
      assert(archived.endsWith('\n---\nbody'))
    })

    it('adds frontmatter to a memory note tagged through the tags heading', function () {
      const content = '# T\n\n###### tags: `memory` `global` `user`\n'
      const archived = memoryTags.archiveContent(content)
      assert.strictEqual(archived, '---\ntags: memory, global, user, archived\n---\n' + content)
      assert.strictEqual(memoryTags.parseMemory(archived).archived, true)
    })

    it('is idempotent', function () {
      const once = memoryTags.archiveContent('---\ntags: memory, global, user\n---\nbody')
      assert.strictEqual(memoryTags.archiveContent(once), once)
    })
  })
})
