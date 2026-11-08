'use strict'

const { collectDocuments, importDocuments, summarize, MAX_FILES } = require('./importDocs')

const TYPES = ['user', 'feedback', 'project', 'reference', 'doc', 'handoff']
const SCOPE = {
  type: 'string',
  pattern: '^(global|[pP][rR][oO][jJ][eE][cC][tT]:[a-zA-Z0-9][a-zA-Z0-9._-]{0,99})$',
  description: "'global' for memory that applies everywhere, or 'project:<repo name>' for one project."
}
const TYPE = { type: 'string', enum: TYPES, description: 'What the memory is for.' }
const ID = { type: 'string', description: 'Memory note id, as returned by memory_index or memory_search.' }
const READ_ONLY = ' Read-only and safe to call without asking.'
const NEEDS_APPROVAL = ' Writes to the user\'s second brain; each call requires the user\'s approval.'

function schema (properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function line (note) {
  return `- [${note.type}] ${note.title} (${note.id})`
}

function searchLine (note) {
  const extras = [note.scope]
  if (note.tags && note.tags.length) extras.push(`tags: ${note.tags.join(', ')}`)
  if (note.archived) extras.push('archived')
  return `${line(note)} ${extras.join(', ')}`
}

function written (verb, note) {
  return `${verb} memory note "${note.title}" (${note.id}) ${note.url}`
}

function encode (id) {
  return encodeURIComponent(id)
}

function listQuery (filters) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== false) query.set(key, String(value))
  }
  const text = query.toString()
  return '/notes' + (text ? '?' + text : '')
}

function projectFrom (project, defaultScope) {
  if (!project) return defaultScope
  return project.startsWith('project:') ? project : `project:${project}`
}

