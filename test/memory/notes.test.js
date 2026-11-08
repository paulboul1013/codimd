/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const http = require('http')
const express = require('express')
const mock = require('mock-require')

const { createFakeLogger } = require('../testDoubles/loggerFake')
const { createApiTokenModelFake } = require('../testDoubles/apiTokenModelFake')
const { createNoteModelFake } = require('../testDoubles/noteModelFake')
const { removeLibModuleCache } = require('../realtime/utils')

const NOT_FOUND = { status: 'error', message: 'Not found' }

describe('memory notes API', function () {
  let Note
  let revisions
  let openNoteIds
  let config
  let server
  let token
  let otherToken

  beforeEach(function (done) {
    removeLibModuleCache()
    mock('../../lib/logger', createFakeLogger())
    const ApiToken = createApiTokenModelFake()
    Note = createNoteModelFake()
    revisions = []
    openNoteIds = new Set()
    mock('../../lib/models', {
      ApiToken,
      Note,
      Revision: {
        saveNoteRevisionAsync: async note => {
          revisions.push({ noteId: note.id, content: note.content })
          return {}
        }
      }
    })
    mock('../../lib/realtime/realtime', { isNoteExistsInPool: id => openNoteIds.has(id) })
    config = require('../../lib/config')
    const apiToken = require('../../lib/memory/apiToken')
    Promise.all(['user-1', 'user-2'].map(async userId => {
      const generated = apiToken.generateToken()
      await ApiToken.create({ userId, name: 'agent', tokenHash: generated.tokenHash, prefix: generated.prefix })
      return generated.token
    })).then(([first, second]) => {
      token = first
      otherToken = second
      const app = express()
      app.use('/api/memory', require('../../lib/memory/router'))
      server = app.listen(0, '127.0.0.1', done)
    }, done)
  })

  afterEach(function (done) {
    mock.stopAll()
    removeLibModuleCache()
    server.close(done)
  })

  function call (method, path, body, bearer = token) {
    return new Promise((resolve, reject) => {
      const { port } = server.address()
      const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
      const headers = { Authorization: `Bearer ${bearer}` }
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  const memory = (tags, rest = '\n# Title\n\nbody\n') => `---\ntags: ${tags}\n---${rest}`

  function seed (values) {
    const row = Note.insert(Object.assign({ ownerId: 'user-1', permission: 'private' }, values))
    return { row, id: Note.encodeNoteId(row.id) }
  }

  async function create (overrides) {
    return call('POST', '/api/memory/notes', Object.assign({ title: 'Prefer pnpm', body: 'Use pnpm.', scope: 'project:codimd', type: 'feedback' }, overrides))
  }

  describe('POST /notes', function () {
    it('creates a private memory note owned by the token user and saves a revision', async function () {
      const res = await create({ tags: ['tooling'] })
      assert.strictEqual(res.status, 201)
      const { note } = res.body
      assert.strictEqual(res.body.status, 'ok')
      assert.strictEqual(note.title, 'Prefer pnpm')
      assert.strictEqual(note.content, '---\ntags: memory, project:codimd, feedback, tooling\n---\n# Prefer pnpm\n\nUse pnpm.\n')
      assert.strictEqual(note.scope, 'project:codimd')
      assert.strictEqual(note.type, 'feedback')
      assert.deepStrictEqual(note.tags, ['memory', 'project:codimd', 'feedback', 'tooling'])
      assert.strictEqual(note.archived, false)
      assert.strictEqual(note.url, config.serverURL + '/' + note.id)
      assert(note.createdAt && note.updatedAt)

      const row = Note.rows[0]
      assert.strictEqual(note.id, Note.encodeNoteId(row.id))
      assert.strictEqual(row.permission, 'private')
      assert.strictEqual(row.ownerId, 'user-1')
      assert.strictEqual(row.lastchangeuserId, 'user-1')
      assert.deepStrictEqual(row.authorship[0].slice(0, 3), ['user-1', 0, row.content.length])
      assert.deepStrictEqual(revisions, [{ noteId: row.id, content: row.content }])
    })

    it('ignores a permission or owner in the request body', async function () {
      const res = await create({ permission: 'freely', ownerId: 'user-2' })
      assert.strictEqual(res.status, 201)
      assert.strictEqual(Note.rows[0].permission, 'private')
      assert.strictEqual(Note.rows[0].ownerId, 'user-1')
    })

    for (const [label, overrides] of [
      ['an invalid scope', { scope: 'project:bad name' }],
      ['a missing scope', { scope: undefined }],
      ['an invalid type', { type: 'diary' }],
      ['an empty title', { title: '   ' }],
      ['a multi-line title', { title: 'a\nb' }],
      ['a reserved extra tag', { tags: ['archived'] }],
      ['tags that are not an array', { tags: 'x' }],
      ['a too long body', { body: 'x'.repeat(100001) }]
    ]) {
      it(`rejects ${label} with 400 and writes nothing`, async function () {
        const res = await create(overrides)
        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.status, 'error')
        assert.strictEqual(Note.rows.length, 0)
        assert.strictEqual(revisions.length, 0)
      })
    }

    it('rejects malformed JSON with 400', async function () {
      const res = await call('POST', '/api/memory/notes', '{"title":')
      assert.strictEqual(res.status, 400)
      assert.strictEqual(Note.rows.length, 0)
    })
  })

  describe('GET /notes/:id', function () {
    it('returns the full note and metadata by encoded id and by shortid', async function () {
      const { row, id } = seed({ title: 'Title', content: memory('memory, global, user'), lastchangeAt: new Date('2026-01-02') })
      for (const ref of [id, row.shortid]) {
        const res = await call('GET', '/api/memory/notes/' + ref)
        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body, {
          status: 'ok',
          note: {
            id,
            title: 'Title',
            content: row.content,
            scope: 'global',
            type: 'user',
            tags: ['memory', 'global', 'user'],
            archived: false,
            createdAt: row.createdAt.toISOString(),
            updatedAt: '2026-01-02T00:00:00.000Z',
            url: config.serverURL + '/' + id
          }
        })
      }
    })
  })

  describe('not found isolation', function () {
    let plain, foreign, missing
    beforeEach(function () {
      plain = seed({ content: '# Plain note about memory\n' }).id
      foreign = seed({ ownerId: 'user-2', content: memory('memory, global, user') }).id
      missing = Note.encodeNoteId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    })

    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PUT', '', { content: memory('memory, global, user') }],
      ['POST', '/append', { text: 'more' }],
      ['POST', '/archive', undefined]
    ]) {
      it(`answers ${method} ${suffix || '/'} on plain, foreign, missing, and malformed ids with the same 404`, async function () {
        for (const ref of [plain, foreign, missing, 'not-a-real-id!', 'some-alias.md']) {
          const res = await call(method, '/api/memory/notes/' + encodeURIComponent(ref) + suffix, body)
          assert.strictEqual(res.status, 404, ref)
          assert.deepStrictEqual(res.body, NOT_FOUND)
        }
        assert.strictEqual(Note.calls.update.length, 0)
        assert.strictEqual(revisions.length, 0)
      })
    }

    it('hides the other user notes from the owner token too', async function () {
      const res = await call('GET', '/api/memory/notes/' + foreign, undefined, otherToken)
      assert.strictEqual(res.status, 200)
      const mine = await call('GET', '/api/memory/notes/' + foreign)
      assert.strictEqual(mine.status, 404)
    })
  })

  describe('GET /notes', function () {
    beforeEach(function () {
      seed({ title: 'old global', content: memory('memory, global, user', '\n# old global\n\nPrefers Tabs\n'), lastchangeAt: new Date('2026-01-01') })
      seed({ title: 'new project', content: memory('memory, project:codimd, feedback'), lastchangeAt: new Date('2026-03-01') })
      seed({ title: 'archived', content: memory('memory, project:codimd, feedback, archived'), lastchangeAt: new Date('2026-04-01') })
      seed({ title: 'other project', content: memory('memory, project:other, doc'), lastchangeAt: new Date('2026-02-01') })
      seed({ title: 'plain', content: '# plain\nmentions memory\n', lastchangeAt: new Date('2026-05-01') })
      seed({ title: 'foreign', ownerId: 'user-2', content: memory('memory, global, user'), lastchangeAt: new Date('2026-05-01') })
    })

    async function titles (query) {
      const res = await call('GET', '/api/memory/notes' + query)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.body.status, 'ok')
      return res.body.notes.map(note => note.title)
    }

    it('lists only the owner memory notes, newest first, without archived ones', async function () {
      assert.deepStrictEqual(await titles(''), ['new project', 'other project', 'old global'])
    })

    it('filters in SQL by owner and the memory word first', async function () {
      await titles('')
      const where = Note.calls.findAll[0].where
      assert.strictEqual(where.ownerId, 'user-1')
      assert(where.content)
    })

    it('includes archived notes on request', async function () {
      assert.deepStrictEqual(await titles('?includeArchived=true'), ['archived', 'new project', 'other project', 'old global'])
    })

    it('filters by scope and type', async function () {
      assert.deepStrictEqual(await titles('?scope=project:codimd'), ['new project'])
      assert.deepStrictEqual(await titles('?type=doc'), ['other project'])
      assert.deepStrictEqual(await titles('?scope=global&type=feedback'), [])
    })

    it('matches the keyword case-insensitively across the content', async function () {
      assert.deepStrictEqual(await titles('?q=prefers%20tabs'), ['old global'])
      assert.deepStrictEqual(await titles('?q=PROJECT:OTHER'), ['other project'])
    })

    it('returns the summary shape', async function () {
      const res = await call('GET', '/api/memory/notes?type=doc')
      const note = res.body.notes[0]
      assert.deepStrictEqual(Object.keys(note).sort(), ['archived', 'id', 'scope', 'tags', 'title', 'type', 'updatedAt'])
      assert.strictEqual(note.updatedAt, '2026-02-01T00:00:00.000Z')
    })

    it('rejects an invalid scope or type filter with 400', async function () {
      assert.strictEqual((await call('GET', '/api/memory/notes?scope=nope')).status, 400)
      assert.strictEqual((await call('GET', '/api/memory/notes?type=nope')).status, 400)
    })
  })

  describe('PUT /notes/:id', function () {
    it('replaces the content and records title, author, and a revision', async function () {
      const { row, id } = seed({ content: memory('memory, global, user') })
      const content = memory('memory, global, user', '\n# New title\n\nnew body\n')
      const res = await call('PUT', '/api/memory/notes/' + id, { content })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.body.note.content, content)
      assert.strictEqual(res.body.note.title, 'New title')
      assert.strictEqual(row.content, content)
      assert.strictEqual(row.title, 'New title')
      assert.strictEqual(row.lastchangeuserId, 'user-1')
      assert(row.lastchangeAt)
      assert.deepStrictEqual(row.authorship[0].slice(0, 3), ['user-1', 0, content.length])
      assert.deepStrictEqual(revisions, [{ noteId: row.id, content }])
    })

    for (const [label, content] of [
      ['content without the memory tag', '---\ntags: global, user\n---\n# T\n'],
      ['empty content', ''],
      ['too long content', memory('memory, global, user', '\n' + 'x'.repeat(100001))]
    ]) {
      it(`rejects ${label} with 400 and leaves the note unchanged`, async function () {
        const { row, id } = seed({ content: memory('memory, global, user') })
        const before = row.content
        const res = await call('PUT', '/api/memory/notes/' + id, { content })
        assert.strictEqual(res.status, 400)
        assert.strictEqual(row.content, before)
        assert.strictEqual(revisions.length, 0)
      })
    }
  })

  describe('POST /notes/:id/append', function () {
    it('appends the text after a blank line at the end', async function () {
      const { row, id } = seed({ content: memory('memory, global, user', '\n# T\n\nbody') })
      const res = await call('POST', '/api/memory/notes/' + id + '/append', { text: 'more' })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(row.content, memory('memory, global, user', '\n# T\n\nbody\n\nmore'))
      assert.strictEqual(revisions.length, 1)
    })

    it('rejects empty text with 400', async function () {
      const { id } = seed({ content: memory('memory, global, user') })
      assert.strictEqual((await call('POST', '/api/memory/notes/' + id + '/append', { text: '' })).status, 400)
    })
  })

  describe('POST /notes/:id/archive', function () {
    it('adds the archived tag once and keeps the note', async function () {
      const { row, id } = seed({ content: memory('memory, global, user') })
      const first = await call('POST', '/api/memory/notes/' + id + '/archive')
      assert.strictEqual(first.status, 200)
      assert.strictEqual(first.body.note.archived, true)
      assert.strictEqual(row.content, memory('memory, global, user, archived'))
      const second = await call('POST', '/api/memory/notes/' + id + '/archive')
      assert.strictEqual(second.status, 200)
      assert.strictEqual(second.body.note.archived, true)
      assert.strictEqual(row.content, memory('memory, global, user, archived'))
      assert.strictEqual(revisions.length, 1)
      assert.strictEqual(Note.calls.update.length, 1)
    })

    it('still reads an archived note by id', async function () {
      const { id } = seed({ content: memory('memory, global, user, archived') })
      const res = await call('GET', '/api/memory/notes/' + id)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.body.note.archived, true)
    })
  })

  describe('a note open in the editor', function () {
    for (const [method, suffix, body] of [
      ['PUT', '', { content: '---\ntags: memory, global, user\n---\n# changed\n' }],
      ['POST', '/append', { text: 'more' }],
      ['POST', '/archive', undefined]
    ]) {
      it(`answers ${method} ${suffix || '/'} with 409 and writes nothing`, async function () {
        const { row, id } = seed({ content: memory('memory, global, user') })
        openNoteIds.add(row.id)
        const before = row.content
        const res = await call(method, '/api/memory/notes/' + id + suffix, body)
        assert.strictEqual(res.status, 409)
        assert.deepStrictEqual(res.body, { status: 'error', message: 'Note is open in the editor' })
        assert.strictEqual(row.content, before)
        assert.strictEqual(revisions.length, 0)
      })
    }

    it('still allows reading it', async function () {
      const { row, id } = seed({ content: memory('memory, global, user') })
      openNoteIds.add(row.id)
      assert.strictEqual((await call('GET', '/api/memory/notes/' + id)).status, 200)
    })
  })
})
