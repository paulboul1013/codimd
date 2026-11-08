#!/usr/bin/env node
'use strict'

const os = require('os')

const { createClient } = require('./client')
const { TYPES } = require('./tools')
const { collectDocuments, importDocuments, summarize } = require('./importDocs')

const USAGE = 'Usage: node tools/memory/import-docs.js [--scope <scope>] [--type <type>] [--tag <tag>]... [--title <title>] [--update] [--dry-run] <file-or-directory>...'

function parseArgs (argv) {
  const options = { paths: [], scope: null, type: 'doc', tags: [], title: null, update: false, dryRun: false }
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value. ${USAGE}`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scope') options.scope = value(i++, arg)
    else if (arg === '--type') options.type = value(i++, arg)
    else if (arg === '--tag') options.tags.push(value(i++, arg))
    else if (arg === '--title') options.title = value(i++, arg)
    else if (arg === '--update') options.update = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '-h' || arg === '--help') throw new Error(USAGE)
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. ${USAGE}`)
    else options.paths.push(arg)
  }
  if (!options.paths.length) throw new Error(`Name at least one file or directory. ${USAGE}`)
  if (!TYPES.includes(options.type)) throw new Error(`--type must be one of ${TYPES.join(', ')}.`)
  if (options.scope && !/^(global|project:[a-zA-Z0-9][a-zA-Z0-9._-]{0,99})$/i.test(options.scope)) {
    throw new Error('--scope must be global or project:<name>.')
  }
  return options
}

async function run ({ argv = process.argv.slice(2), env = process.env, home = os.homedir(), cwd = process.cwd(), log = console.log } = {}) {
  const options = parseArgs(argv)
  const documents = collectDocuments(options.paths, { cwd, scope: options.scope })
  if (!documents.length) throw new Error('No .md, .markdown, or .txt files found.')
  if (options.title && documents.length > 1) throw new Error('--title only works when importing one file.')
  if (options.dryRun) log('Dry run: nothing is written.')
  const results = await importDocuments(createClient({ env, home }), documents, options)
  log(summarize(results, options.dryRun))
  return results
}

if (require.main === module) {
  run().then(results => {
    if (results.some(result => result.action === 'error')) process.exitCode = 1
  }, error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { parseArgs, run }
