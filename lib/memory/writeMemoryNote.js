'use strict'

const models = require('../models')
const realtime = require('../realtime/realtime')
const WrappedOperation = require('../ot/wrapped-operation')
const diffOperation = require('./diffOperation')

// Browsers treat this as one more collaborator without a cursor.
const MEMORY_API_CLIENT_ID = 'memory-api'

// The text a write must start from: the editor's unsaved document when the note
// is open, so a write never reverts what collaborators typed since the last save.
// The revision lets the write transform over operations that land before it applies.
function readBase (note) {
  const live = realtime.getNoteFromNotePool(note.id)
  if (!live) return { content: note.content, revision: null }
  return { content: live.server.document, revision: live.server.operations.length }
}

function applyLiveOperation (live, base, content, userId) {
  const server = live.server
  if (base.revision === null) base = { content: server.document, revision: server.operations.length }
  const operation = diffOperation(base.content, content)
  if (operation.isNoop()) return
  const applied = server.receiveOperation(base.revision, new WrappedOperation(operation, null))
  if (!applied) throw new Error('Note is too long')
  realtime.io.to(live.id).emit('operation', MEMORY_API_CLIENT_ID, server.operations.length, applied.wrapped.toJSON(), null)
  server.isDirty = true
  live.lastchangeuser = userId
  live.tempUsers[userId] = Date.now()
  live.authorship = models.Note.updateAuthorshipByOperation(applied.wrapped.toJSON(), userId, live.authorship)
}

// The single write path for memory notes. An open note changes through the
// collaboration server and the dirty-note job saves it and its revision; a closed
// note is written to the database with a revision here.
async function writeMemoryNote (note, base, content, userId) {
  const { Note, Revision } = models
  const now = Date.now()
  const live = realtime.getNoteFromNotePool(note.id)
  if (live) {
    applyLiveOperation(live, base, content, userId)
    return {
      id: note.id,
      title: Note.parseNoteTitle(live.server.document),
      content: live.server.document,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      lastchangeAt: now
    }
  }

  const updated = await note.update({
    title: Note.parseNoteTitle(content),
    content,
    lastchangeAt: now,
    lastchangeuserId: userId,
    authorship: [[userId, 0, content.length, now, now]]
  })
  // A browser that opened the note during the update may have loaded the old row.
  // Bring it forward only while nobody has typed, otherwise their edits win.
  const opened = realtime.getNoteFromNotePool(note.id)
  if (opened && opened.server.document === base.content) applyLiveOperation(opened, base, content, userId)
  await Revision.saveNoteRevisionAsync(updated)
  return updated
}

exports.readBase = readBase
exports.writeMemoryNote = writeMemoryNote
