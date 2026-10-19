#!/usr/bin/env node
/* eslint-env node, browser */
'use strict'

// Run through bin/check-sharing-collaboration. Credentials stay outside the repo.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const ROOT = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The wall clock in this WSL setup can jump by minutes; event ordering uses a monotonic clock.
const monotonic = () => require('perf_hooks').performance.now()

function argumentsFor (argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (['--provision', '--prepare', '--finalize', '--cleanup', '--keep-note', '--help'].includes(key)) options[key.slice(2)] = true
    else if (['--credentials', '--run-dir', '--output', '--actor'].includes(key) && argv[i + 1]) options[key.slice(2)] = argv[++i]
    else throw new Error('Unknown or incomplete option: ' + key)
  }
  return options
}

function playwright () {
  const candidates = [process.env.CODIMD_PLAYWRIGHT_MODULE, 'playwright', 'playwright-core']
  const cache = path.join(os.homedir(), '.npm', '_npx')
  if (fs.existsSync(cache)) {
    for (const name of fs.readdirSync(cache)) candidates.push(path.join(cache, name, 'node_modules', 'playwright'))
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate) } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('Playwright is unavailable. Set CODIMD_PLAYWRIGHT_MODULE to an installed Playwright module.')
}

function credentials (filename) {
  if (!filename) throw new Error('Provide --credentials with a private JSON file; see --help.')
  const location = path.resolve(filename)
  if (location === ROOT || location.startsWith(ROOT + path.sep)) throw new Error('Keep the credential file outside the repository.')
  const stat = fs.statSync(location)
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Credential file must be a regular file readable only by its owner (chmod 600).')
  const data = JSON.parse(fs.readFileSync(location, 'utf8'))
  for (const role of ['owner', 'collaborator']) {
    if (!data[role] || typeof data[role].email !== 'string' || typeof data[role].password !== 'string' || !data[role].email.includes('@') || !data[role].password) {
      throw new Error('Credential file requires owner and collaborator objects with email and password.')
    }
  }
  if (data.owner.email.toLowerCase() === data.collaborator.email.toLowerCase()) throw new Error('Use two distinct accounts.')
  return data
}

function writeJSON (filename, value) {
  const temporary = filename + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, filename)
}

function redact (value, secrets) {
  let result = String(value)
  for (const role of ['owner', 'collaborator']) result = result.split(secrets[role].password).join('[REDACTED]')
  return result
}

async function browser () {
  const options = { headless: true, args: ['--no-sandbox'] }
  if (process.env.CODIMD_BROWSER_EXECUTABLE) options.executablePath = process.env.CODIMD_BROWSER_EXECUTABLE
  return playwright().chromium.launch(options)
}

async function newContext (instance, baseURL) {
  const context = await instance.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-TW', acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  await context.addCookies([{ name: 'locale', value: 'zh-TW', url: baseURL }])
  context.setDefaultTimeout(10000)
  return context
}

async function login (page, baseURL, account, provision) {
  await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' })
  if (provision) {
    // Existing accounts are not reset. A duplicate registration uses the normal rejection path.
    const response = await page.request.post(baseURL + '/register', { form: account })
    if (response.status() >= 500) throw new Error('Registration endpoint failed.')
  }
  return submitLogin(page, baseURL, account)
}

async function signinModal (page) {
  const modal = page.locator('.signin-modal')
  // A pending shared-note destination opens the dialog by itself; never click through it.
  if (new URL(page.url()).searchParams.get('next')) {
    await modal.waitFor({ state: 'visible' })
  } else if (!(await modal.isVisible())) {
    await page.locator('[data-target=".signin-modal"]').first().click()
  }
  await page.waitForFunction(() => document.querySelector('.signin-modal').classList.contains('in'))
  await page.waitForTimeout(400)
  return modal
}

async function submitLogin (page, baseURL, account) {
  await signinModal(page)
  await page.locator('.signin-modal input[name="email"]').fill(account.email)
  await page.locator('.signin-modal input[name="password"]').fill(account.password)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator('.signin-modal button[formaction$="/login"]').click()
  ])
  const response = await page.request.get(baseURL + '/me')
  if (response.status() !== 200) throw new Error('Account login failed; no password reset or substitute account was attempted.')
  const me = await response.json()
  if (me.status !== 'ok' || !me.id || !me.name) throw new Error('Authenticated profile is incomplete.')
  return { id: me.id, name: me.name }
}

