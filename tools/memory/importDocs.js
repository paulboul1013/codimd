'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const SKIPPED_DIRS = new Set(['node_modules'])
const MAX_FILES = 200
const TITLE_MAX = 120

function git (cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    return ''
  }
}

function scopeFromName (raw) {
  const name = (raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100)
  return name ? `project:${name}` : null
}

// A document does not have to live in a git repo or on GitHub. The scope comes
// from the origin remote's repo name, else the git top-level directory, else the
// directory itself.
function scopeForDir (dir) {
  const remote = git(dir, ['remote', 'get-url', 'origin'])
  if (remote) {
    const scope = scopeFromName(remote.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop())
    if (scope) return scope
  }
  const toplevel = git(dir, ['rev-parse', '--show-toplevel'])
  return scopeFromName(path.basename(toplevel || dir)) || 'project:unknown'
}

function isDocFile (file) {
  return DOC_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function walk (dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile() && isDocFile(entry.name)) files.push(full)
  }
}

// Expands each path into document files. A directory contributes every .md,
// .markdown, and .txt file under it, skipping dot directories and node_modules.
// Each file keeps the scope of the path argument it came from.
function collectDocuments (paths, { cwd = process.cwd(), scope = null } = {}) {
  const documents = []
  const seen = new Set()
  for (const raw of paths) {
    const target = path.resolve(cwd, raw)
    let stat
    try {
      stat = fs.statSync(target)
    } catch (error) {
      throw new Error(`${raw}: no such file or directory.`)
    }
    const files = []
    if (stat.isDirectory()) walk(target, files)
    else if (stat.isFile()) files.push(target)
    else throw new Error(`${raw}: not a file or directory.`)
    const fileScope = scope || scopeForDir(stat.isDirectory() ? target : path.dirname(target))
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      documents.push({ file, scope: fileScope })
    }
  }
  if (documents.length > MAX_FILES) throw new Error(`${documents.length} files found; import at most ${MAX_FILES} at a time.`)
  return documents
}

function markerFor (file) {
  return `<!-- imported-from: file:${file} -->`
}

function truncate (text) {
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 3).trimEnd() + '...' : text
}

// The note's title comes from `title`, else the document's first-line `# `
// heading, which is then dropped from the body because CodiMD writes the title
// as the note's own heading, else the file name.
function readDocument (file, title) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '')
  const heading = /^# +(.+?)\s*#*\s*\n/.exec(text + '\n')
  if (!title && heading) {
    title = heading[1]
    text = text.slice(heading[0].length)
  }
  title = truncate((title || path.basename(file, path.extname(file))).replace(/\s+/g, ' ').trim())
  return { title, body: `${text.trim()}\n\n${markerFor(file)}` }
}

// The search is a case-insensitive substring match, so confirm the exact marker.
async function findImported (client, file) {
  const marker = markerFor(file)
  const { notes } = await client.request('GET', `/notes?${new URLSearchParams({ q: marker })}`)
  for (const summary of notes) {
    const { note } = await client.request('GET', `/notes/${encodeURIComponent(summary.id)}`)
    if (note.content.includes(marker)) return note
  }
  return null
}

// Keeps the existing front matter, so the scope, type, and tags stay as they are.
function replacedContent (current, title, body) {
  const end = current.startsWith('---') && /\n(\.{3}|-{3})\n/.exec(current)
  if (!end) throw new Error('the existing note has no front matter to keep')
  return `${current.slice(0, end.index + end[0].length)}# ${title}\n\n${body}\n`
}

// Writes one note at a time: the memory API admits only a few queued writes.
// One failed file does not stop the others.
async function importDocuments (client, documents, { type = 'doc', tags = [], title = null, update = false, dryRun = false } = {}) {
  const results = []
  for (const { file, scope } of documents) {
    const result = { file, scope }
    try {
      const doc = readDocument(file, title)
      result.title = doc.title
      const existing = await findImported(client, file)
      if (existing && !update) {
        Object.assign(result, { action: 'skip', id: existing.id })
      } else if (existing) {
        result.action = 'update'
        result.id = existing.id
        if (!dryRun) {
          const { note } = await client.request('PUT', `/notes/${encodeURIComponent(existing.id)}`, { content: replacedContent(existing.content, doc.title, doc.body) })
          result.url = note.url
        }
      } else {
        result.action = 'create'
        if (!dryRun) {
          const { note } = await client.request('POST', '/notes', { title: doc.title, body: doc.body, scope, type, tags: [...new Set(['imported', ...tags])] })
          Object.assign(result, { id: note.id, url: note.url })
        }
      }
    } catch (error) {
      Object.assign(result, { action: 'error', error: error.message })
    }
    results.push(result)
  }
  return results
}

function summarize (results, dryRun) {
  const count = action => results.filter(result => result.action === action).length
  const verbs = dryRun ? ['would create', 'would update', 'would skip'] : ['created', 'updated', 'skipped']
  const lines = results.map(result => {
    const detail = result.action === 'error'
      ? result.error
      : [result.title && `"${result.title}"`, result.id && `(${result.id})`, result.url].filter(Boolean).join(' ')
    return `${result.action.padEnd(7)}${result.scope}  ${result.file}  ${detail}`
  })
  lines.push(`${verbs[0]} ${count('create')}, ${verbs[1]} ${count('update')}, ${verbs[2]} ${count('skip')}, failed ${count('error')}`)
  return lines.join('\n')
}

module.exports = { collectDocuments, importDocuments, readDocument, scopeForDir, summarize, markerFor, MAX_FILES }
