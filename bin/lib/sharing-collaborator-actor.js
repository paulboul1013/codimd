/* eslint-env node, browser */
'use strict'

const assert = require('assert').strict

// Read rendered state only. Never change cursor styles to make a check pass.
async function cursorSnapshot (page) {
  return page.evaluate(() => {
    function visibleState (element) {
      if (!element) return { visible: false, opacity: 0 }
      let opacity = 1
      let visible = true
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        opacity *= Number(style.opacity)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') visible = false
      }
      const bounds = element.getBoundingClientRect()
      return { visible: visible && opacity > 0.01 && bounds.width > 0 && bounds.height > 0, opacity }
    }
    function bounds (element) {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    }
    return {
      cursors: Array.from(document.querySelectorAll('.CodeMirror-other-cursor[data-clientid]')).map(element => {
        const tag = element.querySelector('.cursortag')
        const bar = element.querySelector('.cursorbar')
        return {
          clientId: element.dataset.clientid,
          name: tag && tag.querySelector('.name') ? tag.querySelector('.name').textContent.trim() : null,
          cursor: visibleState(bar || element),
          tag: visibleState(tag),
          tagBounds: bounds(tag),
          barBounds: bounds(bar),
          color: bar ? window.getComputedStyle(bar).borderLeftColor : null
        }
      }),
      participants: Array.from(document.querySelectorAll('#online-user-list .ui-user-item')).map(element => {
        const name = element.querySelector('.ui-user-name')
        const icon = element.querySelector('.ui-user-icon')
        const iconStyle = icon ? window.getComputedStyle(icon) : null
        const itemStyle = window.getComputedStyle(element)
        const hasColorBorder = itemStyle.borderLeftStyle !== 'none' && parseFloat(itemStyle.borderLeftWidth) > 0
        return {
          name: name ? name.textContent.trim() : null,
          color: hasColorBorder ? itemStyle.borderLeftColor : iconStyle && iconStyle.backgroundColor,
          colorSource: hasColorBorder ? 'participant-border' : 'icon-background'
        }
      })
    }
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async function collaboratorActor (h) {
  const { page } = h
  page.on('dialog', dialog => dialog.accept())
  const copied = await h.wait('private-link-copied')
  const privateProbe = await page.request.get(copied.link, { maxRedirects: 0 })
  await h.signal('collaborator-private-probe', { status: privateProbe.status() })

  const owner = await h.wait('owner-ready')
  const noteURL = owner.noteURL
  const notePath = new URL(noteURL).pathname
  const editorURL = owner.editorURL
  assert.equal(editorURL, copied.link, 'The shared link changed between copy and enable')
  await page.goto(editorURL)
  await h.editorReady()
  await h.check('collaborator-same-document', ['Q1'], 'feature', async () => {
    await h.waitText(owner.marker)
    assert.equal(new URL(page.url()).pathname, notePath)
    return { noteURL, initialMarkerObserved: true }
  })
  await h.capture('collaborator-joined')

  const raw = await h.rawSocket(notePath.slice(1))
  await raw.waitFor('doc')
  await h.check('nonowner-direct-permission-event-rejected', ['Q6'], 'feature', async () => {
    const reply = await raw.ack('permission', 'private')
    assert.deepEqual(reply, { ok: false, code: 'forbidden' }, 'A nonowner permission event was not rejected')
    const download = await page.request.get(noteURL + '/download', { maxRedirects: 0 })
    assert.equal(download.status(), 200, 'The nonowner event changed the shared permission')
    return { acknowledgement: reply, stillShared: true }
  })
  await h.signal('collaborator-ready', { noteURL })

  const concurrent = 'collab-concurrent-' + h.runId + ' '
  await page.locator('.CodeMirror').click()
  await page.evaluate(text => {
    const line = window.editor.getValue().split('\n').indexOf(text)
    window.editor.focus()
    window.editor.setCursor({ line, ch: 0 })
  }, owner.marker)
  await h.signal('concurrent-ready', { text: concurrent.trim() })
  await h.wait('owner-concurrent-start')
  await page.keyboard.type(concurrent, { delay: 15 })
  await h.waitText(' owner-concurrent-' + h.runId)
  await page.waitForTimeout(1500)
  await h.signal('collaborator-concurrent-text', { text: await h.text() })
  await h.capture('collaborator-concurrent-converged')
  await h.wait('owner-concurrent-done')

  const ownerTyped = await h.wait('owner-typed')
  await h.check('owner-edits-arrive-at-collaborator', ['simultaneous-editing'], 'feature', async () => {
    await h.waitText(ownerTyped.marker)
    return { marker: ownerTyped.marker }
  })
  const marker = '\nCollaborator ' + h.runId + '\n'
  await h.append(marker)
  await h.signal('collaborator-typed', { marker })

  await h.wait('owner-cursor')
  await page.locator('.CodeMirror').click({ position: { x: 180, y: 90 } })
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.mouse.move(1100, 650)
  await page.waitForTimeout(250)
  await h.signal('collaborator-cursor-ready', {})
  await h.wait('owner-observed-cursor')
  const initial = await cursorSnapshot(page)
  await h.capture('collaborator-remote-cursor-initial')
  const ownerName = owner.ownerName || h.accounts.owner.name
  await h.check('remote-owner-profile-name', ['Q3'], 'feature', async () => {
    assert(initial.cursors.some(cursor => cursor.name === ownerName && cursor.tag.visible), 'No visible remote cursor with the server owner display name')
    return initial
  })
  await h.check('collaborator-no-self-label', ['Q4'], 'feature', async () => {
    assert(!initial.cursors.some(cursor => cursor.name === h.me.name && cursor.tag.visible), 'A visible label repeats this account name on a remote cursor')
    assert(initial.participants.some(participant => participant.name === h.me.name), 'Local account identity is absent from the participant list')
    assert(initial.cursors.some(cursor => cursor.name === ownerName && cursor.cursor.visible), 'No visible remote owner cursor to compare against the local cursor')
    return initial
  })
  const colors = snapshot => ({
    self: (snapshot.participants.find(participant => participant.name === h.me.name) || {}).color,
    remote: (snapshot.participants.find(participant => participant.name === ownerName) || {}).color,
    cursor: (snapshot.cursors.find(cursor => cursor.name === ownerName) || {}).color
  })
  const before = colors(initial)
  await h.check('different-account-cursor-colors', ['Q5'], 'feature', async () => {
    assert(before.self && before.remote && before.cursor, 'Missing participant or remote cursor color')
    assert.notEqual(before.self, before.remote, 'Both accounts have the same rendered color')
    assert.equal(before.cursor, before.remote, 'Remote cursor color differs from its participant color')
    return { localColor: before.self, remoteColor: before.remote, cursorColor: before.cursor }
  })
  await page.waitForTimeout(2800)
  const persistent = await cursorSnapshot(page)
  await h.capture('collaborator-remote-cursor-after-three-seconds')
  await h.check('remote-label-persists', ['persistent-name'], 'feature', async () => {
    assert(persistent.cursors.some(cursor => cursor.name === ownerName && cursor.tag.visible), 'Remote name label vanished after more than two seconds')
    return persistent
  })
  await h.check('remote-label-above-cursor', ['name-above-cursor'], 'feature', async () => {
    const cursor = initial.cursors.find(cursor => cursor.name === ownerName)
    assert(cursor && cursor.tag.visible && cursor.tagBounds && cursor.barBounds, 'Remote name was not visibly positioned')
    assert(cursor.tagBounds.bottom <= cursor.barBounds.top + 2, 'Name label appears below or across the cursor instead of above it')
    return cursor
  })

  await page.locator('#doc').click({ position: { x: 100, y: 80 } })
  await h.signal('collaborator-blurred', {})
  const blur = await h.wait('owner-observed-blur')
  await h.check('blurred-collaborator-stays-dimmed', ['Q9'], 'feature', async () => {
    assert(blur.visible, 'The remote collaborator cursor disappears after editor blur')
    assert(blur.tagVisible, 'The remote collaborator name disappears after editor blur')
    assert(blur.opacity > 0 && blur.opacity < blur.beforeOpacity, 'The remote collaborator cursor is not dimmed')
    return blur
  })

  await page.reload()
  await h.editorReady()
  await page.locator('.CodeMirror').click({ position: { x: 180, y: 90 } })
  await page.waitForFunction(name => Array.from(document.querySelectorAll('#online-user-list .ui-user-name')).some(node => node.textContent.trim() === name), ownerName)
  await page.waitForTimeout(500)
  const after = colors(await cursorSnapshot(page))
  await h.check('active-session-color-reconnect-stability', ['Q5'], 'feature', async () => {
    assert.equal(after.self, before.self, 'This account got a different color after reconnecting')
    assert.equal(after.remote, before.remote, 'The owner color changed after this account reconnected')
    assert.equal(after.self, blur.color, 'The owner renders this account in a different color')
    return { before, after, screenshot: await h.capture('collaborator-color-after-reconnect') }
  })
  await h.signal('collaborator-reconnected', { selfColor: after.self })
  await h.wait('owner-color-checked')

  // Drop outgoing operations so this edit stays unconfirmed when access is revoked.
  const unconfirmedText = 'unconfirmed-local-' + h.runId
  const rawOperationText = 'raw-revoked-op-' + h.runId
  h.socketFilter.block('operation')
  await h.append('\n' + unconfirmedText)
  await page.waitForFunction(text => window.cmClient.state.outstanding && window.editor.getValue().includes(text), unconfirmedText)
  const base = await page.evaluate(text => {
    const value = window.editor.getValue()
    return { revision: window.cmClient.revision, length: value.length - text.length - 1 }
  }, unconfirmedText)
  raw.onInfo(() => {
    raw.emit('get_operations', 0, base.revision)
    raw.emit('operation', base.revision, [rawOperationText, base.length], null)
  })
  await h.signal('collaborator-pending', {})
  const revoked = await h.wait('revoked')

  await page.locator('.revoked-panel').waitFor({ state: 'visible', timeout: 15000 })
  await h.check('recover-unconfirmed-local-changes', ['Q14'], 'feature', async () => {
    const state = await page.evaluate(() => ({
      changes: document.querySelector('.ui-revoked-changes').value,
      recoveryVisible: document.querySelector('.ui-revoked-recovery').offsetParent !== null,
      contentHidden: document.querySelector('.ui-content').offsetParent === null,
      editorText: window.editor.getValue(),
      previewText: document.querySelector('.ui-view-area .markdown-body').textContent.trim()
    }))
    assert(state.recoveryVisible && state.changes.includes(unconfirmedText), 'Revocation did not offer the unconfirmed local edit')
    assert(state.contentHidden && state.editorText === '' && state.previewText === '', 'Note content stayed visible after revocation')
    const evidence = await h.capture('collaborator-revoked-recovery')
    await page.locator('.ui-revoked-copy').click()
    await page.waitForFunction(() => document.querySelector('.ui-revoked-copy-status').textContent.length > 0)
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    assert(clipboard.includes(unconfirmedText), 'Copying the unconfirmed changes did not reach the clipboard')
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.ui-revoked-download').click()])
    const file = require('fs').readFileSync(await download.path(), 'utf8')
    assert(file.includes(unconfirmedText) && file.includes(owner.marker), 'Downloaded local version lacks the pending edit')
    return { changes: state.changes, downloadName: download.suggestedFilename(), screenshot: evidence }
  })
  await page.waitForTimeout(2500)
  await h.check('collaborator-live-editing-stopped', ['Q7'], 'feature', async () => {
    const readOnly = await page.evaluate(() => window.editor.getOption('readOnly'))
    const sent = h.socketFilter.sentSince(revoked.at + 1000)
    assert(readOnly, 'The editor still accepts input after access was revoked')
    assert.deepEqual(sent, [], 'The revoked page kept sending socket events: ' + JSON.stringify(h.socketFilter.log().filter(item => item.at >= revoked.at - 500).map(item => [item.event, item.at - revoked.at, item.socket, item.blocked])))
    return { readOnly, eventsSentAfterRevocation: sent }
  })
  await h.check('revoked-socket-content-and-operation-denial', ['Q7'], 'feature', async () => {
    const info = raw.events.find(event => event.event === 'info')
    assert(info && info.args[0].code === 403, 'The open socket was not told about the revocation')
    const leaked = raw.events.filter(event => event.at >= info.at && ['doc', 'operations', 'operation', 'permission', 'online users', 'cursor activity', 'selection'].includes(event.event))
    assert.deepEqual(leaked.map(event => event.event), [], 'Revoked socket still received note data: ' + JSON.stringify(raw.events.filter(event => event.at >= info.at - 50).map(event => [event.event, event.at - info.at])))
    assert(raw.disconnected(), 'The revoked socket was not disconnected')
    const retry = await h.rawSocket(notePath.slice(1))
    await sleep(2000)
    const retried = retry.events.map(event => event.event)
    assert(retried.includes('info') && !retried.includes('doc'), 'Reconnecting after revocation was not refused: ' + retried.join(','))
    retry.close()
    return { revokedEvents: raw.events.filter(event => event.at >= info.at).map(event => event.event), retryEvents: retried, attemptedAfterRevoke: ['get_operations', 'operation'] }
  })
  raw.close()
  let oldLinkStatus
  await h.check('collaborator-download-denied-after-revoke', ['Q7'], 'feature', async () => {
    const response = await page.request.get(noteURL + '/download', { maxRedirects: 0 })
    assert.equal(response.status(), 403, 'Revoked account can still download the note')
    return { status: response.status() }
  })
  await h.check('old-link-denied-while-private', ['Q7', 'Q12'], 'feature', async () => {
    const response = await page.goto(editorURL)
    oldLinkStatus = response.status()
    assert.equal(oldLinkStatus, 403, 'Old editing link did not return forbidden while sharing is stopped')
    return { status: oldLinkStatus, screenshot: await h.capture('collaborator-old-link-denied') }
  })
  await h.signal('collaborator-revoked', { unconfirmedText, rawOperationText, oldLinkStatus })

  await h.wait('reopened')
  h.socketFilter.allow('operation')
  await page.goto(editorURL)
  await h.editorReady()
  await h.check('old-link-rejoins-same-document', ['Q12'], 'feature', async () => {
    await h.waitText(marker.trim())
    await h.waitText('owner-after-revoke-' + h.runId)
    assert.equal(new URL(page.url()).pathname, notePath)
    return { noteURL, currentServerTextLoaded: true, screenshot: await h.capture('collaborator-old-link-rejoined') }
  })
  await h.check('unconfirmed-edit-export-and-no-replay', ['Q14'], 'feature', async () => {
    await page.waitForTimeout(3000)
    const text = await h.text()
    const saved = await (await page.request.get(noteURL + '/download')).text()
    assert(!text.includes(unconfirmedText) && !saved.includes(unconfirmedText), 'The edit from before revocation was replayed')
    return { replayed: false }
  })
  await h.signal('collaborator-rejoined', { path: new URL(page.url()).pathname })
}
