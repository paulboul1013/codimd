'use strict'
/* global globalThis, AbortSignal */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const LOCAL_URL = 'http://localhost:3000'
const PAGES_TARGET = 'https://paulboul1013.github.io/codimd/target.json'
const PROBE_TIMEOUT_MS = 1500
const REQUEST_TIMEOUT_MS = 15000
const START_HINT = 'Start it with ./bin/start-local or ./bin/start-public in the CodiMD checkout.'
// Errors raised before the request left this machine, so retrying cannot repeat a write.
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

// Cloudflare answers 530 (error 1033) when the tunnel is gone, before any origin sees the request.
const TUNNEL_GONE_STATUS = 530

class MemoryApiError extends Error {}

// An HTTP error page that the memory API did not write, which always answers JSON.
class NotTheApiError extends Error {
  constructor (status) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

function configPath (home) {
  return path.join(home, '.config', 'codimd-memory', 'config.json')
}

function loadConfig (env, home) {
  const location = configPath(home)
  let file = {}
  if (fs.existsSync(location)) {
    const stat = fs.statSync(location)
    if (!stat.isFile() || (stat.mode & 0o077)) {
      throw new MemoryApiError(`${location} must be a regular file readable only by its owner (chmod 600).`)
    }
    file = JSON.parse(fs.readFileSync(location, 'utf8'))
  }
  const token = env.CODIMD_MEMORY_TOKEN || file.token
  if (!token) {
    throw new MemoryApiError(`No CodiMD API token. Create one at /settings/api-tokens and save {"token": "..."} to ${location} (chmod 600).`)
  }
  return { token, serverUrl: env.CODIMD_URL || file.serverUrl || null }
}

function apiBase (serverUrl) {
  return serverUrl.replace(/\/+$/, '') + '/api/memory'
}

function isConnectError (error) {
  return Boolean(error && error.cause && CONNECT_ERRORS.has(error.cause.code))
}

// Retry only when the request cannot have reached the memory API, or cannot change anything.
function isUnreachable (error, method) {
  if (isConnectError(error)) return true
  return error instanceof NotTheApiError && (method === 'GET' || error.status === TUNNEL_GONE_STATUS)
}

function reason (error) {
  return (error.cause && error.cause.code) || error.message
}

function toApiError (error) {
  return error instanceof NotTheApiError ? new MemoryApiError(`CodiMD answered ${error.message}`) : error
}

function createClient ({ env = process.env, home = os.homedir(), fetch = globalThis.fetch } = {}) {
  let config = null
  let base = null

  async function probeLocal () {
    const response = await fetch(apiBase(LOCAL_URL) + '/ping', {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    const body = await response.json().catch(() => null)
    if (!body || typeof body.status !== 'string') throw new Error(`HTTP ${response.status} is not the memory API`)
    return apiBase(LOCAL_URL)
  }

  async function lookUpTunnel () {
    // GitHub Pages caches target.json for minutes; a stale URL names a dead tunnel.
    const response = await fetch(`${PAGES_TARGET}?t=${Date.now()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const target = await response.json()
    if (!target || typeof target.url !== 'string') throw new Error('target.json has no url')
    return apiBase(target.url)
  }

  async function resolveBase () {
    if (config.serverUrl) return apiBase(config.serverUrl)
    const failures = []
    for (const [label, attempt] of [[LOCAL_URL, probeLocal], [PAGES_TARGET, lookUpTunnel]]) {
      try {
        return await attempt()
      } catch (error) {
        failures.push(`${label}: ${reason(error)}`)
      }
    }
    throw new MemoryApiError(`CodiMD is not reachable (${failures.join('; ')}). ${START_HINT}`)
  }

  async function send (method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: Object.assign({ Authorization: `Bearer ${config.token}` }, body && { 'Content-Type': 'application/json' }),
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok && (!payload || typeof payload.status !== 'string')) throw new NotTheApiError(response.status)
    if (!response.ok || !payload || payload.status !== 'ok') {
      throw new MemoryApiError((payload && payload.message) || `CodiMD answered HTTP ${response.status}`)
    }
    return payload
  }

  async function request (method, route, body) {
    if (!config) config = loadConfig(env, home)
    if (!base) base = await resolveBase()
    try {
      return await send(method, route, body)
    } catch (error) {
      if (!isUnreachable(error, method)) throw toApiError(error)
      base = await resolveBase()
      try {
        return await send(method, route, body)
      } catch (retryError) {
        if (!isUnreachable(retryError, method)) throw toApiError(retryError)
        throw new MemoryApiError(`CodiMD at ${base} is not reachable: ${reason(retryError)}. ${START_HINT}`)
      }
    }
  }

  return { request }
}

function git (cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    return ''
  }
}

function repoName (remoteUrl) {
  return remoteUrl.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop()
}

function projectScope (cwd) {
  const remote = git(cwd, ['remote', 'get-url', 'origin'])
  const toplevel = remote ? '' : git(cwd, ['rev-parse', '--show-toplevel'])
  const raw = remote ? repoName(remote) : toplevel && path.basename(toplevel)
  const name = (raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '')
  return name ? `project:${name}` : null
}

module.exports = { createClient, projectScope, MemoryApiError }
