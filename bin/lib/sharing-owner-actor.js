/* eslint-env node, browser */
'use strict'

const assert = require('assert')

// The coordinator owns credentials, browser lifetime, result files and cleanup.
module.exports = async function sharingOwnerActor (h) {
  const page = h.page
  const share = h.share
  const marker = 'sharing-fixture-' + h.runId
  const ownerMarker = 'owner-edit-' + h.runId
  const desktop = page.viewportSize() || { width: 1440, height: 1000 }
  let noteURL
  const myNoteCount = async () => {
    const response = await page.request.get(h.baseURL + '/api/notes/myNotes')
    return ((await response.json()).myNotes || []).length
  }
  const reloadPermission = async () => {
    await page.reload()
    await h.editorReady()
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[id^="permissionLabel"]')).some(node => node.style.display !== 'none'))
    return h.headerPermission()
  }
  try {
    await page.goto(h.baseURL + '/new')
    await h.editorReady()
    noteURL = page.url().split('?')[0].split('#')[0]
    await h.signal('fixture-created', { noteURL, marker })
    await h.append('\n# Sharing verification ' + h.runId + '\n\n' + marker + '\n')
    await h.waitText(marker)
    const notesBefore = await myNoteCount()

    const desktopEvidence = await h.capture('owner-desktop-header')
    await h.check('desktop-share-entry', ['Q1', 'Q8', 'desktop-entry'], 'feature', async () => {
      const entries = await page.locator('.navbar-collapse .ui-share:visible').count()
      assert.strictEqual(entries, 1, 'Expected a visible Share entry between Publish and Menu. Evidence: ' + desktopEvidence)
      const ordered = await page.locator('.navbar-collapse .ui-share:visible').evaluate(entry => {
        const li = entry.closest('li')
        const before = li && li.previousElementSibling
        const after = li && li.nextElementSibling
        return Boolean(before && before.querySelector('.ui-publish') && after && after.querySelector('a[data-toggle="dropdown"]'))
      })
      assert(ordered, 'Share is not between Publish and Menu. Evidence: ' + desktopEvidence)
      return { screenshot: desktopEvidence, shareEntries: entries, order: 'Publish, Share, Menu' }
    })

    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.navbar-header .nav-mobile.pull-right a[data-toggle="dropdown"]').click()
      const evidence = await h.capture('owner-mobile-menu')
      await h.check('mobile-share-entry', ['Q1', 'mobile-entry'], 'feature', async () => {
        assert.strictEqual(await page.locator('.navbar-header .nav-mobile .ui-share:visible').count(), 1,
          'Expected a visible Share entry in the mobile menu. Evidence: ' + evidence)
        await share.open('.navbar-header .nav-mobile .ui-share')
        const state = await share.state()
        assert.strictEqual(state.url, noteURL + '?both', 'Mobile Share dialog does not show this note editing link')
        const modalEvidence = await h.capture('owner-mobile-share-modal')
        await share.close()
        return { screenshot: evidence, dialog: modalEvidence, state }
      })
    } finally {
      // Phone width switches the editor to a single pane; reopen the editing link at desktop size.
      await page.setViewportSize(desktop)
      await page.goto(noteURL + '?both')
      await h.editorReady()
    }

    await h.check('share-owner-controls', ['Q6', 'Q7', 'Q8'], 'feature', async () => {
      await share.open()
      const initial = await share.state()
      assert(initial.ownerControls && initial.enable && initial.stop, 'Owner does not see both enable and stop controls: ' + JSON.stringify(initial))
      assert.strictEqual(initial.url, noteURL + '?both')
      const stopped = await share.act('stop', 'stopped')
      const after = await share.state()
      assert.deepStrictEqual(after.scope, ['private'], 'Dialog does not show the private scope after stopping')
      assert(after.enable && !after.stop, 'Stopped dialog must offer enable only')
      const evidence = await h.capture('owner-share-stopped')
      await share.close()
      assert.strictEqual(await reloadPermission(), 'private', 'Stop sharing was not persisted by the server')
      return { initial, stoppedStatus: stopped, after, screenshot: evidence }
    })

    await h.check('share-copy-no-permission-change', ['Q8'], 'feature', async () => {
      await share.open()
      await page.evaluate(() => navigator.clipboard.writeText('clipboard-before-copy'))
      await share.modal.locator('.ui-share-copy').click()
      const copied = await share.message('copied')
      await page.waitForFunction(text => document.querySelector('#shareModal .ui-share-copy-status').textContent === text, copied)
      const clipboard = await page.evaluate(() => navigator.clipboard.readText())
      assert.strictEqual(clipboard, noteURL + '?both', 'Clipboard does not hold the editing link')
      const evidence = await h.capture('owner-share-copied-private')
      await share.close()
      await h.signal('private-link-copied', { link: clipboard })
      const probe = await h.wait('collaborator-private-probe')
      assert.strictEqual(probe.status, 403, 'Copying the link opened a private note to another account')
      assert.strictEqual(await reloadPermission(), 'private', 'Opening the dialog or copying changed the permission')
      return { clipboard, otherAccountStatus: probe.status, permission: 'private', screenshot: evidence }
    })

    await h.check('share-clipboard-fallback', ['copy-failure'], 'feature', async () => {
      await share.open()
      // Simulates a browser that denies clipboard writes; the app UI itself is untouched.
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied by verifier')) }))
      await share.modal.locator('.ui-share-copy').click()
      const failed = await share.message('copy-failed')
      await page.waitForFunction(text => document.querySelector('#shareModal .ui-share-copy-status').textContent === text, failed)
      const selection = await page.evaluate(() => {
        const input = document.querySelector('#shareModal .ui-share-url')
        return { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, length: input.value.length }
      })
      assert(selection.focused && selection.start === 0 && selection.end === selection.length, 'Link is not selected for manual copy: ' + JSON.stringify(selection))
      const evidence = await h.capture('owner-share-copy-failed')
      await share.close()
      return { status: failed, selection, screenshot: evidence }
    })
    await reloadPermission()

    await h.check('share-permission-save-confirmation', ['permission-confirmation', 'Q8'], 'feature', async () => {
      await share.open()
      h.socketFilter.block('permission')
      await share.modal.locator('.ui-share-enable').click()
      const saving = await share.status()
      const disabled = await share.modal.locator('.ui-share-enable').isDisabled()
      assert.strictEqual(saving, await share.message('saving'), 'No saving state while waiting for the server')
      assert(disabled, 'Enable stays clickable while a save is pending')
      const unconfirmed = await share.message('unconfirmed')
      await page.waitForFunction(text => document.querySelector('#shareModal .ui-share-status').textContent === text, unconfirmed, { timeout: 15000 })
      const lostEvidence = await h.capture('owner-share-unconfirmed')
      assert.notStrictEqual(await h.headerPermission(), 'limited', 'UI claimed the unconfirmed change')
      h.socketFilter.allow('permission')
      const enabled = await share.act('enable', 'enabled')
      const after = await share.state()
      assert.deepStrictEqual(after.scope, ['limited'])
      const evidence = await h.capture('owner-share-enabled')
      await share.close()
      assert.strictEqual(await reloadPermission(), 'limited', 'Enable was reported but not persisted')
      return { saving, unconfirmed, enabled, screenshots: [lostEvidence, evidence] }
    })

    await h.signal('owner-ready', { noteURL, editorURL: noteURL + '?both', marker, ownerName: h.me.name })
    await h.wait('collaborator-ready')

    // Both accounts type into the same paragraph at the same moment.
    const go = await h.wait('concurrent-ready')
    await page.locator('.CodeMirror').click()
    await page.evaluate(text => {
      const line = window.editor.getValue().split('\n').indexOf(text)
      window.editor.focus()
      window.editor.setCursor({ line, ch: text.length })
    }, marker)
    await h.signal('owner-concurrent-start', {})
    const ownerConcurrent = ' owner-concurrent-' + h.runId
    await page.keyboard.type(ownerConcurrent, { delay: 15 })
    await h.check('share-end-to-end-concurrent-editing', ['Q1', 'simultaneous-editing'], 'feature', async () => {
      await h.waitText(go.text)
      await page.waitForTimeout(1500)
      const text = await h.text()
      const line = text.split('\n').find(value => value.includes(marker))
      assert(line.includes(ownerConcurrent) && line.includes(go.text), 'Concurrent edits did not both land in the shared paragraph: ' + line)
      const peer = await h.wait('collaborator-concurrent-text')
      assert.strictEqual(peer.text, text, 'The two editors did not converge to the same text')
      let saved = ''
      for (let attempt = 0; attempt < 40 && saved !== text; attempt++) {
        saved = await (await page.request.get(noteURL + '/download')).text()
        if (saved !== text) await page.waitForTimeout(500)
      }
      assert.strictEqual(saved, text, 'The server copy differs from the converged editors')
      return { paragraph: line, converged: true, savedMatches: true, screenshot: await h.capture('owner-concurrent-converged') }
    })
    await h.signal('owner-concurrent-done', {})

    await h.append('\n' + ownerMarker + '\n')
    await h.signal('owner-typed', { marker: ownerMarker })
    const collaborator = await h.wait('collaborator-typed')
    await h.check('owner-receives-collaborator-edit', ['simultaneous-editing'], 'feature', async () => {
      await h.waitText(collaborator.marker.trim())
      const text = await h.text()
      assert(text.includes(marker) && text.includes(ownerMarker), 'Owner lost fixture or own edit')
      return { ownerMarker, collaboratorMarker: collaborator.marker, screenshot: await h.capture('owner-converged-edits') }
    })

    await page.locator('.CodeMirror').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('ArrowLeft')
    await h.signal('owner-cursor', { ownerName: h.me.name })
    await h.wait('collaborator-cursor-ready')
    const cursorState = async () => page.locator('.CodeMirror-other-cursor').evaluateAll((nodes, remoteName) => {
      const node = nodes.find(node => {
        const name = node.querySelector('.cursortag .name')
        return name && name.textContent === remoteName
      })
      if (!node) return { visible: false, opacity: 0, name: null }
      let opacity = 1
      let visible = true
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        opacity *= Number(style.opacity)
        if (style.display === 'none' || style.visibility === 'hidden') visible = false
      }
      const tag = node.querySelector('.cursortag')
      const rect = node.getBoundingClientRect()
      const tagRect = tag.getBoundingClientRect()
      const tagStyle = getComputedStyle(tag)
      return {
        name: remoteName,
        visible: visible && opacity > 0 && (rect.height > 0 || rect.width > 0),
        opacity,
        tagVisible: tagRect.width > 0 && tagRect.height > 0 && tagStyle.display !== 'none' && tagStyle.visibility !== 'hidden' && Number(tagStyle.opacity) > 0,
        color: getComputedStyle(node.querySelector('.cursorbar')).borderLeftColor
      }
    }, h.accounts.collaborator.name)
    const activeCursor = await cursorState()
    const cursorEvidence = await h.capture('owner-remote-cursor')
    await h.check('owner-sees-remote-account-name', ['Q3', 'Q4', 'remote-cursor-name'], 'feature', async () => {
      assert(activeCursor.name === h.accounts.collaborator.name && activeCursor.tagVisible && activeCursor.visible,
        'Remote account name is not visibly present. Observed: ' + JSON.stringify(activeCursor) + '. Evidence: ' + cursorEvidence)
      const names = await page.locator('.CodeMirror-other-cursor .name').allTextContents()
      assert(!names.includes(h.me.name), 'Local account has a remote cursor tag')
      return { cursor: activeCursor, screenshot: cursorEvidence }
    })
    await h.signal('owner-observed-cursor', activeCursor)
    await h.wait('collaborator-blurred')
    await page.waitForTimeout(600)
    const blurredCursor = await cursorState()
    const blurredEvidence = await h.capture('owner-remote-cursor-blurred')
    await h.check('remote-blur-keeps-dimmed-cursor', ['Q9'], 'feature', async () => {
      assert(activeCursor.visible, 'No visible active remote cursor was available for comparison')
      assert(blurredCursor.visible && blurredCursor.tagVisible,
        'Blurred remote cursor and name must remain visible. Observed: ' + JSON.stringify(blurredCursor) + '. Evidence: ' + blurredEvidence)
      assert(blurredCursor.opacity > 0 && blurredCursor.opacity < activeCursor.opacity,
        'Blurred remote cursor must be dimmer than its active state. Evidence: ' + blurredEvidence)
      return { before: activeCursor, after: blurredCursor, screenshot: blurredEvidence }
    })
    await h.signal('owner-observed-blur', { visible: blurredCursor.visible, tagVisible: blurredCursor.tagVisible, opacity: blurredCursor.opacity, beforeOpacity: activeCursor.opacity, color: activeCursor.color })
    const reconnected = await h.wait('collaborator-reconnected')
    await h.check('owner-sees-stable-color-after-reconnect', ['Q5'], 'feature', async () => {
      await page.waitForFunction(name => Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).some(node => node.textContent === name), h.accounts.collaborator.name)
      const after = await cursorState()
      assert.strictEqual(after.color, activeCursor.color, 'Collaborator color changed after a real socket reconnect')
      assert.strictEqual(after.color, reconnected.selfColor, 'Owner and collaborator disagree on the collaborator color')
      return { before: activeCursor.color, after: after.color, screenshot: await h.capture('owner-color-after-reconnect') }
    })
    await h.signal('owner-color-checked', {})

    await h.wait('collaborator-pending')
    let revokedAt
    await h.check('share-stop-revokes-live-collaborator', ['Q7', 'Q12'], 'feature', async () => {
      await share.open()
      revokedAt = h.now()
      const stopped = await share.act('stop', 'stopped')
      const evidence = await h.capture('owner-share-stop-live')
      await share.close()
      return { status: stopped, screenshot: evidence }
    })
    await h.signal('revoked', { noteURL, at: revokedAt })
    const revokedPeer = await h.wait('collaborator-revoked')
    await h.check('owner-room-survives-revocation', ['Q7', 'owner-room-survives-http-reload'], 'feature', async () => {
      await page.waitForFunction(name => !Array.from(document.querySelectorAll('.CodeMirror-other-cursor .name')).some(node => node.textContent === name), h.accounts.collaborator.name, { timeout: 15000 })
      const afterRevoke = 'owner-after-revoke-' + h.runId
      await h.append('\n' + afterRevoke + '\n')
      await h.waitText(afterRevoke)
      let persisted = ''
      for (let attempt = 0; attempt < 40 && !persisted.includes(afterRevoke); attempt++) {
        const download = await page.request.get(noteURL + '/download')
        assert.strictEqual(download.status(), 200, 'Owner download denied after revocation')
        persisted = await download.text()
        if (!persisted.includes(afterRevoke)) await page.waitForTimeout(500)
      }
      assert(persisted.includes(afterRevoke), 'Owner edit after revocation did not persist')
      assert(!persisted.includes(revokedPeer.unconfirmedText), 'The revoked collaborator unconfirmed edit reached the server')
      assert(!persisted.includes(revokedPeer.rawOperationText), 'A revoked socket operation reached the server')
      return { remoteCursorRemoved: true, screenshot: await h.capture('owner-after-revocation') }
    })

    await h.check('share-stop-and-reenable-same-link', ['Q12'], 'feature', async () => {
      await share.open()
      const enabled = await share.act('enable', 'enabled')
      const state = await share.state()
      await share.close()
      assert.strictEqual(state.url, noteURL + '?both', 'Re-enabling changed the editing link')
      await h.signal('reopened', { noteURL })
      const rejoined = await h.wait('collaborator-rejoined')
      assert.strictEqual(rejoined.path, new URL(noteURL).pathname, 'Collaborator rejoined a different note')
      assert.strictEqual(await myNoteCount(), notesBefore, 'Sharing created another note')
      return { status: enabled, link: state.url, oldLinkDeniedWhileStopped: revokedPeer.oldLinkStatus, notes: notesBefore, screenshot: await h.capture('owner-reenabled') }
    })
    await h.signal('owner-done', { noteURL, screenshot: await h.capture('owner-final') })
    return { noteURL, marker }
  } catch (error) {
    await h.signal('owner-failed', { message: error.message, noteURL })
    throw error
  }
}
