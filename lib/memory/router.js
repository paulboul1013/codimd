'use strict'

const { Router } = require('express')

const logger = require('../logger')
const { authenticate } = require('./apiToken')

const router = Router()

function sendError (res, status, message) {
  res.status(status).json({ status: 'error', message })
}

router.use(async (req, res, next) => {
  let apiToken
  try {
    apiToken = await authenticate(req.get('Authorization'))
  } catch (err) {
    logger.error('Memory API token lookup failed: ' + err.message)
    return sendError(res, 500, 'Internal error')
  }
  if (!apiToken) {
    res.set('WWW-Authenticate', 'Bearer')
    return sendError(res, 401, 'Missing, invalid, or revoked API token')
  }
  req.apiToken = apiToken
  next()
})

router.get('/ping', (req, res) => {
  res.json({ status: 'ok', userId: req.apiToken.userId })
})

router.use((req, res) => {
  sendError(res, 404, 'Not found')
})

router.use((err, req, res, next) => {
  logger.error('Memory API request failed: ' + err.message)
  sendError(res, 500, 'Internal error')
})

module.exports = router
