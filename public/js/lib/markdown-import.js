/* eslint-env browser */
'use strict'

export default function setupMarkdownImport ({ input, button, error, serverURL, browser = window }) {
  const siteURL = new URL(browser.location.href)
  const baseURL = new URL(serverURL || '/', siteURL)
  const basePath = baseURL.pathname.replace(/\/$/, '')
  const createURL = new URL(basePath + '/new', baseURL.origin).href
  let busy = false

  function reset () {
    busy = false
    input.disabled = false
    button.disabled = false
    input.value = ''
  }

  function fail (message) {
    error.textContent = error.dataset[message]
    error.hidden = false
    reset()
  }

  button.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    if (busy) return
    const file = input.files[0]
    if (!file) return
    error.hidden = true
    if (!/\.(md|markdown|txt)$/i.test(file.name)) return fail('extension')

    busy = true
    input.disabled = true
    button.disabled = true
    try {
      const reader = new browser.FileReader()
      reader.onerror = () => fail('read')
      reader.onabort = () => fail('read')
      reader.onload = async () => {
        const body = reader.result
        if (!body.replace(/\r/g, '').length) return fail('empty')
        try {
          const response = await browser.fetch(createURL, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
            body
          })
          if (response.status === 413) return fail('tooLarge')
          if (response.status === 401 || response.status === 403) return fail('login')
          if (!response.ok) return fail('failed')

          const target = new URL(response.url)
          if (target.origin === baseURL.origin && (target.pathname === basePath || target.pathname === basePath + '/')) return fail('login')
          // /new returns a URL-safe base64 UUID, never an alias or an error route.
          const noteId = target.pathname.slice(basePath.length + 1)
          if (!response.redirected || target.origin !== siteURL.origin ||
              target.origin !== baseURL.origin || !target.pathname.startsWith(basePath + '/') ||
              !/^[A-Za-z0-9_-]{22}$/.test(noteId) || target.search || target.hash) return fail('failed')

          reset()
          browser.location.href = target.href
        } catch (err) {
          fail('network')
        }
      }
      reader.readAsText(file, 'UTF-8')
    } catch (err) {
      fail('read')
    }
  })
}
