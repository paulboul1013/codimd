/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { SaxesParser } = require('saxes')
const sanitizeSvg = require('../../lib/imageRouter/svg')

const wrap = content => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${content}</svg>`)

describe('Static SVG sanitization', function () {
  it('preserves vector geometry, Unicode, gradients, local references and CSS', function () {
    const clean = sanitizeSvg(fs.readFileSync(path.join(__dirname, 'fixtures/image.svg')))
    assert(clean.includes('viewBox="0 0 120 80"'))
    assert(clean.includes('<linearGradient id="blue">'))
    assert(clean.includes('fill:url(#blue)'))
    assert(clean.includes('xlink:href="#line"'))
    assert(clean.includes('style="stroke:royalblue;fill:none"'))
    assert(clean.includes('SVG 圖片'))
    assert(clean.includes('SVG &amp; vector image'))
    new SaxesParser({ xmlns: true }).write(clean).close()
  })

  for (const content of [
    '<script>alert(1)</script>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)">HTML</div></foreignObject>',
    '<animate attributeName="href" values="javascript:alert(1)"/>',
    '<set attributeName="onload" to="alert(1)"/>',
    '<evil:script xmlns:evil="http://www.w3.org/1999/xhtml">alert(1)</evil:script>',
    '<g onload="alert(1)" onclick="alert(1)"><circle r="10"/></g>'
  ]) {
    it(`removes executable content: ${content}`, function () {
      const clean = sanitizeSvg(wrap(content + '<rect width="10" height="10"/>'))
      assert(!clean.includes('alert'))
      assert(!clean.includes('foreignObject'))
      assert(clean.includes('<rect width="10" height="10">'))
    })
  }

  for (const value of [
    'https://example.test/image.svg#shape',
    '//example.test/image.svg',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'javascript:alert(1)',
    '&#106;avascript:alert(1)',
    'image.svg#shape'
  ]) {
    it(`removes external and executable hrefs: ${value}`, function () {
      const clean = sanitizeSvg(wrap(`<use href="${value}"/><use xlink:href="${value}"/>`))
      assert(!clean.includes(' href='))
      assert(!clean.includes(' xlink:href='))
    })
  }

  for (const value of [
    'url(https://example.test/image.svg)',
    'url(//example.test/image.svg)',
    'url(data:image/svg+xml;base64,PHN2Zy8+)',
    'u\\72l(https://example.test/image.svg)',
    'var(--untrusted)',
    'expression(alert(1))'
  ]) {
    it(`removes unsafe CSS from attributes, inline styles and stylesheets: ${value}`, function () {
      const clean = sanitizeSvg(wrap(`<style>.x { fill:${value}; stroke:red } @import "https://example.test/style.css";</style><rect fill="${value}" style="fill:${value};stroke:red"/>`))
      assert(!clean.includes('example.test'))
      assert(!clean.includes('data:'))
      assert(!clean.includes('alert'))
      assert(!clean.includes('untrusted'))
      assert(!clean.includes('@import'))
      assert(clean.includes('stroke:red'))
    })
  }

  it('removes stylesheet instructions, XML base URLs and foreign attributes', function () {
    const clean = sanitizeSvg(Buffer.from('<?xml-stylesheet href="https://example.test/style.xsl" type="text/xsl"?><svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.test/" xmlns:evil="urn:evil" evil:onload="alert(1)"><use href="#shape"/></svg>'))
    assert(!clean.includes('example.test'))
    assert(!clean.includes('evil'))
    assert(clean.includes('href="#shape"'))
  })

  it('preserves escaped text and CSS stored in CDATA', function () {
    const clean = sanitizeSvg(wrap('<style><![CDATA[.x{fill:rgb(20,30,40)}]]></style><text><![CDATA[<script>alert(1)</script>]]></text>'))
    assert(clean.includes('.x{fill:rgb(20,30,40)}'))
    assert(clean.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert(!clean.includes('<script>'))
  })

  for (const content of [
    '', '<svg/>', '<html/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<!DOCTYPE svg [<!ENTITY x "value">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&unknown;</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="first" onload="second"/>',
    '<svg xmlns="http://www.w3.org/2000/svg">' + '<g>'.repeat(100) + '</g>'.repeat(100) + '</svg>'
  ]) {
    it(`rejects invalid or unsupported XML: ${content.slice(0, 90)}`, function () {
      assert.throws(() => sanitizeSvg(Buffer.from(content)))
    })
  }

  it('rejects invalid UTF-8 rather than silently replacing bytes', function () {
    assert.throws(() => sanitizeSvg(Buffer.from([0xff, 0xfe])))
  })
})
