/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const mock = require('mock-require')
const sinon = require('sinon')
const Sequelize = require('sequelize')

// Load the real title parser without opening a database or revision worker.
const Note = require('../../lib/models/note')({ define: () => ({}) }, Sequelize)

describe('response#newNote', function () {
  let config
  let models
  let history
  let req
  let res
  let newNote

  beforeEach(function () {
    config = { documentMaxLength: 100000, allowAnonymous: true, serverURL: 'http://localhost/notes' }
    models = {
      Note: {
        create: sinon.stub().resolves({ id: 'note-id' }),
        parseNoteTitle: Note.parseNoteTitle,
        encodeNoteId: () => 'encoded-id'
      }
    }
    history = { updateHistory: sinon.spy() }
    mock('../../lib/config', config)
    mock('../../lib/logger', { info () {}, error () {} })
    mock('../../lib/models', models)
    mock('../../lib/history', history)
    newNote = mock.reRequire('../../lib/response').newNote
    req = { isAuthenticated: () => true, user: { id: 'owner' }, flash: sinon.spy(), originalUrl: '/new' }
    res = { redirect: sinon.spy(), status: sinon.stub().returnsThis(), render: sinon.spy() }
  })

  afterEach(function () {
    mock.stopAll()
    delete require.cache[require.resolve('../../lib/response')]
    sinon.restore()
  })

  async function create () {
    newNote(req, res)
    await new Promise(resolve => setImmediate(resolve))
  }

  for (const [body, title] of [
    ['---\r\ntitle: 中文標題\r\ntags: [測試]\r\n---\r\n# H1\r\n內文', '中文標題'],
    ['# H1 標題\n正文', 'H1 標題'],
    ['正文，沒有標題', 'Untitled'],
    [' \n', 'Untitled']
  ]) {
    it(`sets the initial title to ${title} from the normalized body`, async function () {
      req.body = body
      await create()
      assert.deepStrictEqual(models.Note.create.firstCall.args[0], {
        ownerId: 'owner', alias: null, content: body.replace(/\r/g, ''), title
      })
      assert.strictEqual(res.redirect.firstCall.args[0], 'http://localhost/notes/encoded-id')
      assert.strictEqual(history.updateHistory.firstCall.args[2], body.replace(/\r/g, ''))
    })
  }

  for (const body of [undefined, '', '\r\r']) {
    it(`leaves template and title selection to the model for ${JSON.stringify(body)}`, async function () {
      req.body = body
      await create()
      assert.deepStrictEqual(models.Note.create.firstCall.args[0], { ownerId: 'owner', alias: null, content: '' })
    })
  }

  it('allows guests without adding an owner or server history', async function () {
    req.isAuthenticated = () => false
    req.user = null
    req.body = '# Guest'
    await create()
    assert.strictEqual(models.Note.create.firstCall.args[0].ownerId, null)
    assert.strictEqual(history.updateHistory.callCount, 0)
  })

  it('rejects unauthenticated creation when anonymous creation is disabled', async function () {
    config.allowAnonymous = false
    req.isAuthenticated = () => false
    req.user = null
    req.body = '# Guest'
    await create()
    assert.strictEqual(models.Note.create.callCount, 0)
    assert.strictEqual(res.redirect.firstCall.args[0], 'http://localhost/notes?next=%2Fnew')
  })

  it('rejects oversized bodies before creating a note', async function () {
    req.body = 'x'.repeat(config.documentMaxLength + 1)
    await create()
    assert.strictEqual(models.Note.create.callCount, 0)
    assert.strictEqual(res.status.firstCall.args[0], '413')
  })

  it('renders a server error without retrying failed creation', async function () {
    req.body = '# Error'
    models.Note.create.rejects(new Error('database unavailable'))
    await create()
    assert.strictEqual(models.Note.create.callCount, 1)
    assert.strictEqual(res.status.firstCall.args[0], '500')
  })
})
