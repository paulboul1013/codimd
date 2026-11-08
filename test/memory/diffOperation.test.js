/* eslint-env node, mocha */
'use strict'

const assert = require('assert')

const diffOperation = require('../../lib/memory/diffOperation')

describe('memory diffOperation', function () {
  const cases = [
    ['an append', 'body', 'body\n\nmore'],
    ['a prepend', 'body', 'new body'],
    ['a middle replacement', 'tags: memory, global\nbody', 'tags: memory, global, archived\nbody'],
    ['a deletion', 'keep this, drop that', 'keep this'],
    ['a full rewrite', 'abc', 'xyz'],
    ['an empty old text', '', 'fresh'],
    ['an empty new text', 'gone', ''],
    ['identical texts', 'same', 'same'],
    ['repeated characters', 'aaaa', 'aaaaaa'],
    ['CJK text', '記憶筆記：使用 pnpm', '記憶筆記：一律使用 pnpm 安裝'],
    ['emoji sharing a high surrogate', 'a😀b', 'a😁b'],
    ['emoji inserted next to emoji', '😀😀', '😀🎉😀'],
    ['emoji removed', 'x😀😁y', 'x😁y']
  ]

  for (const [label, oldText, newText] of cases) {
    it(`turns ${label} into an operation that rebuilds the new text`, function () {
      const operation = diffOperation(oldText, newText)
      assert.strictEqual(operation.baseLength, oldText.length)
      assert.strictEqual(operation.apply(oldText), newText)
    })
  }

  it('keeps the common prefix and suffix as retains', function () {
    assert.deepStrictEqual(diffOperation('head old tail', 'head new tail').toJSON(), [5, 'new', -3, 5])
  })

  it('is a no-op for identical texts', function () {
    assert(diffOperation('same', 'same').isNoop())
  })

  it('never splits a surrogate pair at either boundary', function () {
    for (const [, oldText, newText] of cases) {
      const ops = diffOperation(oldText, newText).toJSON()
      for (const op of ops.filter(op => typeof op === 'string')) {
        assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(op), `insert ${JSON.stringify(op)} splits a pair`)
      }
      let index = 0
      for (const op of ops) {
        if (typeof op === 'string') continue
        const code = oldText.charCodeAt(index)
        assert(!(code >= 0xDC00 && code <= 0xDFFF), `boundary at ${index} splits a pair in ${JSON.stringify(oldText)}`)
        index += Math.abs(op)
      }
    }
  })
})
