'use strict'

const crypto = require('crypto')

// In-memory stand-in for the ApiToken Sequelize model, covering the calls lib/memory makes.
function createApiTokenModelFake () {
  const rows = []

  function matches (row, where) {
    return Object.keys(where).every(key => row[key] === where[key])
  }

  function toInstance (row) {
    return Object.assign({}, row, {
      update: async function (values) {
        Object.assign(row, values)
        Object.assign(this, values)
        return this
      }
    })
  }

  return {
    rows,
    findOne: async ({ where }) => {
      const row = rows.find(row => matches(row, where))
      return row ? toInstance(row) : null
    },
    findAll: async ({ where }) => rows.filter(row => matches(row, where)).map(toInstance),
    create: async values => {
      const now = new Date()
      const row = Object.assign({ id: crypto.randomUUID(), lastUsedAt: null, createdAt: now, updatedAt: now }, values)
      rows.push(row)
      return toInstance(row)
    },
    destroy: async ({ where }) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1)
      }
      return before - rows.length
    }
  }
}

exports.createApiTokenModelFake = createApiTokenModelFake
