/* eslint-env node, mocha */
'use strict'

const assert = require('assert')
const Module = require('module')
const path = require('path')
const markdownit = require('markdown-it')
const { transformFileSync } = require('@babel/core')
const filename = path.resolve(__dirname, '../../public/js/lib/markdown/linkify-cjk.js')
const { code } = transformFileSync(filename, {
  configFile: false,
  babelrc: false,
  plugins: ['@babel/plugin-transform-modules-commonjs']
})
const frontendModule = new Module(filename, module)
frontendModule._compile(code, filename)
const { stopLinksAtFullWidthPunctuation } = frontendModule.exports

function render (text) {
  const md = markdownit('default', { linkify: true, typographer: true })
  stopLinksAtFullWidthPunctuation(md.linkify)
  return md.renderInline(text)
}

describe('linkify with full-width punctuation', function () {
  it('ends a bare URL at a full-width closing parenthesis', function () {
    assert.strictEqual(
      render('C 編譯器（https://github.com/paulboul1013/lemon_cc）。下列筆記是 repo 內'),
      'C 編譯器（<a href="https://github.com/paulboul1013/lemon_cc">https://github.com/paulboul1013/lemon_cc</a>）。下列筆記是 repo 內'
    )
  })

  it('ends a bare URL at ideographic punctuation', function () {
    assert.strictEqual(
      render('見 https://example.com/a，或 https://example.com/b。'),
      '見 <a href="https://example.com/a">https://example.com/a</a>，或 <a href="https://example.com/b">https://example.com/b</a>。'
    )
  })

  it('keeps CJK letters that belong to the path', function () {
    assert.strictEqual(
      render('https://zh.wikipedia.org/wiki/編譯器 很好'),
      '<a href="https://zh.wikipedia.org/wiki/%E7%B7%A8%E8%AD%AF%E5%99%A8">https://zh.wikipedia.org/wiki/編譯器</a> 很好'
    )
  })

  it('leaves text without a link alone', function () {
    assert.strictEqual(render('（沒有連結）。'), '（沒有連結）。')
  })

  it('links a bare domain after a full-width colon', function () {
    assert.strictEqual(render('看這裡：example.com'), '看這裡：<a href="http://example.com">example.com</a>')
  })

  it('finds a second URL that the first one used to swallow', function () {
    assert.strictEqual(
      render('（https://a.example/x）（https://b.example/y）'),
      '（<a href="https://a.example/x">https://a.example/x</a>）（<a href="https://b.example/y">https://b.example/y</a>）'
    )
  })
})
