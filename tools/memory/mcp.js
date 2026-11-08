#!/usr/bin/env node
'use strict'

const readline = require('readline')
const { createClient, projectScope } = require('./client')
const { TOOLS, invalidArguments } = require('./tools')

const PROTOCOL_VERSION = '2025-06-18'
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

class RpcError extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

function textResult (text, isError) {
  return Object.assign({ content: [{ type: 'text', text }] }, isError && { isError: true })
}

function createHandler ({ client, defaultScope }) {
  const tools = new Map(TOOLS.map(tool => [tool.name, tool]))

  async function callTool (params) {
    const tool = tools.get(params.name)
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`)
    const args = params.arguments || {}
    if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(INVALID_PARAMS, 'Tool arguments must be an object.')
    const invalid = invalidArguments(tool, args)
    if (invalid) return textResult(invalid, true)
    try {
      return textResult(await tool.run(client, args, defaultScope))
    } catch (error) {
      return textResult(error.message, true)
    }
  }

  const methods = {
    initialize: params => ({
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'codimd-memory', version: '1.0.0' }
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }),
    'tools/call': params => {
      if (!params || typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name.')
      return callTool(params)
    }
  }

  // Returns the response object, or null when the message needs no reply.
  return async function handle (message) {
    const isObject = message !== null && typeof message === 'object' && !Array.isArray(message)
    if (!isObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // This server sends no requests, so a stray response from the client is dropped.
      if (isObject && ('result' in message || 'error' in message)) return null
      const id = isObject && message.id !== undefined ? message.id : null
      return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid request' } }
    }
    const isNotification = !('id' in message)
    const method = Object.prototype.hasOwnProperty.call(methods, message.method) && methods[message.method]
    if (isNotification) return null
    if (!method) return { jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } }
    try {
      return { jsonrpc: '2.0', id: message.id, result: await method(message.params) }
    } catch (error) {
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR
      return { jsonrpc: '2.0', id: message.id, error: { code, message: error.message } }
    }
  }
}

function serve () {
  const handle = createHandler({ client: createClient(), defaultScope: projectScope(process.cwd()) })
  const send = response => { if (response) process.stdout.write(JSON.stringify(response) + '\n') }
  readline.createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      return send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } })
    }
    handle(message).then(send, error => process.stderr.write(`codimd-memory: ${error.stack}\n`))
  })
}

if (require.main === module) serve()

module.exports = { createHandler }
