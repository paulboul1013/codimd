'use strict'

const NOTE_TOO_LONG = 'Note is too long'

// A refusal the router answers with this status and message.
class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

function sendError (res, status, message) {
  res.status(status).json({ status: 'error', message })
}

exports.ApiError = ApiError
exports.NOTE_TOO_LONG = NOTE_TOO_LONG
exports.sendError = sendError
