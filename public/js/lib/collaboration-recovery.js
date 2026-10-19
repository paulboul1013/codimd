/* eslint-env browser, jquery */

/**
 * Local edits the server had not confirmed when access was revoked.
 * The outstanding edit was sent and may already be saved; `buffered` edits never left this page.
 *
 * @typedef {{ hasChanges: false } | {
 *   hasChanges: true,
 *   localText: string,
 *   fragments: string[],
 *   deletedCharacters: number,
 *   buffered: boolean
 * }} PendingChanges
 */

/**
 * Read the unconfirmed operations from the OT client state. Only data this page
 * already holds is used; nothing is fetched from the server.
 *
 * @param {?{ state: { outstanding?: object, buffer?: object } }} client
 * @param {string} localText the editor text, which already contains the pending edits
 * @returns {PendingChanges}
 */
export function collectPendingChanges (client, localText) {
  const state = client && client.state
  if (!state || !state.outstanding) return { hasChanges: false }
  const operation = state.buffer ? state.outstanding.compose(state.buffer) : state.outstanding
  const fragments = []
  let deletedCharacters = 0
  let index = 0
  operation.ops.forEach(op => {
    if (typeof op === 'string') {
      fragments.push(localText.slice(index, index + op.length))
      index += op.length
    } else if (op > 0) {
      index += op
    } else {
      deletedCharacters -= op
    }
  })
  return {
    hasChanges: true,
    localText,
    fragments: fragments.filter(fragment => fragment.length > 0),
    deletedCharacters,
    buffered: !!state.buffer
  }
}

/**
 * Replace the editing surface with the revocation notice and manual recovery.
 *
 * @param {JQuery} panel
 * @param {PendingChanges} pending
 * @param {string} filename
 */
export function showRevokedPanel (panel, pending, filename) {
  const recovery = panel.find('.ui-revoked-recovery')
  recovery.toggle(pending.hasChanges)
  if (pending.hasChanges) {
    const changes = pending.fragments.join('\n\n')
    panel.find('.ui-revoked-changes').val(changes)
    panel.find('.ui-revoked-deleted').toggle(pending.deletedCharacters > 0)
    panel.find('.ui-revoked-deleted-count').text(pending.deletedCharacters)
    const status = panel.find('.ui-revoked-copy-status')
    panel.find('.ui-revoked-copy').off('click').on('click', function () {
      const failed = () => {
        panel.find('.ui-revoked-changes').trigger('focus').trigger('select')
        status.text(status.attr('data-failed'))
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) return failed()
      navigator.clipboard.writeText(changes).then(() => status.text(status.attr('data-copied')), failed)
    })
    panel.find('.ui-revoked-download').off('click').on('click', function () {
      const url = URL.createObjectURL(new Blob([pending.localText], { type: 'text/markdown;charset=utf-8' }))
      const link = $('<a>').attr({ href: url, download: filename }).appendTo('body')
      link[0].click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
    panel.find('.ui-revoked-changes').on('focus click', function () { this.select() })
  }
  panel.prop('hidden', false)
}
