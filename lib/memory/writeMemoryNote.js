'use strict'

const models = require('../models')
const realtime = require('../realtime/realtime')

class NoteOpenError extends Error {
  constructor () {
    super('Note is open in the editor')
    this.name = 'NoteOpenError'
  }
}

// The single write path for memory notes, so a live-editor write can replace the NoteOpenError branch.
async function writeMemoryNote (note, content, userId) {
  if (realtime.isNoteExistsInPool(note.id)) throw new NoteOpenError()
  const { Note, Revision } = models
  const now = Date.now()
  const updated = await note.update({
    title: Note.parseNoteTitle(content),
    content,
    lastchangeAt: now,
    lastchangeuserId: userId,
    authorship: [[userId, 0, content.length, now, now]]
  })
  await Revision.saveNoteRevisionAsync(updated)
  return updated
}

exports.NoteOpenError = NoteOpenError
exports.writeMemoryNote = writeMemoryNote