// Drops chosen client-to-server socket.io events to simulate a lost message deterministically.
async function socketFilter (page) {
  const blocked = new Set()
  const sent = []
  let sockets = 0
  await page.routeWebSocket(/socket\.io/, ws => {
    const server = ws.connectToServer()
    const socket = ++sockets
    ws.onMessage(message => {
      const event = (/^42\d*\["([^"]+)"/.exec(String(message)) || [])[1]
      if (!event) return server.send(message)
      const dropped = blocked.has(event)
      sent.push({ event, at: monotonic(), socket, blocked: dropped })
      if (!dropped) server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  return {
    block (event) { blocked.add(event) },
    allow (event) { blocked.delete(event) },
    sentSince (time) { return sent.filter(item => item.at >= time && !item.blocked).map(item => item.event) },
    log () { return sent.slice() }
  }
}

function shareDialog (page) {
  const modal = page.locator('#shareModal')
  const message = key => modal.locator('.ui-share-messages [data-message="' + key + '"]').textContent()
  return {
    modal,
    message,
    async open (entry = '.navbar-collapse .ui-share') {
      await page.locator(entry + ':visible').click()
      await modal.waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('#shareModal').classList.contains('in'))
      await page.waitForTimeout(300)
    },
    async close () {
      await modal.locator('.modal-footer [data-dismiss="modal"]').click()
      await modal.waitFor({ state: 'hidden' })
    },
    status () { return modal.locator('.ui-share-status').textContent() },
    async act (kind, expected) {
      await modal.locator('.ui-share-' + kind).click()
      const text = await message(expected)
      await page.waitForFunction(value => document.querySelector('#shareModal .ui-share-status').textContent === value, text, { timeout: 15000 })
      return text
    },
    async state () {
      return modal.evaluate(element => {
        const visible = selector => Array.from(element.querySelectorAll(selector)).some(node => node.offsetParent !== null)
        const scope = Array.from(element.querySelectorAll('.share-scope [data-permission]')).filter(node => node.offsetParent !== null)
        return {
          url: element.querySelector('.ui-share-url').value,
          scope: scope.map(node => node.getAttribute('data-permission')),
          enable: visible('.ui-share-enable'),
          stop: visible('.ui-share-stop'),
          ownerControls: visible('.ui-share-owner-controls')
        }
      })
    }
  }
}

// A protocol-level client sharing the browser account's session cookie.
async function rawSocket (context, baseURL, noteId, opened) {
  const io = require(path.join(ROOT, 'node_modules', 'socket.io-client'))
  const cookie = (await context.cookies(baseURL)).map(item => item.name + '=' + item.value).join('; ')
  const socket = io(baseURL, { query: { noteId }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } })
  opened.push(socket)
  const events = []
  const onevent = socket.onevent
  socket.onevent = function (packet) {
    events.push({ event: packet.data[0], args: packet.data.slice(1), at: monotonic() })
    return onevent.call(this, packet)
  }
  let disconnected = false
  socket.on('disconnect', () => { disconnected = true })
  return {
    events,
    disconnected: () => disconnected,
    emit: (...args) => socket.emit(...args),
    onInfo: handler => socket.on('info', handler),
    ack: (...args) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No acknowledgement for ' + args[0])), 10000)
      socket.emit(...args, reply => {
        clearTimeout(timer)
        resolve(reply)
      })
    }),
    async waitFor (event, timeout = 10000) {
      const deadline = monotonic() + timeout
      while (monotonic() < deadline) {
        if (events.some(item => item.event === event)) return
        await sleep(100)
      }
      throw new Error('Raw socket did not receive ' + event)
    },
    close: () => socket.close()
  }
}

async function headerPermission (page) {
  return page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('[id^="permissionLabel"]')).find(node => node.style.display !== 'none')
    return label ? label.id.replace('permissionLabel', '').toLowerCase() : null
  })
}

function cursorLabels (page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.CodeMirror-other-cursor[data-clientid]')).map(node => {
    let opacity = 1
    for (let element = node; element; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity)
    const tag = node.querySelector('.cursortag')
    const rect = tag.getBoundingClientRect()
    return { name: node.querySelector('.name').textContent, opacity, tagVisible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).display !== 'none' }
  }))
}

function participantNames (page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#online-user-list .ui-user-name')).map(node => node.textContent.trim()))
}

async function editorReady (page) {
  await page.locator('.CodeMirror').waitFor({ state: 'visible' })
  await page.waitForFunction(() => window.loaded && window.editor && window.cmClient)
}

