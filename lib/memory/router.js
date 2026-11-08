'use strict'

const bodyParser = require('body-parser')
const { Router } = require('express')

const config = require('../config')
const logger = require('../logger')
const { wrap } = require('../utils')
const { NOTE_TOO_LONG, sendError } = require('./apiError')
const { authenticate } = require('./apiToken')
const notes = require('./notesController')

const router = Router()

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

// Six bytes per character covers JSON escapes such as \uXXXX, so the document length check decides.
router.use(bodyParser.json({ limit: config.documentMaxLength * 6 }))

router.get('/ping', (req, res) => {
  res.json({ status: 'ok', userId: req.apiToken.userId })
})

router.get('/notes', wrap(notes.listNotes))
router.post('/notes', wrap(notes.createNote))
router.get('/notes/:id', wrap(notes.readNote))
router.put('/notes/:id', wrap(notes.updateNote))
router.post('/notes/:id/append', wrap(notes.appendNote))
router.post('/notes/:id/archive', wrap(notes.archiveNote))

router.use((req, res) => {
  sendError(res, 404, 'Not found')
})

router.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'Malformed JSON body')
  if (err.type === 'entity.too.large') return sendError(res, 400, NOTE_TOO_LONG)
  logger.error('Memory API request failed: ' + err.message)
  sendError(res, 500, 'Internal error')
})

module.exports = router
