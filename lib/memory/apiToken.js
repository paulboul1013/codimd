'use strict'

const crypto = require('crypto')

const models = require('../models')

const TOKEN_PREFIX = 'cmdm_'
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 6

function hashToken (token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function generateToken () {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashToken(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH)
  }
}

function parseBearer (authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null
  const match = /^Bearer +(\S+) *$/i.exec(authorizationHeader)
  return match ? match[1] : null
}

// Resolves to { id, userId } for a live token, or null. A revoked token is a deleted row, so it reads as unknown.
async function authenticate (authorizationHeader) {
  const token = parseBearer(authorizationHeader)
  if (!token) return null
  const apiToken = await models.ApiToken.findOne({ where: { tokenHash: hashToken(token) } })
  if (!apiToken) return null
  await apiToken.update({ lastUsedAt: new Date() })
  return { id: apiToken.id, userId: apiToken.userId }
}

exports.generateToken = generateToken
exports.authenticate = authenticate
