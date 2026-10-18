/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const express = require('express')
const formidable = require('formidable')
const fs = require('fs')
const http = require('http')
const mock = require('mock-require')
const os = require('os')
const path = require('path')
const sinon = require('sinon')

const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/image.jpg'))
const png = fs.readFileSync(path.join(__dirname, '../../public/favicon.png'))
const svg = fs.readFileSync(path.join(__dirname, 'fixtures/image.svg'))

describe('Image uploads', function () {
  let server, config, tempDir

  function request (method, url, body, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(config.serverURL + url, { method, headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  function upload (filename, content) {
    const boundary = 'codimd-image-upload-test'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
    return request('POST', '/uploadimage', body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    })
  }

  beforeEach(function (done) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codimd-image-upload-'))
    config = {
      imageUploadType: 'filesystem',
      allowedUploadMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'],
      uploadsPath: path.join(tempDir, 'uploads')
    }
    fs.mkdirSync(config.uploadsPath)
    mock('../../lib/config', config)
    mock('../../lib/logger', { error: () => {} })
    mock('../../lib/response', { errorForbidden: (req, res) => res.sendStatus(403) })
    mock('formidable', {
      IncomingForm: class extends formidable.IncomingForm {
        constructor (options) {
          super(Object.assign({}, options, { uploadDir: tempDir }))
        }
      }
    })
    mock.reRequire('../../lib/imageRouter/filesystem')
    const app = express()
    app.use(mock.reRequire('../../lib/imageRouter'))
    app.use('/uploads', express.static(config.uploadsPath))
    server = app.listen(0, '127.0.0.1', () => {
      config.serverURL = `http://127.0.0.1:${server.address().port}`
      done()
    })
  })

  afterEach(function (done) {
    sinon.restore()
    server.close(() => {
      mock.stopAll()
      delete require.cache[require.resolve('../../lib/imageRouter')]
      delete require.cache[require.resolve('../../lib/imageRouter/filesystem')]
      fs.rmSync(tempDir, { recursive: true, force: true })
      done()
    })
  })

  for (const extension of ['jfif', 'JFIF', 'JfIf', 'jpg', 'jpeg']) {
    it(`uploads JPEG content with .${extension} and serves it as image/jpeg`, async function () {
      const response = await upload(`image.${extension}`, jpeg)
      assert.strictEqual(response.status, 200)
      const url = new URL(JSON.parse(response.body.toString()).link)
      assert.strictEqual(path.extname(url.pathname), extension.toLowerCase() === 'jfif' ? '.jpg' : `.${extension}`)

      const image = await request('GET', url.pathname)
      assert.strictEqual(image.status, 200)
      assert.strictEqual(image.headers['content-type'], 'image/jpeg')
      assert.deepStrictEqual(image.body, jpeg)
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
    })
  }

  it('continues to upload PNG images', async function () {
    const response = await upload('image.png', png)
    assert.strictEqual(response.status, 200)
    const url = new URL(JSON.parse(response.body.toString()).link)
    const image = await request('GET', url.pathname)
    assert.strictEqual(image.headers['content-type'], 'image/png')
    assert.deepStrictEqual(image.body, png)
  })

  for (const extension of ['svg', 'SVG']) {
    it(`uploads .${extension} as a renderable SVG image`, async function () {
      const response = await upload(`image.${extension}`, svg)
      assert.strictEqual(response.status, 200)
      const url = new URL(JSON.parse(response.body.toString()).link)
      const image = await request('GET', url.pathname)
      assert.strictEqual(image.status, 200)
      assert.strictEqual(image.headers['content-type'].split(';')[0], 'image/svg+xml')
      assert(image.body.toString().includes('viewBox="0 0 120 80"'))
      assert(image.body.toString().includes('SVG 圖片'))
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
    })
  }

  it('cleans active SVG content before passing it to a storage provider', async function () {
    config.imageUploadType = 's3'
    let uploadedContent
    mock('../../lib/imageRouter/s3', {
      uploadImage: (imagePath, callback) => {
        uploadedContent = fs.readFileSync(imagePath, 'utf8')
        callback(null, 'https://images.example.test/image.svg')
      }
    })
    const response = await upload('image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><circle r="10"/></svg>'))
    assert.strictEqual(response.status, 200)
    assert(uploadedContent.includes('<circle r="10">'))
    assert(!uploadedContent.includes('onload'))
    assert(!uploadedContent.includes('script'))
    assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
  })

  it('rejects SVG when the provider does not allow it', async function () {
    config.allowedUploadMimeTypes = ['image/jpeg', 'image/png', 'image/gif']
    const response = await upload('image.svg', svg)
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
  })

  for (const [name, content] of [
    ['PNG', png],
    ['HTML', Buffer.from('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>')],
    ['malformed XML', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')],
    ['external entity', Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>')]
  ]) {
    it(`rejects ${name} as SVG and removes the temporary file`, async function () {
      const response = await upload('image.svg', content)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
    })
  }

  it('rejects SVG content renamed to .png', async function () {
    const response = await upload('image.png', svg)
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(fs.readdirSync(config.uploadsPath), [])
  })

  it('rejects SVG files larger than 5 MiB and removes the temporary file', async function () {
    const response = await upload('image.svg', Buffer.concat([svg, Buffer.alloc(5 * 1024 * 1024, ' ')]))
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
  })

  it('returns an upload error when writing the cleaned SVG fails', async function () {
    sinon.stub(fs.promises, 'writeFile').rejects(new Error('write failed'))
    const response = await upload('image.svg', svg)
    assert.strictEqual(response.status, 500)
    assert.strictEqual(response.body.toString(), 'upload image error')
    assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
  })

  for (const [name, content] of [
    ['PNG', png],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['text', Buffer.from('This is not a JPEG image')]
  ]) {
    it(`rejects ${name} content renamed to .jfif`, async function () {
      const response = await upload('image.jfif', content)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(fs.readdirSync(config.uploadsPath), [])
    })
  }

  it('rejects JFIF if JPEG uploads are not allowed', async function () {
    config.allowedUploadMimeTypes = ['image/png']
    const response = await upload('image.jfif', jpeg)
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(fs.readdirSync(config.uploadsPath), [])
  })

  it('passes a .jpg file with unchanged bytes to an external provider', async function () {
    config.imageUploadType = 'imgur'
    let uploadedPath, uploadedContent
    mock('../../lib/imageRouter/imgur', {
      uploadImage: (imagePath, callback) => {
        uploadedPath = imagePath
        uploadedContent = fs.readFileSync(imagePath)
        callback(null, 'https://images.example.test/image.jpg')
      }
    })
    const response = await upload('image.jfif', jpeg)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(JSON.parse(response.body.toString()).link, 'https://images.example.test/image.jpg')
    assert.strictEqual(path.extname(uploadedPath), '.jpg')
    assert.deepStrictEqual(uploadedContent, jpeg)
    assert.deepStrictEqual(fs.readdirSync(tempDir), ['uploads'])
  })

  it('returns an upload error if normalizing the temporary filename fails', async function () {
    sinon.stub(fs.promises, 'rename').rejects(new Error('rename failed'))
    const response = await upload('image.jfif', jpeg)
    assert.strictEqual(response.status, 500)
    assert.strictEqual(response.body.toString(), 'upload image error')
    assert.deepStrictEqual(fs.readdirSync(config.uploadsPath), [])
  })
})