const TOOLS = [
  {
    name: 'memory_index',
    description: 'List the titles of the global memory notes and the current project\'s memory notes. Call it at the start of a task to see what the user\'s second brain already knows, then memory_read the notes that matter.' + READ_ONLY,
    inputSchema: schema({ project: { type: 'string', description: 'Project name or \'project:<name>\'. Defaults to the git repo of the working directory.' } }),
    async run (client, args, defaultScope) {
      const scopes = ['global']
      const project = projectFrom(args.project, defaultScope)
      if (project) scopes.push(project)
      const sections = []
      for (const scope of scopes) {
        const { notes } = await client.request('GET', listQuery({ scope }))
        sections.push(`## ${scope}\n` + (notes.length ? notes.map(line).join('\n') : '(none)'))
      }
      if (!project) sections.push('(No project detected: the working directory is not a git repository.)')
      return sections.join('\n\n')
    }
  },
  {
    name: 'memory_search',
    description: 'Search memory notes by text, scope, or type. Use it before creating a memory to find one to update instead, or to recall something not in the index.' + READ_ONLY,
    inputSchema: schema({
      q: { type: 'string', description: 'Text to look for in titles and content.' },
      scope: SCOPE,
      type: TYPE,
      includeArchived: { type: 'boolean', description: 'Also return archived notes.' }
    }),
    async run (client, args) {
      const { notes } = await client.request('GET', listQuery({ q: args.q, scope: args.scope, type: args.type, includeArchived: args.includeArchived }))
      return notes.length ? notes.map(searchLine).join('\n') : 'No memory notes match.'
    }
  },
  {
    name: 'memory_read',
    description: 'Read one memory note in full.' + READ_ONLY,
    inputSchema: schema({ id: ID }, ['id']),
    async run (client, args) {
      const { note } = await client.request('GET', `/notes/${encode(args.id)}`)
      const meta = [`id: ${note.id}`, `scope: ${note.scope}`, `type: ${note.type}`, `tags: ${(note.tags || []).join(', ')}`, `updated: ${note.updatedAt}`, `url: ${note.url}`]
      if (note.archived) meta.push('archived: true')
      return `${meta.join('\n')}\n---\n${note.content}`
    }
  },
  {
    name: 'memory_create',
    description: 'Create a memory note when the user asks you to remember something, or when you learn a durable fact worth keeping across sessions. Search first so you do not create a duplicate.' + NEEDS_APPROVAL,
    inputSchema: schema({
      title: { type: 'string', description: 'Short title that says what the memory is about.' },
      body: { type: 'string', description: 'Markdown content of the memory.' },
      scope: SCOPE,
      type: TYPE,
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags.' }
    }, ['title', 'body', 'scope', 'type']),
    async run (client, args) {
      const { note } = await client.request('POST', '/notes', { title: args.title, body: args.body, scope: args.scope, type: args.type, tags: args.tags })
      return written('Created', note)
    }
  },
  {
    name: 'memory_import_files',
    description: 'Copy local document files into memory notes, one note per file. The server reads the files itself, so pass paths instead of pasting file content into memory_create. Use it to import or re-sync documents, including files that are not in a git repo. One call imports many files with one approval.' + NEEDS_APPROVAL,
    inputSchema: schema({
      paths: { type: 'array', items: { type: 'string' }, description: `Files or directories, absolute or relative to the working directory. A directory adds every .md, .markdown, and .txt file under it. At most ${MAX_FILES} files per call.` },
      scope: Object.assign({}, SCOPE, { description: SCOPE.description + ' Defaults to the git repo of each path, or its directory name outside a repo.' }),
      type: Object.assign({}, TYPE, { description: 'What the notes are for. Defaults to doc.' }),
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags. Every imported note also gets the tag imported.' },
      title: { type: 'string', description: 'Note title, only when importing one file. Defaults to the file\'s first # heading, else its file name.' },
      update: { type: 'boolean', description: 'Replace the content of notes already imported from the same file. Without it those files are skipped.' },
      dryRun: { type: 'boolean', description: 'List what would happen without writing anything.' }
    }, ['paths']),
    async run (client, args) {
      if (!args.paths.length) throw new Error('paths must name at least one file or directory.')
      const documents = collectDocuments(args.paths, { scope: args.scope })
      if (!documents.length) throw new Error('No .md, .markdown, or .txt files found.')
      if (args.title && documents.length > 1) throw new Error('title only works when importing one file.')
      const results = await importDocuments(client, documents, { type: args.type, tags: args.tags, title: args.title, update: args.update, dryRun: args.dryRun })
      return (args.dryRun ? 'Dry run: nothing was written.\n' : '') + summarize(results, args.dryRun)
    }
  },
  {
    name: 'memory_update',
    description: 'Replace the whole content of a memory note. memory_read it first and keep its front matter and tags.' + NEEDS_APPROVAL,
    inputSchema: schema({ id: ID, content: { type: 'string', description: 'The complete new note content.' } }, ['id', 'content']),
    async run (client, args) {
      const { note } = await client.request('PUT', `/notes/${encode(args.id)}`, { content: args.content })
      return written('Updated', note)
    }
  },
  {
    name: 'memory_append',
    description: 'Append text to the end of a memory note. Prefer it over memory_update when adding to a note.' + NEEDS_APPROVAL,
    inputSchema: schema({ id: ID, text: { type: 'string', description: 'Markdown to append.' } }, ['id', 'text']),
    async run (client, args) {
      const { note } = await client.request('POST', `/notes/${encode(args.id)}/append`, { text: args.text })
      return written('Appended to', note)
    }
  },
  {
    name: 'memory_archive',
    description: 'Archive a memory note that is wrong or no longer useful. It disappears from the index and search but can be restored. Use it whenever you would delete a memory.' + NEEDS_APPROVAL,
    inputSchema: schema({ id: ID }, ['id']),
    async run (client, args) {
      const { note } = await client.request('POST', `/notes/${encode(args.id)}/archive`)
      return written('Archived', note)
    }
  }
]

function invalidArguments (tool, args) {
  const { properties, required } = tool.inputSchema
  for (const key of required) {
    if (args[key] === undefined || args[key] === '') return `${key} is required.`
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key]
    if (!rule) return `Unknown argument ${key}.`
    const actual = Array.isArray(value) ? 'array' : typeof value
    if (actual !== rule.type) return `${key} must be a ${rule.type}.`
    if (rule.enum && !rule.enum.includes(value)) return `${key} must be one of ${rule.enum.join(', ')}.`
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `${key} must match ${rule.pattern}.`
    if (rule.items && value.some(item => typeof item !== 'string')) return `${key} must contain only strings.`
  }
  return null
}

module.exports = { TYPES, TOOLS, invalidArguments }
