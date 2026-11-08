'use strict'

const models = require('../models')

const MEMORY_TAG = 'memory'
const ARCHIVED_TAG = 'archived'
const GLOBAL_SCOPE = 'global'
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'doc', 'handoff']
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]{0,99}$/i
const MAX_EXTRA_TAG_LENGTH = 100
// A tag that YAML reads back as the same string inside `tags: a, b, c`.
const PLAIN_TAG = /^[^\s,:#'"`[\]{}&*!|>%@?\\-][^\s,#'"`[\]{}\\]*$/u

function isValidScope (scope) {
  return scope === GLOBAL_SCOPE || (typeof scope === 'string' && PROJECT_SCOPE.test(scope))
}

function isValidType (type) {
  return MEMORY_TYPES.includes(type)
}

function isReservedTag (tag) {
  return tag === MEMORY_TAG || tag === ARCHIVED_TAG || isValidScope(tag) || isValidType(tag)
}

function extraTagError (tag) {
  if (typeof tag !== 'string' || !tag) return 'Tags must be non-empty strings'
  if (tag.length > MAX_EXTRA_TAG_LENGTH) return `Tags must be at most ${MAX_EXTRA_TAG_LENGTH} characters`
  if (!PLAIN_TAG.test(tag) || tag.endsWith(':')) return `Tag "${tag}" contains spaces, commas, or YAML special characters`
  if (isReservedTag(tag)) return `Tag "${tag}" is reserved; use scope, type, or archive instead`
  return null
}

function noteTags (content) {
  const { Note } = models
  return Note.parseNoteInfo(content).tags
}

function parseMemory (content) {
  const tags = noteTags(content)
  return {
    isMemory: tags.includes(MEMORY_TAG),
    scope: tags.find(isValidScope) || null,
    type: tags.find(isValidType) || null,
    archived: tags.includes(ARCHIVED_TAG),
    tags
  }
}

function formatTagsLine (tags) {
  if (tags.every(tag => PLAIN_TAG.test(tag) && !tag.endsWith(':'))) return 'tags: ' + tags.join(', ')
  return 'tags: [' + tags.map(tag => JSON.stringify(tag)).join(', ') + ']'
}

function assertTags (content, expected) {
  const actual = noteTags(content)
  if (actual.length !== expected.length || actual.some((tag, i) => tag !== expected[i])) {
    throw new Error('Memory tags did not survive the frontmatter rewrite')
  }
  return content
}

// Expects inputs already checked with isValidScope, isValidType, and extraTagError.
function buildMemoryContent ({ title, body, scope, type, tags = [] }) {
  const allTags = [...new Set([MEMORY_TAG, scope, type, ...tags])]
  const content = `---\n${formatTagsLine(allTags)}\n---\n# ${title}\n\n${body ? body + '\n' : ''}`
  return assertTags(content, allTags)
}

// Mirrors how @hackmd/meta-marked finds the end of the frontmatter block.
function splitFrontmatter (content) {
  if (content.slice(0, 3) !== '---') return null
  const end = /\n(\.{3}|-{3})/g.exec(content)
  if (!end) return null
  return { head: content.slice(0, end.index), rest: content.slice(end.index) }
}

function replaceTagsInHead (head, tagsLine) {
  const lines = head.split('\n')
  const start = lines.findIndex((line, i) => i > 0 && /^tags\s*:/.test(line))
  if (start === -1) {
    lines.push(tagsLine)
  } else {
    let end = start + 1
    while (end < lines.length && /^(\s|-(\s|$))/.test(lines[end])) end++
    lines.splice(start, end - start, tagsLine)
  }
  return lines.join('\n')
}

function archiveContent (content) {
  const tags = noteTags(content)
  if (tags.includes(ARCHIVED_TAG)) return content
  const newTags = [...tags, ARCHIVED_TAG]
  const tagsLine = formatTagsLine(newTags)
  const parts = splitFrontmatter(content)
  const archived = parts
    ? replaceTagsInHead(parts.head, tagsLine) + parts.rest
    : `---\n${tagsLine}\n---\n${content}`
  return assertTags(archived, newTags)
}

exports.MEMORY_TYPES = MEMORY_TYPES
exports.isValidScope = isValidScope
exports.isValidType = isValidType
exports.extraTagError = extraTagError
exports.parseMemory = parseMemory
exports.buildMemoryContent = buildMemoryContent
exports.archiveContent = archiveContent
