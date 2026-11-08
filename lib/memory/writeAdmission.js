'use strict'

const { sendError } = require('./apiError')

const MAX_QUEUED = 5

// Runs one write per token user at a time and queues a few more. A write
// waiting on a note lock delays every browser connecting to the server,
// because connects run one at a time; capping writes per user keeps that wait
// to about one write. The slot frees when the handler settles, not when the
// client disconnects, so aborted requests cannot run writes side by side.
function createWriteAdmission () {
  const waitingByUser = new Map()

  function startNext (userId) {
    const next = waitingByUser.get(userId).shift()
    if (next) return next.start()
    waitingByUser.delete(userId)
  }

  return function admit (handler) {
    return function admitWrite (req, res, next) {
      const userId = req.apiToken.userId
      const waiting = waitingByUser.get(userId)
      if (waiting && waiting.length >= MAX_QUEUED) {
        return sendError(res, 429, 'Too many concurrent writes')
      }
      const entry = {
        start () {
          res.removeListener('close', leaveQueue)
          Promise.resolve()
            .then(() => handler(req, res))
            .catch(next)
            .then(() => startNext(userId))
        }
      }
      function leaveQueue () {
        const queue = waitingByUser.get(userId)
        queue.splice(queue.indexOf(entry), 1)
      }
      if (!waiting) {
        waitingByUser.set(userId, [])
        return entry.start()
      }
      res.once('close', leaveQueue)
      waiting.push(entry)
    }
  }
}

exports.createWriteAdmission = createWriteAdmission
