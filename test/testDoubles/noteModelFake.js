'use strict'

const crypto = require('crypto')
const Sequelize = require('sequelize')
const shortId = require('shortid')

// The real Note model definition, built on a Sequelize instance that never connects,
// so tests exercise the real frontmatter, tag, title, and note id helpers.
function loadRealNoteModel () {
  const sequelize = new Sequelize('codimd', 'user', 'password', { dialect: 'postgres', logging: false })
  return require('../../lib/models/note')(sequelize, Sequelize.DataTypes)
}

function matchesValue (actual, expected) {
  if (expected && typeof expected === 'object') {
    const like = expected[Sequelize.Op.like]
    if (like === undefined) throw new Error('noteModelFake: unsupported where clause')
    const needle = like.replace(/^%|%$/g, '')
    return typeof actual === 'string' && actual.includes(needle)
  }
  return actual === expected
}

function matches (row, where) {
  return Object.keys(where).every(key => matchesValue(row[key], where[key]))
}

// In-memory stand-in for the Note model: real static helpers, fake persistence.
function createNoteModelFake () {
  const real = loadRealNoteModel()
  const rows = []
  const calls = { findAll: [], findOne: [], create: [], update: [] }

  function toInstance (row) {
    return Object.assign({}, row, {
      update: async function (values) {
        calls.update.push({ id: row.id, values })
        Object.assign(row, values, { updatedAt: new Date() })
        Object.assign(this, row)
        return this
      }
    })
  }

  function insert (values) {
    const now = new Date()
    const row = Object.assign({
      id: crypto.randomUUID(),
      shortid: shortId.generate(),
      alias: null,
      permission: null,
      ownerId: null,
      title: '',
      content: '',
      authorship: [],
      lastchangeuserId: null,
      lastchangeAt: null,
      createdAt: now,
      updatedAt: now
    }, values)
    rows.push(row)
    return row
  }

  return {
    rows,
    calls,
    insert,
    parseNoteInfo: real.parseNoteInfo,
    parseNoteTitle: real.parseNoteTitle,
    extractMeta: real.extractMeta,
    extractNoteTags: real.extractNoteTags,
    encodeNoteId: real.encodeNoteId,
    decodeNoteId: real.decodeNoteId,
    checkNoteIdValid: real.checkNoteIdValid,
    findAll: async options => {
      calls.findAll.push(options)
      return rows.filter(row => matches(row, options.where)).map(toInstance)
    },
    findOne: async options => {
      calls.findOne.push(options)
      const row = rows.find(row => matches(row, options.where))
      return row ? toInstance(row) : null
    },
    create: async values => {
      calls.create.push(values)
      return toInstance(insert(values))
    }
  }
}

exports.loadRealNoteModel = loadRealNoteModel
exports.createNoteModelFake = createNoteModelFake
