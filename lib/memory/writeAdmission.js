'use strict'

const { sendError } = require('./apiError')

const MAX_QUEUED = 5

// Express middleware that runs one write per token user at a time and queues
// a few more. A write waiting on a note lock delays every browser connecting
// to the server, because connects run one at a time; capping writes per user
// keeps that wait to about one write.
function createWriteAdmission () {
  const waitingByUser = new Map()

  function startNext (userId) {
    const waiting = waitingByUser.get(userId)
    const next = waiting.shift()
    if (next) return next.start()
    waitingByUser.delete(userId)
  }

  return function admitWrite (req, res, next) {
    const userId = req.apiToken.userId
    const waiting = waitingByUser.get(userId)
    if (waiting && waiting.length >= MAX_QUEUED) {
      return sendError(res, 429, 'Too many concurrent writes')
    }
    const entry = {
      started: false,
      start () {
        entry.started = true
        next()
      }
    }
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      if (entry.started) return startNext(userId)
      const queue = waitingByUser.get(userId)
      queue.splice(queue.indexOf(entry), 1)
    }
    res.once('finish', settle)
    res.once('close', settle)
    if (waiting) return waiting.push(entry)
    waitingByUser.set(userId, [])
    entry.start()
  }
}

exports.createWriteAdmission = createWriteAdmission
