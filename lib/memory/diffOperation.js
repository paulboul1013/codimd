'use strict'

const TextOperation = require('../ot/text-operation')

const isHighSurrogate = code => code >= 0xD800 && code <= 0xDBFF
const isLowSurrogate = code => code >= 0xDC00 && code <= 0xDFFF

// One replaced range between the common prefix and suffix, measured in UTF-16
// code units like TextOperation and CodeMirror. The boundaries never split a
// surrogate pair, so no client ever holds half an emoji.
function diffOperation (oldText, newText) {
  const maxCommon = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < maxCommon && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--

  let suffix = 0
  while (suffix < maxCommon - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--

  return new TextOperation()
    .retain(prefix)
    .delete(oldText.length - prefix - suffix)
    .insert(newText.slice(prefix, newText.length - suffix))
    .retain(suffix)
}

module.exports = diffOperation