async function additionalChecks (manifest, cleanupOnly = false) {
  const secrets = credentials(manifest.credentialFile)
  const checks = []
  const directory = path.join(manifest.artifactDir, 'coordinator')
  fs.mkdirSync(directory, { recursive: true })
  const capture = async (page, name) => {
    const filename = path.join(directory, name + '.png')
    await page.screenshot({ path: filename, fullPage: true })
    return path.relative(ROOT, filename)
  }
  const check = async (id, requirements, fn, page, lane = 'feature') => {
    const result = { id, requirements, lane, actor: 'coordinator', status: 'PASS' }
    try { result.details = await fn() } catch (error) {
      result.status = 'FAIL'
      result.reason = redact(error.message, secrets).slice(0, 1800)
      if (error.evidence) result.details = error.evidence
      if (page) { try { result.screenshot = await capture(page, id + '-failed') } catch (_) {} }
    }
    checks.push(result)
    return result.status === 'PASS'
  }
  const filename = path.join(manifest.runDir, 'fixture-created.json')
  if (!fs.existsSync(filename)) {
    const missing = [{ id: 'additional-fixture-checks', requirements: ['Q2', 'Q7', 'Q13'], lane: 'feature', status: 'BLOCKED', reason: 'Owner never created a dedicated fixture.' }]
    writeJSON(path.join(directory, 'results.json'), { runId: manifest.runId, actor: 'coordinator', checks: missing })
    return missing
  }
  const fixture = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (fixture.runId !== manifest.runId) throw new Error('Fixture run ID does not match.')
  const noteURL = new URL(fixture.payload.noteURL)
  if (noteURL.origin !== manifest.baseURL || !/^\/[A-Za-z0-9_-]+$/.test(noteURL.pathname)) throw new Error('Refusing a fixture outside the local note path.')
  const editorURL = noteURL.href + '?both'
  const marker = fixture.payload.marker
  const instance = await browser()
  const ownerContext = await newContext(instance, manifest.baseURL)
  const otherContext = await newContext(instance, manifest.baseURL)
  const ownerPage = await ownerContext.newPage()
  const otherPage = await otherContext.newPage()
  const ownerShare = shareDialog(ownerPage)
  const setSharing = async kind => {
    await ownerPage.goto(editorURL)
    await editorReady(ownerPage)
    await ownerPage.waitForFunction(() => Array.from(document.querySelectorAll('[id^="permissionLabel"]')).some(node => node.style.display !== 'none'))
    const target = kind === 'enable' ? 'limited' : 'private'
    if (await headerPermission(ownerPage) === target) return
    await ownerShare.open()
    await ownerShare.act(kind, kind === 'enable' ? 'enabled' : 'stopped')
    await ownerShare.close()
  }
  const landedOnNote = page => new URL(page.url()).pathname === noteURL.pathname && new URL(page.url()).search === '?both'
  let owned = false
  // A throwaway account with the owner's display name, removed again during cleanup.
  const temporary = {
    email: manifest.accounts.owner.name + '@sharing-' + manifest.runId.slice(-6) + '.test',
    password: crypto.randomBytes(12).toString('hex')
  }
  let temporaryContext = null
  let temporaryCreated = false
  try {
    const owner = await login(ownerPage, manifest.baseURL, secrets.owner, false)
    await login(otherPage, manifest.baseURL, secrets.collaborator, false)
    const ownedResponse = await ownerPage.request.get(manifest.baseURL + '/api/notes/myNotes')
    const ownedNotes = await ownedResponse.json()
    const list = ownedNotes.myNotes || []
    const model = list.find(note => note.id === noteURL.pathname.slice(1))
    const download = await ownerPage.request.get(noteURL.href + '/download')
    const body = await download.text()
    owned = ownedResponse.ok() && !!model && owner.id === manifest.accounts.owner.id && body.includes('sharing-fixture-' + manifest.runId)
    if (!owned) throw new Error('Dedicated fixture ownership and run marker could not be verified; refusing further mutation or cleanup.')
    if (cleanupOnly) return checks
    await setSharing('enable')

    let providers = []
    const guest = await newContext(instance, manifest.baseURL)
    try {
      const page = await guest.newPage()
      await page.goto(editorURL)
      await check('guest-login-prompt-auto-opens', ['Q2'], async () => {
        const target = new URL(page.url()).searchParams.get('next')
        if (target !== noteURL.pathname + '?both') throw new Error('Anonymous access did not retain the original note and mode.')
        await page.locator('.signin-modal').waitFor({ state: 'visible' })
        await page.waitForTimeout(400)
        providers = await page.evaluate(() => {
          const modal = document.querySelector('.signin-modal')
          const found = Array.from(modal.querySelectorAll('a.btn-login-method')).map(link => new URL(link.href).pathname.split('/')[2])
          if (modal.querySelector('button[formaction$="/login"]')) found.push('email')
          if (modal.querySelector('button[formaction$="/auth/ldap"]')) found.push('ldap')
          if (modal.querySelector('form[action$="/auth/openid"]')) found.push('openid')
          return found
        })
        return { next: target, providers, screenshot: await capture(page, 'guest-login-prompt') }
      }, page)
      await check('login-retry-returns-original-note', ['Q2', 'Q11'], async () => {
        const wrong = { email: secrets.collaborator.email, password: secrets.collaborator.password + '-incorrect-test' }
        try { await submitLogin(page, manifest.baseURL, wrong) } catch (error) {
          if (!error.message.startsWith('Account login failed')) throw error
        }
        if (new URL(page.url()).searchParams.get('next') !== noteURL.pathname + '?both') throw new Error('A failed login dropped the shared-note destination.')
        const retryPrompt = await capture(page, 'login-failed-retry-prompt')
        await submitLogin(page, manifest.baseURL, secrets.collaborator)
        if (!landedOnNote(page)) throw new Error('Failed login followed by successful retry lost the original note or editor mode.')
        await editorReady(page)
        await page.waitForFunction(value => window.editor.getValue().includes(value), marker)
        return { retryPrompt, screenshot: await capture(page, 'login-retry-return') }
      }, page)
    } finally { await guest.close() }

    const late = await newContext(instance, manifest.baseURL)
    try {
      const page = await late.newPage()
      await page.goto(editorURL)
      await check('login-revocation-during-auth', ['Q2', 'Q7'], async () => {
        if (!new URL(page.url()).searchParams.get('next')) throw new Error('Guest was not sent to sign in first.')
        await setSharing('stop')
        await submitLogin(page, manifest.baseURL, secrets.collaborator)
        const status = (await page.request.get(editorURL, { maxRedirects: 0 })).status()
        const editorPresent = await page.locator('.CodeMirror').count()
        const leaked = (await page.content()).includes(marker)
        if (new URL(page.url()).pathname !== noteURL.pathname) throw new Error('Login did not return to the shared note.')
        if (status !== 403 || editorPresent || leaked) throw new Error('Sharing stopped during login, but the note was still served: HTTP ' + status)
        return { returnedTo: noteURL.pathname, status, screenshot: await capture(page, 'login-after-revocation') }
      }, page)
      await setSharing('enable')
    } finally { await late.close() }

    const registration = await newContext(instance, manifest.baseURL)
    try {
      const page = await registration.newPage()
      await page.goto(editorURL)
      const register = page.locator('.signin-modal button[formaction$="/register"]')
      if (await register.count()) {
        await check('registration-retry-preserves-destination', ['Q13'], async () => {
          const modal = await signinModal(page)
          await modal.locator('input[name="email"]').fill(secrets.collaborator.email)
          await modal.locator('input[name="password"]').fill(secrets.collaborator.password)
          await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), register.click()])
          if (new URL(page.url()).searchParams.get('next') !== noteURL.pathname + '?both') throw new Error('Duplicate registration dropped the shared-note destination.')
          const rejected = await capture(page, 'registration-duplicate-rejected')
          await submitLogin(page, manifest.baseURL, secrets.collaborator)
          if (!landedOnNote(page)) throw new Error('Duplicate-registration rejection followed by login lost the original shared note.')
          return { rejected, screenshot: await capture(page, 'registration-retry-return'), newAccountCreated: false }
        }, page)
      } else checks.push({ id: 'registration-retry-preserves-destination', requirements: ['Q13'], lane: 'feature', status: 'BLOCKED', reason: 'Email registration is disabled in this deployment; it was not enabled by the verifier.' })
    } finally { await registration.close() }

    temporaryContext = await newContext(instance, manifest.baseURL)
    const tempPage = await temporaryContext.newPage()
    // Lets the idle check advance this page's clock; time flows normally until then.
    await tempPage.clock.install()
    await tempPage.goto(editorURL)
    const registered = await check('fresh-registration-returns-to-note', ['Q13', 'Q11'], async () => {
      const modal = await signinModal(tempPage)
      await modal.locator('input[name="email"]').fill(temporary.email)
      await modal.locator('input[name="password"]').fill(temporary.password)
      await Promise.all([tempPage.waitForNavigation({ waitUntil: 'domcontentloaded' }), modal.locator('button[formaction$="/register"]').click()])
      temporaryCreated = true
      if (new URL(tempPage.url()).searchParams.get('next') !== noteURL.pathname + '?both') throw new Error('Registration dropped the shared-note destination.')
      const registeredEvidence = await capture(tempPage, 'fresh-registration-signin')
      const me = await submitLogin(tempPage, manifest.baseURL, temporary)
      if (!landedOnNote(tempPage)) throw new Error('A new account did not return to the shared note after signing in.')
      await editorReady(tempPage)
      await tempPage.waitForFunction(value => window.editor.getValue().includes(value), marker)
      return { account: me.name, registeredEvidence, screenshot: await capture(tempPage, 'fresh-registration-note') }
    }, tempPage)

    if (registered) {
      await ownerPage.goto(editorURL)
      await editorReady(ownerPage)
      await ownerPage.locator('.CodeMirror').click({ position: { x: 200, y: 60 } })
      await tempPage.locator('.CodeMirror').click({ position: { x: 200, y: 120 } })
      const ownerName = manifest.accounts.owner.name
      await check('same-name-disambiguation-fixtures', ['Q10'], async () => {
        const labelled = names => names.filter(name => name.startsWith(ownerName + ' · '))
        await ownerPage.waitForFunction(name => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).some(node => node.textContent.startsWith(name + ' · ')), ownerName)
        await tempPage.waitForFunction(name => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).some(node => node.textContent.startsWith(name + ' · ')), ownerName)
        const ownerView = { participants: labelled(await participantNames(ownerPage)), cursors: (await cursorLabels(ownerPage)).map(cursor => cursor.name) }
        const tempView = { participants: labelled(await participantNames(tempPage)), cursors: (await cursorLabels(tempPage)).map(cursor => cursor.name) }
        if (ownerView.participants.length !== 2 || new Set(ownerView.participants).size !== 2) throw new Error('Same-name accounts are not listed with distinct labels: ' + JSON.stringify(ownerView))
        if (JSON.stringify([...ownerView.participants].sort()) !== JSON.stringify([...tempView.participants].sort())) throw new Error('The two accounts see different labels: ' + JSON.stringify({ ownerView, tempView }))
        const ownerLabel = tempView.cursors.find(name => name.startsWith(ownerName + ' · '))
        const tempLabel = ownerView.cursors.find(name => name.startsWith(ownerName + ' · '))
        if (!ownerLabel || !tempLabel || ownerLabel === tempLabel) throw new Error('Remote cursor labels do not tell the accounts apart.')
        if (!ownerView.participants.includes(ownerLabel) || !ownerView.participants.includes(tempLabel)) throw new Error('Cursor labels differ from the participant list.')
        const second = await ownerContext.newPage()
        await second.goto(editorURL)
        await editorReady(second)
        await second.locator('.CodeMirror').click({ position: { x: 200, y: 160 } })
        await tempPage.waitForFunction(label => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).filter(node => node.textContent === label).length === 2, ownerLabel)
        const tabs = labelled(await participantNames(tempPage))
        const twoTabs = await capture(tempPage, 'same-name-two-owner-tabs')
        await second.close()
        await tempPage.waitForFunction(label => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).filter(node => node.textContent === label).length === 1, ownerLabel, { timeout: 15000 })
        if (new Set(tabs).size !== 2) throw new Error('A second tab of one account was shown as another identity: ' + JSON.stringify(tabs))
        return { ownerLabel, temporaryLabel: tempLabel, ownerView, tempView, sameAccountTabs: tabs, screenshots: [await capture(ownerPage, 'same-name-owner-view'), twoTabs] }
      }, ownerPage)

      await check('idle-and-new-join-cursor-state', ['Q9'], async () => {
        const active = (await cursorLabels(ownerPage)).find(cursor => cursor.name.startsWith(ownerName + ' · '))
        if (!active || active.opacity < 0.99) throw new Error('No active remote cursor before idling: ' + JSON.stringify(active))
        const tempLabel = active.name
        // Small steps keep socket heartbeats answered while five idle minutes pass.
        for (let step = 0; step < 160; step++) {
          await tempPage.clock.runFor(2000)
          await sleep(30)
        }
        await ownerPage.waitForFunction(label => Array.from(document.querySelectorAll('.CodeMirror-other-cursor')).some(node => node.querySelector('.name').textContent === label && node.classList.contains('CodeMirror-other-cursor-inactive')), tempLabel, { timeout: 15000 })
        await sleep(400)
        const idle = (await cursorLabels(ownerPage)).find(cursor => cursor.name === tempLabel)
        if (!idle || !idle.tagVisible || !(idle.opacity > 0 && idle.opacity < active.opacity)) throw new Error('Idle collaborator is not shown dimmed with its name: ' + JSON.stringify(idle))
        const idleEvidence = await capture(ownerPage, 'idle-collaborator-dimmed')
        const joiner = await ownerContext.newPage()
        await joiner.goto(editorURL)
        await editorReady(joiner)
        await joiner.waitForFunction(label => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).some(node => node.textContent === label), tempLabel)
        await sleep(400)
        const joined = (await cursorLabels(joiner)).find(cursor => cursor.name === tempLabel)
        const joinEvidence = await capture(joiner, 'new-join-sees-idle-collaborator')
        await joiner.close()
        if (!joined || !joined.tagVisible || !(joined.opacity > 0 && joined.opacity < 0.99)) throw new Error('A newly joined viewer does not see the idle collaborator dimmed: ' + JSON.stringify(joined))
        return { active, idle, newJoin: joined, screenshots: [idleEvidence, joinEvidence] }
      }, ownerPage)
    } else {
      checks.push({ id: 'same-name-disambiguation-fixtures', requirements: ['Q10'], lane: 'feature', status: 'BLOCKED', reason: 'The same-name account could not be registered.' })
      checks.push({ id: 'idle-and-new-join-cursor-state', requirements: ['Q9'], lane: 'feature', status: 'BLOCKED', reason: 'The idle participant could not be registered.' })
    }

    await check('enabled-auth-provider-return-coverage', ['Q11'], async () => {
      const exercised = { email: ['login-retry-returns-original-note', 'fresh-registration-returns-to-note', 'registration-retry-preserves-destination'] }
      const missing = providers.filter(provider => !exercised[provider])
      if (!providers.length) throw new Error('No enabled sign-in method was found on the shared-note prompt.')
      if (missing.length) throw new Error('Enabled providers were not exercised end to end: ' + missing.join(', '))
      const failed = exercised.email.filter(id => !checks.some(item => item.id === id && item.status === 'PASS'))
      if (failed.length) throw new Error('Email return checks did not pass: ' + failed.join(', '))
      return { enabledProviders: providers, exercised }
    }, null)

    await setSharing('stop')
    await ownerPage.goto(manifest.baseURL + '/')
    await otherPage.goto(manifest.baseURL + '/')
    await tempPage.goto(manifest.baseURL + '/')
    await sleep(1500)
    await check('private-note-api-rejects-nonowner-update', ['Q7'], async () => {
      const before = await (await ownerPage.request.get(noteURL.href + '/download')).text()
      const deniedRead = await otherPage.request.get(noteURL.href + '/download', { maxRedirects: 0 })
      if (deniedRead.status() !== 403) throw new Error('BLOCKED: private-view denial precondition was not established.')
      const attempted = before + '\nunauthorized-api-probe-' + manifest.runId + '\n'
      let response
      let responseBody
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await otherPage.request.put(manifest.baseURL + '/api/notes/' + noteURL.pathname.slice(1), { data: { content: attempted } })
        responseBody = await response.text()
        if (!responseBody.includes('Update API can only be used when no users is online')) break
        await sleep(500)
      }
      if (responseBody.includes('Update API can only be used when no users is online')) {
        const error = new Error('BLOCKED: fixture remained in realtime pool; response did not exercise note authorization.')
        throw error
      }
      const after = await (await ownerPage.request.get(noteURL.href + '/download')).text()
      if (response.status() !== 403 || after !== before) {
        const error = new Error('Nonowner update of a private fixture returned ' + response.status() + '; contentChanged=' + (after !== before) + '.')
        error.evidence = {
          deniedDownloadStatus: deniedRead.status(),
          updateStatus: response.status(),
          contentChanged: after !== before,
          beforeSHA256: crypto.createHash('sha256').update(before).digest('hex'),
          afterSHA256: crypto.createHash('sha256').update(after).digest('hex')
        }
        throw error
      }
      return { status: response.status(), contentUnchanged: true }
    }, null)
    const apiResult = checks.find(c => c.id === 'private-note-api-rejects-nonowner-update')
    if (apiResult && (apiResult.reason || '').startsWith('BLOCKED:')) apiResult.status = 'BLOCKED'
  } finally {
    if (temporaryCreated) {
      await check('cleanup-temporary-account', [], async () => {
        const page = temporaryContext.pages()[0] || await temporaryContext.newPage()
        await page.goto(manifest.baseURL + '/')
        const link = await page.locator('a[href*="/me/delete/"]').getAttribute('href')
        if (!link || !/\/me\/delete\/[^/]+$/.test(link)) throw new Error('Temporary account delete link is unavailable.')
        await page.goto(new URL(link, manifest.baseURL).href)
        const probe = await newContext(instance, manifest.baseURL)
        try {
          const response = await probe.request.post(manifest.baseURL + '/login', { form: temporary, maxRedirects: 0 })
          const me = await probe.request.get(manifest.baseURL + '/me')
          if (me.status() === 200 && (await me.json()).status === 'ok') throw new Error('Temporary account still signs in after deletion.')
          return { deleted: true, loginStatus: response.status() }
        } finally { await probe.close() }
      }, null, 'cleanup')
    }
    if (owned && !manifest.keepNote) {
      await check('cleanup-dedicated-fixture', [], async () => {
        const response = await ownerPage.request.delete(manifest.baseURL + '/api/notes/' + noteURL.pathname.slice(1))
        if (response.status() !== 200) throw new Error('Owner fixture cleanup failed with HTTP ' + response.status())
        return { deletedOnlyVerifiedFixture: true, notePath: noteURL.pathname }
      }, null, 'cleanup')
    }
    writeJSON(path.join(directory, 'results.json'), { runId: manifest.runId, actor: 'coordinator', checks })
    if (temporaryContext) await temporaryContext.close()
    await ownerContext.close()
    await otherContext.close()
    await instance.close()
  }
  return checks
}

