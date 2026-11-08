'use strict'

const NOTE_TOO_LONG = 'Note is too long'

function sendError (res, status, message) {
  res.status(status).json({ status: 'error', message })
}

exports.NOTE_TOO_LONG = NOTE_TOO_LONG
exports.sendError = sendError
