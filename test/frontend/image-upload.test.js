/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const source = fs.readFileSync(path.join(__dirname, '../../public/vendor/inlineAttachment/inline-attachment.js'), 'utf8')

describe('SVG attachment selection', function () {
  function attachment (allowedTypes) {
    const context = { document: {}, window: { allowedUploadMimeTypes: allowedTypes } }
    vm.runInNewContext(source, context)
    const InlineAttachment = context.window.inlineAttachment
    return new InlineAttachment({}, {})
  }

  for (const name of ['image.svg', 'image.SVG']) {
    for (const type of ['image/svg+xml', '', 'text/xml', 'application/octet-stream']) {
      it(`accepts ${name} with browser MIME type ${JSON.stringify(type)}`, function () {
        assert(attachment(['image/svg+xml']).isFileAllowed({ name, type }))
      })
    }
  }

  it('respects a provider that does not support SVG', function () {
    assert(!attachment(['image/png', 'image/jpeg']).isFileAllowed({ name: 'image.svg', type: '' }))
  })

  it('continues to accept JFIF files and PNG clipboard images', function () {
    const instance = attachment(['image/jpeg', 'image/png'])
    assert(instance.isFileAllowed({ name: 'image.JFIF', type: '' }))
    assert(instance.isFileAllowed({ type: 'image/png' }))
  })

  it('does not accept an SVG extension in the middle of a filename', function () {
    assert(!attachment(['image/svg+xml']).isFileAllowed({ name: 'image.svg.exe', type: '' }))
  })
})
