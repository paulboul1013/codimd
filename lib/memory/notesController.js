'use strict'

const { Op } = require('sequelize')
const shortId = require('shortid')

const config = require('../config')
const models = require('../models')
const { ApiError, NOTE_TOO_LONG, sendError } = require('./apiError')
const memoryTags = require('./memoryTags')
const { currentContent, writeMemoryNote } = require('./writeMemoryNote')

const NOT_FOUND = 'Not found'

function sendNotFound (res) {
  sendError(res, 404, NOT_FOUND)
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

function noteDetail (note, content = note.content) {
  const summary = summarize(note, memoryTags.parseMemory(content))
  return Object.assign(summary, {
    content,
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
  if (!note) return null
  const content = currentContent(note)
  if (!memoryTags.parseMemory(content).isMemory) return null
  return { note, content }
}

// `edit` maps the current text to the next one. The checks run again on the
// text the write lock hands over, because another write may have changed it
// since findMemoryNote looked.
async function saveEdit (req, res, found, edit) {
  const saved = await writeMemoryNote(found.note, req.apiToken.userId, current => {
    if (!memoryTags.parseMemory(current).isMemory) throw new ApiError(404, NOT_FOUND)
    const next = edit(current)
    if (next === current) return current
    if (tooLong(next)) throw new ApiError(400, NOTE_TOO_LONG)
    if (!memoryTags.parseMemory(next).isMemory) throw new ApiError(400, 'Content must keep the memory tag')
    return next
  })
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
  const found = await findMemoryNote(req)
  if (!found) return sendNotFound(res)
  res.json({ status: 'ok', note: noteDetail(found.note, found.content) })
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
  if (tooLong(content)) return sendError(res, 400, NOTE_TOO_LONG)

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
  const found = await findMemoryNote(req)
  if (!found) return sendNotFound(res)
  const content = req.body && req.body.content
  if (typeof content !== 'string' || !content) return sendError(res, 400, 'Content is required')
  await saveEdit(req, res, found, () => normalizeText(content))
}

async function appendNote (req, res) {
  const found = await findMemoryNote(req)
  if (!found) return sendNotFound(res)
  const text = req.body && req.body.text
  if (typeof text !== 'string' || !text) return sendError(res, 400, 'Text is required')
  await saveEdit(req, res, found, current => current + '\n\n' + normalizeText(text))
}

async function archiveNote (req, res) {
  const found = await findMemoryNote(req)
  if (!found) return sendNotFound(res)
  await saveEdit(req, res, found, memoryTags.archiveContent)
}

exports.listNotes = listNotes
exports.readNote = readNote
exports.createNote = createNote
exports.updateNote = updateNote
exports.appendNote = appendNote
exports.archiveNote = archiveNote
