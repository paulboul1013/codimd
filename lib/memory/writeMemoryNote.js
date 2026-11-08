'use strict'

const models = require('../models')
const realtime = require('../realtime/realtime')
const WrappedOperation = require('../ot/wrapped-operation')
const { ApiError, NOTE_TOO_LONG } = require('./apiError')
const diffOperation = require('./diffOperation')

// Browsers treat this as one more collaborator without a cursor.
const MEMORY_API_CLIENT_ID = 'memory-api'

// The editor's unsaved document when the note is open, so a reply shows what
// collaborators see rather than the last save.
function currentContent (note) {
  const live = realtime.getNoteFromNotePool(note.id)
  return live ? live.server.document : note.content
}

function applyLiveOperation (live, before, content, userId) {
  const server = live.server
  const operation = diffOperation(before, content)
  if (operation.isNoop()) return
  const applied = server.receiveOperation(server.operations.length, new WrappedOperation(operation, null))
  if (!applied) throw new ApiError(400, NOTE_TOO_LONG)
  realtime.io.to(live.id).emit('operation', MEMORY_API_CLIENT_ID, server.operations.length, applied.wrapped.toJSON(), null)
  server.isDirty = true
  live.lastchangeuser = userId
  live.tempUsers[userId] = Date.now()
  live.authorship = models.Note.updateAuthorshipByOperation(applied.wrapped.toJSON(), userId, live.authorship)
}

// The single write path for memory notes. `change` maps the note's current text
// to the next one; it runs under the note lock, so it always sees the previous
// write, and it may throw an ApiError to refuse. Returning the same text writes
// nothing. An open note changes through the collaboration server, and the
// dirty-note job saves it and its revision; a closed note is written to the
// database here. The revision is saved after the lock is released, because
// browsers connecting to any note wait while a connect waits on this lock.
async function writeMemoryNote (note, userId, change) {
  const { saved, revise } = await realtime.withNoteLock(note.id, () => writeWhileLocked(note, userId, change))
  if (revise) await models.Revision.saveNoteRevisionAsync(saved)
  return saved
}

async function writeWhileLocked (note, userId, change) {
  const { Note } = models
  const now = Date.now()
  const live = realtime.getNoteFromNotePool(note.id)
  if (live) {
    // No await from reading the document to applying the operation, so the
    // operation applies at the revision it was computed against.
    const before = live.server.document
    applyLiveOperation(live, before, change(before), userId)
    const saved = {
      id: note.id,
      title: Note.parseNoteTitle(live.server.document),
      content: live.server.document,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      lastchangeAt: now
    }
    return { saved, revise: false }
  }

  const fresh = await Note.findOne({ where: { id: note.id } })
  if (!fresh) throw new ApiError(404, 'Not found')
  const content = change(fresh.content)
  if (content === fresh.content) return { saved: fresh, revise: false }
  const saved = await fresh.update({
    title: Note.parseNoteTitle(content),
    content,
    lastchangeAt: now,
    lastchangeuserId: userId,
    authorship: [[userId, 0, content.length, now, now]]
  })
  return { saved, revise: true }
}

exports.currentContent = currentContent
exports.writeMemoryNote = writeMemoryNote
