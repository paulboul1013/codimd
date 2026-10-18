/* eslint-env node, browser */
'use strict'

// Run with Playwright CLI run-code. See docs/reports/markdown-import-pstack-detail.md.
module.exports = async function checkMarkdownImport (page) {
  const home = page.url().replace(/\/$/, '')
  const fixtures = 'output/playwright/markdown-import-fixtures/'
  const evidence = 'output/playwright/'
  const results = []
  let posts = 0
  const countPost = request => {
    if (request.method() === 'POST' && request.url() === home + '/new') posts++
  }
  page.on('request', countPost)
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
    results.push(message)
  }
  async function history () {
    await page.goto(home)
    await page.locator('.ui-history').click()
    await page.locator('.ui-import-markdown').waitFor({ state: 'visible' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#history')).opacity === '1')
  }
  async function upload (filename) {
    await page.locator('.ui-markdown-file').setInputFiles(fixtures + filename)
  }
  async function errorContains (text) {
    const error = page.locator('.ui-markdown-import-error')
    await error.waitFor({ state: 'visible' })
    check((await error.textContent()).includes(text), 'error: ' + text)
    check(await page.locator('.ui-import-markdown').isEnabled(), 'can select a file again')
  }
  try {
    await page.context().addCookies([{ name: 'locale', value: 'zh-TW', url: home }])
    await history()
    check(!await page.locator('.ui-markdown-file').isVisible(), 'native file input remains hidden')
    await page.screenshot({ path: evidence + 'markdown-import-history.png', fullPage: true })
    const initialPosts = posts
    await page.locator('.ui-markdown-file').setInputFiles([])
    check(posts === initialPosts, 'cancelled selection sends no creation request')
    for (const filename of ['empty.md', 'cr-only.md']) {
      await upload(filename)
      await errorContains('檔案沒有內容')
    }
    check(posts === initialPosts, 'empty files send no creation request')
    await page.screenshot({ path: evidence + 'markdown-import-empty.png', fullPage: true })
    await upload('unsupported.csv')
    await errorContains('請選擇')
    check(posts === initialPosts, 'unsupported extension sends no creation request')
    await upload('oversize.md')
    await errorContains('檔案過大')
    check(posts === initialPosts + 1, 'oversize file receives server rejection')

    for (const [failure, message] of [['server', '無法匯入'], ['network', '連線失敗']]) {
      const before = posts
      await page.route(home + '/new', route => failure === 'server'
        ? route.fulfill({ status: 500, body: 'test server failure' })
        : route.abort('failed'))
      await upload('article.MD')
      await errorContains(message)
      check(posts === before + 1, failure + ' failure does not retry creation')
      await page.unroute(home + '/new')
    }

    const parserLimit = await page.request.post(home + '/new', {
      headers: { 'Content-Type': 'text/markdown' },
      data: 'x'.repeat(10 * 1024 * 1024 + 1)
    })
    check(parserLimit.status() === 413, 'text parser rejects bodies above 10 MiB')
    // The isolated server uses this nonempty template to detect accidental fallback.
    const template = '# 預設範本\n\n範本正文\n'
    for (const method of ['GET', 'POST']) {
      const blank = await page.request.fetch(home + '/new', {
        method,
        headers: { 'Content-Type': 'text/markdown' },
        data: method === 'POST' ? '' : undefined
      })
      const content = await (await page.request.get(blank.url() + '/download')).text()
      check(content === template, method + ' /new preserves the deployment template')
    }

    for (const [filename, title, expected] of [
      ['article.MD', '中文匯入標題', '---\ntitle: 中文匯入標題\ntags: [匯入, 測試]\n---\n# H1 備用標題\n\n中文 UTF-8 正文。\n'],
      ['heading.Markdown', 'H1 標題', '# H1 標題\n正文\n'],
      ['plain.TXT', 'Untitled', '沒有標題的正文\n'],
      ['whitespace.md', 'Untitled', ' \n']
    ]) {
      await history()
      const before = posts
      await upload(filename)
      await page.waitForURL(url => url.href.startsWith(home + '/') && /^[A-Za-z0-9_-]{22}$/.test(url.pathname.split('/').pop()))
      const noteURL = page.url()
      check(posts === before + 1, filename + ' creates exactly once')
      const download = await page.request.get(noteURL + '/download')
      check(download.ok() && await download.text() === expected, filename + ' preserves normalized body')
      const revisions = await (await page.request.get(noteURL + '/revision')).json()
      check(revisions.revision.length === 1, filename + ' has exactly one initial revision')
      const revision = await page.request.get(noteURL + '/revision/' + revisions.revision[0].time)
      check((await revision.json()).content === expected, filename + ' initial revision contains imported body')
      const expectedTitle = title === 'Untitled' ? 'CodiMD - Collaborative markdown notes' : title + ' - CodiMD'
      check(await page.title() === expectedTitle, filename + ' page title follows body rules')
      if (filename === 'article.MD') {
        await page.locator('.markdown-body').first().waitFor({ state: 'visible' })
        await page.screenshot({ path: evidence + 'markdown-import-success.png', fullPage: true })
      }
    }

    await history()
    await page.setViewportSize({ width: 375, height: 812 })
    const bounds = await page.locator('.ui-import-markdown').boundingBox()
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375, 'import button fits a narrow screen')
    await page.screenshot({ path: evidence + 'markdown-import-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })
    check(await page.getByRole('heading', { name: '歷史 JSON 保留', exact: true }).count() === 0, 'JSON fixture is absent before import; use a fresh browser context')
    await page.locator('.ui-open-history input').setInputFiles(fixtures + 'codimd_history_fixture')
    await page.getByRole('heading', { name: '歷史 JSON 保留', exact: true }).waitFor({ state: 'visible' })
    check(true, 'extensionless JSON history still imports')

    const email = 'markdown-import-' + Date.now() + '@example.test'
    const form = { email, password: 'local-import-verification-only' }
    await page.request.post(home + '/register', { form })
    await page.request.post(home + '/login', { form })
    const me = await (await page.request.get(home + '/me')).json()
    check(me.status === 'ok', 'isolated test account is authenticated')
    await history()
    await upload('article.MD')
    await page.waitForURL(url => url.href.startsWith(home + '/') && /^[A-Za-z0-9_-]{22}$/.test(url.pathname.split('/').pop()))
    const ownedURL = page.url()
    const info = await (await page.request.get(ownedURL + '/info')).json()
    check(info.title === '中文匯入標題', 'authenticated import reports the body title')
    const serverHistory = await (await page.request.get(home + '/history')).json()
    const entry = serverHistory.history.find(item => item.id === ownedURL.split('/').pop())
    check(entry && entry.text === '中文匯入標題' && entry.tags.includes('匯入') && entry.tags.includes('測試'), 'server history contains the imported title and tags')
    return { home, posts, checks: results.length, results }
  } finally {
    page.off('request', countPost)
  }
}

if (require.main === module) {
  const fs = require('fs')
  const directory = 'output/playwright/markdown-import-fixtures'
  fs.mkdirSync(directory, { recursive: true })
  const fixtures = {
    'empty.md': '',
    'cr-only.md': '\r\r',
    'whitespace.md': ' \n',
    'article.MD': '---\r\ntitle: 中文匯入標題\r\ntags: [匯入, 測試]\r\n---\r\n# H1 備用標題\r\n\r\n中文 UTF-8 正文。\r\n',
    'heading.Markdown': '# H1 標題\n正文\n',
    'plain.TXT': '沒有標題的正文\n',
    'unsupported.csv': '# Reject',
    'oversize.md': 'x'.repeat(100001),
    codimd_history_fixture: JSON.stringify([{ id: 'history-fixture', text: '歷史 JSON 保留', time: 1760000000000, tags: [] }])
  }
  for (const [name, body] of Object.entries(fixtures)) fs.writeFileSync(directory + '/' + name, body)
  console.log('Created fixtures in ' + directory)
}
