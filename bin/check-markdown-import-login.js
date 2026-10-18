/* eslint-env node */
'use strict'

// Use a fresh browser session and an isolated server with allowAnonymous=false.
module.exports = async function checkExpiredLogin (page) {
  const home = page.url().replace(/\/$/, '')
  await page.context().addCookies([{ name: 'locale', value: 'zh-TW', url: home }])
  await page.goto(home)
  if (await page.locator('.ui-import-markdown').count()) throw new Error('Guest must not see the import button')
  const form = { email: 'expired-import-' + Date.now() + '@example.test', password: 'local-import-verification-only' }
  await page.request.post(home + '/register', { form })
  await page.request.post(home + '/login', { form })
  await page.goto(home)
  await page.locator('.ui-import-markdown').waitFor({ state: 'visible' })
  await page.context().clearCookies()
  let posts = 0
  const count = request => {
    if (request.method() === 'POST' && request.url() === home + '/new') posts++
  }
  page.on('request', count)
  try {
    await page.locator('.ui-markdown-file').setInputFiles('output/playwright/markdown-import-fixtures/article.MD')
    const error = page.locator('.ui-markdown-import-error')
    await error.waitFor({ state: 'visible' })
    if (!(await error.textContent()).includes('請先登入')) throw new Error('Missing login explanation')
    if (page.url().replace(/\/$/, '') !== home) throw new Error('Unexpected navigation after expired login')
    if (posts !== 1) throw new Error('Expired login must not retry creation')
    if (!await page.locator('.ui-import-markdown').isEnabled()) throw new Error('Import button was not restored')
    await page.screenshot({ path: 'output/playwright/markdown-import-login.png', fullPage: true })
    return { checks: 5, guestButtonHidden: true, loginExplained: true, stayedOnHistory: true, posts, controlsRestored: true }
  } finally {
    page.off('request', count)
  }
}
