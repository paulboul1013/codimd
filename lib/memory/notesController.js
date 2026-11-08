'use strict'

const { Op } = require('sequelize')
const shortId = require('shortid')

const config = require('../config')
const models = require('../models')
const memoryTags = require('./memoryTags')
const { writeMemoryNote, NoteOpenError } = require('./writeMemoryNote')

function sendError (res, status, message) {
  res.status(status).json({ status: 'error', message })
}

function sendNotFound (res) {
  sendError(res, 404, 'Not found')
}

function normalizeText (text) {
  return text.replace(/\r/g, '')
}

function tooLong (content) {
  return content.length > config.documentMaxLength
}

function summarize (note, memory) {
  return {
    id: models.Note.encodeNoteId(note.id),
    title: note.title,
    scope: memory.scope,
    type: memory.type,
    tags: memory.tags,
    archived: memory.archived,
    updatedAt: note.lastchangeAt || note.updatedAt
  }
}

function noteDetail (note) {
  const summary = summarize(note, memoryTags.parseMemory(note.content))
  return Object.assign(summary, {
    content: note.content,
    createdAt: note.createdAt,
    url: config.serverURL + '/' + summary.id
  })
}

// Accepts the encoded note id the API returns, or a note shortid; never an alias,
// because alias lookup can create notes from the docs folder.
function noteIdCondition (rawId) {
  const { Note } = models
  try {
    const id = Note.decodeNoteId(rawId)
    if (Note.checkNoteIdValid(id)) return { id }
  } catch (err) {}
  if (shortId.isValid(rawId)) return { shortid: rawId }
  return null
}

// Other users' notes, plain notes, and missing notes all look the same to the caller.
async function findMemoryNote (req) {
  const condition = noteIdCondition(req.params.id)
  if (!condition) return null
  const note = await models.Note.findOne({ where: Object.assign({ ownerId: req.apiToken.userId }, condition) })
  if (!note || !memoryTags.parseMemory(note.content).isMemory) return null
  return note
}

async function saveContent (req, res, note, content) {
  if (tooLong(content)) return sendError(res, 400, 'Note is too long')
  if (!memoryTags.parseMemory(content).isMemory) return sendError(res, 400, 'Content must keep the memory tag')
  let saved
  try {
    saved = await writeMemoryNote(note, content, req.apiToken.userId)
  } catch (err) {
    if (err instanceof NoteOpenError) return sendError(res, 409, err.message)
    throw err
  }
  res.json({ status: 'ok', note: noteDetail(saved) })
}

async function listNotes (req, res) {
  const { scope, type, q } = req.query
  if (scope !== undefined && !memoryTags.isValidScope(scope)) return sendError(res, 400, 'Invalid scope')
  if (type !== undefined && !memoryTags.isValidType(type)) return sendError(res, 400, 'Invalid type')
  if (q !== undefined && typeof q !== 'string') return sendError(res, 400, 'Invalid query')
  const includeArchived = req.query.includeArchived === 'true'
  const needle = q ? q.toLowerCase() : ''

  const candidates = await models.Note.findAll({
    where: { ownerId: req.apiToken.userId, content: { [Op.like]: '%memory%' } }
  })
  const notes = candidates
    .map(note => ({ note, memory: memoryTags.parseMemory(note.content) }))
    .filter(({ note, memory }) => memory.isMemory &&
      (includeArchived || !memory.archived) &&
      (scope === undefined || memory.scope === scope) &&
      (type === undefined || memory.type === type) &&
      (!needle || note.content.toLowerCase().includes(needle)))
    .map(({ note, memory }) => summarize(note, memory))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json({ status: 'ok', notes })
}

async function readNote (req, res) {
  const note = await findMemoryNote(req)
  if (!note) return sendNotFound(res)
  res.json({ status: 'ok', note: noteDetail(note) })
}

function createInputError ({ title, body, scope, type, tags }) {
  if (typeof title !== 'string' || !title.trim()) return 'Title is required'
  if (/[\r\n]/.test(title)) return 'Title must be a single line'
  if (body !== undefined && typeof body !== 'string') return 'Body must be a string'
  if (!memoryTags.isValidScope(scope)) return 'Invalid scope: use global or project:<name>'
  if (!memoryTags.isValidType(type)) return 'Invalid type: use one of ' + memoryTags.MEMORY_TYPES.join(', ')
  if (tags !== undefined && !Array.isArray(tags)) return 'Tags must be an array'
  for (const tag of tags || []) {
    const error = memoryTags.extraTagError(tag)
    if (error) return error
  }
  return null
}

async function createNote (req, res) {
  const input = req.body || {}
  const error = createInputError(input)
  if (error) return sendError(res, 400, error)
  const content = memoryTags.buildMemoryContent({
    title: input.title.trim(),
    body: normalizeText(input.body || ''),
    scope: input.scope,
    type: input.type,
    tags: input.tags
  })
  if (tooLong(content)) return sendError(res, 400, 'Note is too long')

  const { Note, Revision } = models
  const userId = req.apiToken.userId
  const now = Date.now()
  const note = await Note.create({
    ownerId: userId,
    permission: 'private',
    title: Note.parseNoteTitle(content),
    content,
    lastchangeAt: now,
    lastchangeuserId: userId,
    authorship: [[userId, 0, content.length, now, now]]
  })
  await Revision.saveNoteRevisionAsync(note)
  res.status(201).json({ status: 'ok', note: noteDetail(note) })
}

async function updateNote (req, res) {
  const note = await findMemoryNote(req)
  if (!note) return sendNotFound(res)
  const content = req.body && req.body.content
  if (typeof content !== 'string' || !content) return sendError(res, 400, 'Content is required')
  await saveContent(req, res, note, normalizeText(content))
}

async function appendNote (req, res) {
  const note = await findMemoryNote(req)
  if (!note) return sendNotFound(res)
  const text = req.body && req.body.text
  if (typeof text !== 'string' || !text) return sendError(res, 400, 'Text is required')
  await saveContent(req, res, note, note.content + '\n\n' + normalizeText(text))
}

async function archiveNote (req, res) {
  const note = await findMemoryNote(req)
  if (!note) return sendNotFound(res)
  const content = memoryTags.archiveContent(note.content)
  if (content === note.content) return res.json({ status: 'ok', note: noteDetail(note) })
  await saveContent(req, res, note, content)
}

exports.listNotes = listNotes
exports.readNote = readNote
exports.createNote = createNote
exports.updateNote = updateNote
exports.appendNote = appendNote
exports.archiveNote = archiveNote
