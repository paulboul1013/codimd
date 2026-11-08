'use strict'

const models = require('../models')
const logger = require('../logger')
const { errorForbidden } = require('../response')
const { sendError } = require('./apiError')
const { generateToken } = require('./apiToken')

const MAX_NAME_LENGTH = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toListItem (apiToken) {
  return {
    id: apiToken.id,
    name: apiToken.name,
    prefix: apiToken.prefix,
    createdAt: apiToken.createdAt,
    lastUsedAt: apiToken.lastUsedAt
  }
}

async function findOwnTokens (userId) {
  const tokens = await models.ApiToken.findAll({
    where: { userId },
    order: [['createdAt', 'DESC']]
  })
  return tokens.map(toListItem)
}

function jsonHandler (handler) {
  return async (req, res) => {
    if (!req.isAuthenticated()) return sendError(res, 401, 'Sign in required')
    try {
      await handler(req, res)
    } catch (err) {
      logger.error('API token management failed: ' + err.message)
      sendError(res, 500, 'Internal error')
    }
  }
}

exports.listTokens = jsonHandler(async (req, res) => {
  res.json({ status: 'ok', tokens: await findOwnTokens(req.user.id) })
})

exports.createToken = jsonHandler(async (req, res) => {
  const rawName = req.body && req.body.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH) {
    return sendError(res, 400, `Name must be 1 to ${MAX_NAME_LENGTH} characters`)
  }
  const { token, tokenHash, prefix } = generateToken()
  const apiToken = await models.ApiToken.create({ userId: req.user.id, name, tokenHash, prefix })
  res.status(201).json({ status: 'ok', token, apiToken: toListItem(apiToken) })
})

exports.deleteToken = jsonHandler(async (req, res) => {
  const tokenId = req.params.tokenId
  if (!UUID_PATTERN.test(tokenId)) return sendError(res, 404, 'Token not found')
  const destroyed = await models.ApiToken.destroy({ where: { id: tokenId, userId: req.user.id } })
  if (!destroyed) return sendError(res, 404, 'Token not found')
  res.json({ status: 'ok' })
})

exports.showTokenPage = async (req, res) => {
  if (!req.isAuthenticated()) return errorForbidden(req, res)
  res.render('api-token.ejs', {
    title: 'API token - CodiMD',
    tokens: await findOwnTokens(req.user.id),
    csrfToken: req.csrfToken()
  })
}