async function prepare (options) {
  const secrets = credentials(options.credentials)
  const runDir = options['run-dir'] ? path.resolve(options['run-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), 'codimd-sharing-'))
  if (runDir.startsWith(ROOT + path.sep)) throw new Error('Keep the private run directory outside the repository.')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(runDir, 0o700)
  if (fs.existsSync(path.join(runDir, 'manifest.json'))) throw new Error('Use a fresh run directory; existing run artifacts are never overwritten.')
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')
  const artifactDir = path.resolve(options.output || path.join(ROOT, 'output/playwright/sharing-collaborative-editing', runId))
  if (fs.existsSync(artifactDir) && fs.readdirSync(artifactDir).length) throw new Error('Use a new empty artifact directory; existing evidence is never reused across runs.')
  fs.mkdirSync(artifactDir, { recursive: true })
  const manifest = { runId, baseURL: 'http://localhost:3000', runDir, artifactDir, credentialFile: path.resolve(options.credentials), keepNote: !!options['keep-note'], accounts: {} }
  const instance = await browser()
  try {
    for (const role of ['owner', 'collaborator']) {
      const context = await newContext(instance, manifest.baseURL)
      try {
        manifest.accounts[role] = await login(await context.newPage(), manifest.baseURL, secrets[role], options.provision)
      } finally { await context.close() }
    }
    if (manifest.accounts.owner.id === manifest.accounts.collaborator.id) throw new Error('Authentication did not produce two separate users.')
    writeJSON(path.join(runDir, 'manifest.json'), manifest)
    writeJSON(path.join(artifactDir, 'run.json'), { runId, baseURL: manifest.baseURL, accounts: manifest.accounts, browserVersion: instance.version(), nodeVersion: process.version })
    return manifest
  } catch (error) { throw new Error(redact(error.message, secrets)) } finally { await instance.close() }
}

function loadManifest (runDir) {
  if (!runDir) throw new Error('Provide --run-dir from a successful --prepare invocation.')
  const manifest = JSON.parse(fs.readFileSync(path.join(path.resolve(runDir), 'manifest.json'), 'utf8'))
  if (manifest.baseURL !== 'http://localhost:3000') throw new Error('This local verifier only operates on localhost:3000.')
  return manifest
}

async function actor (role, manifest, sharedSignals) {
  if (!['owner', 'collaborator'].includes(role)) throw new Error('Actor must be owner or collaborator.')
  const secrets = credentials(manifest.credentialFile)
  const records = []
  const artifactDir = path.join(manifest.artifactDir, role)
  fs.mkdirSync(artifactDir, { recursive: true })
  const instance = await browser()
  const context = await newContext(instance, manifest.baseURL)
  const page = await context.newPage()
  const filter = await socketFilter(page)
  const sockets = []
  const h = {
    socketFilter: filter,
    now: monotonic,
    page,
    context,
    baseURL: manifest.baseURL,
    runId: manifest.runId,
    accounts: manifest.accounts,
    artifactDir,
    async check (id, requirements, lane, fn) {
      const item = { id, requirements, lane, actor: role, status: 'PASS' }
      try { item.details = await fn() } catch (error) {
        item.status = 'FAIL'
        item.reason = redact(error.message, secrets).slice(0, 1800)
        try { item.screenshot = await h.capture(id + '-failed') } catch (_) {}
      }
      records.push(item)
      writeJSON(path.join(artifactDir, 'results.json'), { runId: manifest.runId, actor: role, checks: records })
      return item.status === 'PASS'
    },
    blocked (id, requirements, reason) { records.push({ id, requirements, lane: 'feature', actor: role, status: 'BLOCKED', reason }) },
    async capture (name) {
      const filename = path.join(artifactDir, name.replace(/[^a-zA-Z0-9_-]/g, '-') + '.png')
      await page.screenshot({ path: filename, fullPage: true })
      return path.relative(ROOT, filename)
    },
    signal (name, payload = {}) {
      writeJSON(path.join(manifest.runDir, name + '.json'), { runId: manifest.runId, payload })
      if (sharedSignals) {
        sharedSignals.values.set(name, payload)
        for (const waiter of sharedSignals.waiters.get(name) || []) waiter.resolve(payload)
        sharedSignals.waiters.delete(name)
        if (name.endsWith('-failed')) {
          for (const waiters of sharedSignals.waiters.values()) {
            for (const waiter of waiters) waiter.reject(new Error('Peer actor failed.'))
          }
          sharedSignals.waiters.clear()
        }
      }
      console.log(JSON.stringify({ actor: role, stage: name, at: new Date().toISOString() }))
    },
    async wait (name, timeout = 180000) {
      if (sharedSignals) {
        if (sharedSignals.values.has(name)) return sharedSignals.values.get(name)
        if (sharedSignals.values.has('owner-failed') || sharedSignals.values.has('collaborator-failed')) throw new Error('Peer actor failed before ' + name)
        return new Promise((resolve, reject) => {
          const waiters = sharedSignals.waiters.get(name) || []
          const remove = () => {
            const active = sharedSignals.waiters.get(name) || []
            const remaining = active.filter(item => item !== waiter)
            if (remaining.length) sharedSignals.waiters.set(name, remaining)
            else sharedSignals.waiters.delete(name)
          }
          const waiter = {
            resolve (payload) { clearTimeout(timer); remove(); resolve(payload) },
            reject (error) { clearTimeout(timer); remove(); reject(error) }
          }
          const timer = setTimeout(() => waiter.reject(new Error('Timed out waiting for peer stage ' + name + '.')), timeout)
          waiters.push(waiter)
          sharedSignals.waiters.set(name, waiters)
        })
      }
      const deadline = monotonic() + timeout
      while (monotonic() < deadline) {
        const filename = path.join(manifest.runDir, name + '.json')
        if (fs.existsSync(filename)) {
          const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
          if (data.runId !== manifest.runId) throw new Error('Coordination run ID mismatch.')
          return data.payload
        }
        for (const peer of ['owner', 'collaborator']) {
          if (peer !== role && fs.existsSync(path.join(manifest.runDir, peer + '-failed.json'))) throw new Error('Peer actor failed before ' + name + '.')
        }
        await sleep(150)
      }
      throw new Error('Timed out waiting for peer stage ' + name + '.')
    },
    async editorReady () {
      await page.locator('.CodeMirror').waitFor({ state: 'visible' })
      await page.waitForFunction(() => window.loaded && window.editor && window.cmClient)
      console.log(JSON.stringify({ actor: role, stage: 'editor-ready', at: new Date().toISOString() }))
    },
    text () { return page.evaluate(() => window.editor.getValue()) },
    async append (text) {
      await page.locator('.CodeMirror').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(text)
    },
    async waitText (text) { await page.waitForFunction(value => window.editor && window.editor.getValue().includes(value), text) },
    share: shareDialog(page),
    headerPermission: () => headerPermission(page),
    rawSocket: noteId => rawSocket(context, manifest.baseURL, noteId, sockets)
  }
  try {
    h.me = await login(page, manifest.baseURL, secrets[role], false)
    if (h.me.id !== manifest.accounts[role].id) throw new Error('Actor authenticated as an unexpected account.')
    const scenario = require('./lib/sharing-' + role + '-actor')
    await scenario(h)
  } catch (error) {
    records.push({ id: role + '-execution', requirements: [], lane: 'execution', actor: role, status: 'FAIL', reason: redact(error.message, secrets).slice(0, 1800) })
    h.signal(role + '-failed', { reason: redact(error.message, secrets).slice(0, 1000) })
    try { await h.capture('execution-failed') } catch (_) {}
  } finally {
    writeJSON(path.join(artifactDir, 'results.json'), { runId: manifest.runId, actor: role, checks: records })
    sockets.forEach(socket => socket.close())
    await context.close()
    await instance.close()
  }
  const failed = records.filter(x => x.status === 'FAIL').length
  console.log(JSON.stringify({ actor: role, checks: records.length, failed, artifactDir }))
  return failed ? 1 : 0
}

async function finalize (manifest) {
  const coordinatorFile = path.join(manifest.artifactDir, 'coordinator', 'results.json')
  if (!fs.existsSync(coordinatorFile)) await additionalChecks(manifest)
  const checks = []
  for (const role of ['owner', 'collaborator', 'coordinator']) {
    const filename = path.join(manifest.artifactDir, role, 'results.json')
    if (fs.existsSync(filename)) {
      const result = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (result.runId !== manifest.runId) throw new Error('Refusing stale results from a different run: ' + role)
      checks.push(...result.checks)
    } else checks.push({ id: role + '-missing', lane: 'execution', requirements: [], status: 'BLOCKED', reason: 'Actor produced no result file.' })
  }
  const mandatory = {
    Q1: 'Share entry and same-note collaboration through the Share flow',
    Q2: 'Login return, failed-login retry, and permission change during login',
    Q3: 'Server account display names on remote cursors',
    Q4: 'Remote cursor labels only; local cursor unchanged',
    Q5: 'Distinct account colors, stable during active collaboration',
    Q6: 'Owner-only Share enable and stop controls',
    Q7: 'Stop sharing revokes HTTP, API and active socket access',
    Q8: 'Explicit enable separate from copy; confirmed results and failure handling',
    Q9: 'Online inactive cursor and name remain visible with reduced opacity',
    Q10: 'Same-name account disambiguation and collision handling',
    Q11: 'Every enabled authentication provider returns correctly',
    Q12: 'Same link is denied while stopped and restored after enable',
    Q13: 'Registration and login preserve the shared note destination',
    Q14: 'Local unconfirmed edits can be recovered after immediate revocation without replay',
    CURSOR: 'Remote names stay visible above their cursor for more than two seconds'
  }
  const requiredChecks = {
    Q1: ['desktop-share-entry', 'mobile-share-entry', 'share-end-to-end-concurrent-editing'],
    Q2: ['guest-login-prompt-auto-opens', 'login-retry-returns-original-note', 'login-revocation-during-auth'],
    Q3: ['remote-owner-profile-name', 'owner-sees-remote-account-name'],
    Q4: ['collaborator-no-self-label', 'owner-sees-remote-account-name'],
    Q5: ['different-account-cursor-colors', 'active-session-color-reconnect-stability'],
    Q6: ['share-owner-controls', 'nonowner-direct-permission-event-rejected'],
    Q7: ['share-owner-controls', 'private-note-api-rejects-nonowner-update', 'revoked-socket-content-and-operation-denial'],
    Q8: ['share-copy-no-permission-change', 'share-permission-save-confirmation', 'share-clipboard-fallback'],
    Q9: ['remote-blur-keeps-dimmed-cursor', 'blurred-collaborator-stays-dimmed', 'idle-and-new-join-cursor-state'],
    Q10: ['same-name-disambiguation-fixtures'],
    Q11: ['login-retry-returns-original-note', 'enabled-auth-provider-return-coverage'],
    Q12: ['share-stop-and-reenable-same-link'],
    Q13: ['registration-retry-preserves-destination', 'fresh-registration-returns-to-note'],
    Q14: ['recover-unconfirmed-local-changes', 'unconfirmed-edit-export-and-no-replay'],
    CURSOR: ['remote-label-persists', 'remote-label-above-cursor']
  }
  for (const [requirement, ids] of Object.entries(requiredChecks)) {
    for (const id of ids) {
      if (!checks.some(c => c.id === id)) checks.push({ id, requirements: [requirement], lane: 'feature', actor: 'coverage', status: 'BLOCKED', reason: 'No recorded execution for this required acceptance check.' })
    }
  }
  // A component or legacy diagnostic alone never grants full requirement acceptance.
  const requirements = Object.entries(mandatory).map(([id, description]) => {
    const required = requiredChecks[id].map(checkId => checks.find(c => c.id === checkId))
    const relevant = checks.filter(c => (c.requirements || []).includes(id) || requiredChecks[id].includes(c.id))
    const feature = relevant.filter(c => c.lane === 'feature')
    const failed = feature.some(c => c.status === 'FAIL')
    const complete = required.every(c => c && c.lane === 'feature' && c.status === 'PASS')
    const status = failed ? 'FAIL' : complete ? 'PASS' : 'BLOCKED'
    return { id, description, status, checks: relevant.map(c => c.id), reason: failed ? 'A required feature assertion failed.' : complete ? 'All required feature checks passed.' : 'Full acceptance is unproven; component or legacy diagnostics do not certify the complete requirement.' }
  })
  const accepted = requirements.every(r => r.status === 'PASS') && !checks.some(c => c.status === 'FAIL' || c.lane === 'execution')
  const summary = { runId: manifest.runId, baseURL: manifest.baseURL, verdict: accepted ? 'ACCEPTED' : 'NOT_FULLY_ACCEPTED', accounts: manifest.accounts, requirements, checks, totals: Object.fromEntries(['PASS', 'FAIL', 'BLOCKED'].map(status => [status, checks.filter(c => c.status === status).length])) }
  writeJSON(path.join(manifest.artifactDir, 'results.json'), summary)
  const lines = ['# 分享功能雙帳號自動化驗收', '', 'Run: `' + manifest.runId + '`', '', accepted ? '結論：所有已定義的必要驗收均通過。' : '結論：尚未完全達到已確認需求。', '', 'PASS 僅代表該項觀察通過；baseline 為既有功能診斷，不能替代分享入口的端到端驗收。', '', '| 需求 | 結果 | 說明 |', '| --- | --- | --- |', ...requirements.map(r => '| ' + r.id + ' | ' + r.status + ' | ' + r.description + ' |'), '', '| 檢查 | 階段 | 結果 | 證據或原因 |', '| --- | --- | --- | --- |']
  const safeCell = value => String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  for (const c of checks) lines.push('| ' + safeCell(c.id) + ' | ' + safeCell(c.lane) + ' | ' + c.status + ' | ' + safeCell(c.reason || JSON.stringify(c.details || {})) + ' |')
  lines.push('', '## 原始 PNG 證據', '')
  const images = []
  for (const role of ['owner', 'collaborator', 'coordinator']) {
    const directory = path.join(manifest.artifactDir, role)
    if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.png'))) {
        const bytes = fs.readFileSync(path.join(directory, name))
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Evidence is not a PNG: ' + name)
        images.push({ file: role + '/' + name, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
        lines.push('- [' + role + '/' + name + '](' + role + '/' + name + ')')
      }
    }
  }
  writeJSON(path.join(manifest.artifactDir, 'evidence-index.json'), { runId: manifest.runId, images })
  fs.writeFileSync(path.join(manifest.artifactDir, 'report.md'), lines.join('\n') + '\n')
  console.log(JSON.stringify({ runId: manifest.runId, verdict: summary.verdict, totals: summary.totals, report: path.join(manifest.artifactDir, 'report.md') }))
  return accepted ? 0 : 1
}

async function main () {
  const options = argumentsFor(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: bin/check-sharing-collaboration --credentials /private/accounts.json [--provision] [--keep-note]\nPrivate JSON shape: {"owner":{"email":"...","password":"..."},"collaborator":{"email":"...","password":"..."}}\n--prepare creates a private manifest; --actor owner|collaborator --run-dir PATH runs an isolated actor; --finalize --run-dir PATH aggregates evidence; --cleanup --run-dir PATH removes only its verified fixture.\nThe verifier never implements app features or treats missing/dependent checks as passing. Exit 1 means acceptance failed or is incomplete.\nSet CODIMD_PLAYWRIGHT_MODULE and CODIMD_BROWSER_EXECUTABLE if Playwright/browser are installed outside the project.')
    return 0
  }
  if (process.versions.node !== '16.20.2') throw new Error('Run with Node v16.20.2 using bin/check-sharing-collaboration.')
  if (options.actor) return actor(options.actor, loadManifest(options['run-dir']))
  if (options.finalize) return finalize(loadManifest(options['run-dir']))
  if (options.cleanup) {
    const results = await additionalChecks(loadManifest(options['run-dir']), true)
    return results.length && results.every(check => check.status === 'PASS') ? 0 : 1
  }
  const manifest = await prepare(options)
  console.log(JSON.stringify({ runId: manifest.runId, runDir: manifest.runDir, artifactDir: manifest.artifactDir }))
  if (options.prepare) return 0
  // Concurrent isolated browsers share only explicit phase signals, not login cookies.
  // In-process signals also avoid cross-tool filesystem observation delays.
  const sharedSignals = { values: new Map(), waiters: new Map() }
  await Promise.all(['owner', 'collaborator'].map(role => actor(role, manifest, sharedSignals)))
  return finalize(manifest)
}

if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => { console.error('Verifier error: ' + error.message); process.exitCode = 2 })

module.exports = { argumentsFor, credentials, redact, writeJSON, finalize }
