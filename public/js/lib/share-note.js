/* eslint-env browser, jquery */

/**
 * Share dialog for collaborative editing. It never changes permissions by itself:
 * opening and copying are read-only, enabling and stopping wait for the server.
 *
 * @param {object} options
 * @param {JQuery} options.modal
 * @param {() => string} options.getEditorUrl
 * @param {() => { permission: ?string, isOwner: boolean, connected: boolean }} options.getContext
 * @param {(permission: string) => Promise<{ ok: boolean, permission?: string, code?: string }>} options.changePermission
 */
export default function setupShareNote ({ modal, getEditorUrl, getContext, changePermission }) {
  // 'ready' | 'saving' | 'error'
  let phase = 'ready'
  const urlInput = modal.find('.ui-share-url')
  const status = modal.find('.ui-share-status')
  const copyStatus = modal.find('.ui-share-copy-status')

  function message (key) {
    return modal.find('.ui-share-messages [data-message="' + key + '"]').text()
  }

  function show (element, text, tone) {
    element.text(text || '').attr('data-tone', tone || '')
  }

  function render () {
    const context = getContext()
    urlInput.val(getEditorUrl())
    modal.find('.share-scope [data-permission]').each(function () {
      $(this).toggle($(this).attr('data-permission') === context.permission)
    })
    modal.find('.ui-share-owner-controls').toggle(context.isOwner)
    const shared = context.permission === 'limited'
    modal.find('.ui-share-enable, .ui-share-enable-hint').toggle(!shared)
    modal.find('.ui-share-stop, .ui-share-stop-hint').toggle(context.permission !== 'private')
    modal.find('.ui-share-enable, .ui-share-stop').prop('disabled', phase === 'saving' || !context.connected)
    if (!context.connected) show(status, message('offline'), 'warning')
    else if (status.attr('data-tone') === 'warning' && phase !== 'error') show(status, '')
  }

  function save (permission, successKey) {
    phase = 'saving'
    show(status, message('saving'), 'info')
    render()
    changePermission(permission).then(result => {
      if (result.ok) {
        phase = 'ready'
        show(status, message(successKey), 'success')
      } else {
        phase = 'error'
        show(status, message(result.code === 'timeout' ? 'unconfirmed' : 'failed'), 'danger')
      }
      render()
    })
  }

  function copyFailed () {
    urlInput.trigger('focus').trigger('select')
    show(copyStatus, message('copy-failed'), 'warning')
  }

  modal.find('.ui-share-copy').on('click', function () {
    const url = urlInput.val()
    show(copyStatus, '')
    if (!navigator.clipboard || !navigator.clipboard.writeText) return copyFailed()
    navigator.clipboard.writeText(url).then(() => show(copyStatus, message('copied'), 'success'), copyFailed)
  })
  urlInput.on('focus click', function () { this.select() })
  modal.find('.ui-share-enable').on('click', () => save('limited', 'enabled'))
  modal.find('.ui-share-stop').on('click', () => save('private', 'stopped'))
  modal.on('show.bs.modal', function () {
    if (phase !== 'saving') {
      phase = 'ready'
      show(status, '')
    }
    show(copyStatus, '')
    render()
  })

  return { render }
}
