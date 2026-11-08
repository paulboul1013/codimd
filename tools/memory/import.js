#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { createClient, projectScope } = require('./client')

const IMPORT_TYPES = ['user', 'feedback', 'project', 'reference']
const FALLBACK_TYPE = 'reference'
const TITLE_MAX = 120
const USAGE = 'Usage: node tools/memory/import.js [--dry-run [--offline]] [--root <dir>]'

function parseScalar (raw) {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (error) {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

// Enough YAML for Claude Code memory files: top-level scalars, plus one level of
// nesting for the `metadata:` block that newer files use.
function parseFrontmatter (text) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  let parent = null
  for (const line of match[1].split('\n')) {
    const entry = /^(\s*)([\w-]+):(.*)$/.exec(line)
    if (!entry) continue
    const [, indent, key, rest] = entry
    if (!indent && !rest.trim()) {
      parent = data[key] = {}
    } else if (!indent) {
      parent = null
      data[key] = parseScalar(rest)
    } else if (parent) {
      parent[key] = parseScalar(rest)
    }
  }
  return { data, body: text.slice(match[0].length) }
}

function parseMemoryFile (text, fallbackName) {
  const { data, body } = parseFrontmatter(text.replace(/\r\n/g, '\n'))
  const metadata = typeof data.metadata === 'object' ? data.metadata : {}
  const field = value => typeof value === 'string' ? value : ''
  return {
    name: field(data.name) || fallbackName,
    description: field(data.description),
    type: field(metadata.type) || field(data.type),
    body: body.trim()
  }
}

// Claude Code names each project directory after its path with every
// non-alphanumeric character replaced by '-'.
function encodePath (dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

function subdirectories (dir) {
  try {
    return fs.readdirSync(dir).filter(entry => {
      try {
        return fs.statSync(path.join(dir, entry)).isDirectory()
      } catch (error) {
        return false
      }
    })
  } catch (error) {
    return []
  }
}

// Walks the real file system to undo the lossy encoding. Returns the full path
// when one exists, otherwise the deepest existing directory on the way there.
function decodeProjectDir (encoded) {
  let deepest = { dir: path.sep, depth: 0 }
  function walk (dir, rest, depth) {
    if (!rest) return dir
    if (depth > deepest.depth) deepest = { dir, depth }
    for (const entry of subdirectories(dir)) {
      const key = encodePath(entry)
      if (rest === key || rest.startsWith(key + '-')) {
        const found = walk(path.join(dir, entry), rest.slice(key.length + 1), depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const full = walk(path.sep, encoded.replace(/^-/, ''), 0)
  return full ? { dir: full, complete: true } : { dir: deepest.dir, complete: false }
}

function scopeFromName (raw) {
  const name = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100)
  return name ? `project:${name}` : null
}

function containsHome (dir, home) {
  return home === dir || home.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

function projectScopeFor (encoded, home) {
  const { dir, complete } = decodeProjectDir(encoded)
  if (complete || !containsHome(dir, home)) {
    const scope = projectScope(dir)
    if (scope) return scope
  }
  if (complete) {
    const scope = scopeFromName(path.basename(dir))
    if (scope) return scope
  }
  const homeKey = encodePath(home)
  const tail = encoded.startsWith(homeKey + '-') ? encoded.slice(homeKey.length + 1) : encoded.split('-').filter(Boolean).pop()
  return scopeFromName(tail || '') || 'project:unknown'
}

function titleFor (memory) {
  const text = memory.description.replace(/\s+/g, ' ').trim()
  if (!text) return memory.name
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 3).trimEnd() + '...' : text
}

function markerFor (scope, name) {
  return `<!-- imported-from: ${scope}/${name} -->`
}

// Notes imported before the marker named the scope.
function legacyMarkerFor (name) {
  return `<!-- imported-from: ${name} -->`
}

function collectMemories (root, home) {
  const memories = []
  const projectDirs = fs.existsSync(root) ? fs.readdirSync(root).sort() : []
  for (const projectDir of projectDirs) {
    if (projectDir.startsWith('-tmp-')) continue
    const memoryDir = path.join(root, projectDir, 'memory')
    const files = subdirectories(path.join(root, projectDir)).includes('memory')
      ? fs.readdirSync(memoryDir).filter(file => file.endsWith('.md') && file !== 'MEMORY.md').sort()
      : []
    let projectScopeCache = null
    for (const file of files) {
      const memory = parseMemoryFile(fs.readFileSync(path.join(memoryDir, file), 'utf8'), path.basename(file, '.md'))
      const type = IMPORT_TYPES.includes(memory.type) ? memory.type : FALLBACK_TYPE
      if (type !== 'user' && !projectScopeCache) projectScopeCache = projectScopeFor(projectDir, home)
      const scope = type === 'user' ? 'global' : projectScopeCache
      memories.push({
        name: memory.name,
        scope,
        type,
        originalType: memory.type,
        title: titleFor(memory),
        body: `${memory.body}\n\n${markerFor(scope, memory.name)}`
      })
    }
  }
  return memories
}

// The search is a case-insensitive substring match, so confirm the exact marker.
async function hasNoteWith (client, marker, accept) {
  const query = new URLSearchParams({ q: marker, includeArchived: 'true' })
  const { notes } = await client.request('GET', `/notes?${query}`)
  for (const summary of notes) {
    const { note } = await client.request('GET', `/notes/${encodeURIComponent(summary.id)}`)
    if (note.content.includes(marker) && accept(note)) return true
  }
  return false
}

async function alreadyImported (client, memory) {
  return await hasNoteWith(client, markerFor(memory.scope, memory.name), () => true) ||
    hasNoteWith(client, legacyMarkerFor(memory.name), note => note.scope === memory.scope)
}

function parseArgs (argv) {
  const options = { dryRun: false, offline: false, root: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--root' && argv[i + 1]) options.root = argv[++i]
    else throw new Error(`Unknown argument ${arg}. ${USAGE}`)
  }
  if (options.offline && !options.dryRun) throw new Error(`--offline only works with --dry-run. ${USAGE}`)
  return options
}

async function run ({ argv = process.argv.slice(2), env = process.env, home = os.homedir(), log = console.log } = {}) {
  const options = parseArgs(argv)
  const root = options.root || path.join(home, '.claude', 'projects')
  const memories = collectMemories(root, home)
  const client = options.offline ? null : createClient({ env, home })
  const scopeWidth = Math.max(0, ...memories.map(memory => memory.scope.length)) + 2
  const typeWidth = Math.max(0, ...memories.map(memory => memory.type.length)) + 2
  let created = 0
  let skipped = 0

  if (options.dryRun) log(`Dry run: nothing is written.${options.offline ? ' Offline: existing notes are not checked.' : ''}`)
  for (const memory of memories) {
    const exists = client ? await alreadyImported(client, memory) : false
    if (exists) {
      skipped++
    } else {
      created++
      if (!options.dryRun) {
        await client.request('POST', '/notes', { title: memory.title, body: memory.body, scope: memory.scope, type: memory.type, tags: ['imported'] })
      }
    }
    const note = memory.type === memory.originalType ? '' : `  (type "${memory.originalType || 'missing'}" is not importable, using ${memory.type})`
    log(`${(exists ? 'skip' : 'create').padEnd(8)}${memory.scope.padEnd(scopeWidth)}${memory.type.padEnd(typeWidth)}${memory.name}${note}`)
  }
  log(options.dryRun ? `would create ${created}, would skip ${skipped}` : `created ${created}, skipped ${skipped}`)
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { parseMemoryFile, projectScopeFor, run }
