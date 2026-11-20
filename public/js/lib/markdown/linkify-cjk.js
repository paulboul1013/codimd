// linkify-it lets a bare URL run on until whitespace, so in
// "（https://example.com）。下列" the link swallows "）。下列".
// Full-width and ideographic punctuation never belong in a URL a person types,
// so a link ends at the first one. CJK letters still count as path characters.
const FULL_WIDTH_PUNCTUATION = /[\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/

function cutMatches (linkify, match, text, offset) {
  const matches = match.call(linkify, text) || []
  const result = []
  for (const m of matches) {
    const cut = m.raw.search(FULL_WIDTH_PUNCTUATION)
    if (cut === -1) {
      result.push(shift(m, offset))
      continue
    }
    const removed = m.raw.length - cut
    if (cut > 0) {
      result.push(shift(Object.assign(Object.create(Object.getPrototypeOf(m)), m, {
        raw: m.raw.slice(0, cut),
        text: m.text.slice(0, m.text.length - removed),
        url: m.url.slice(0, m.url.length - removed),
        lastIndex: m.lastIndex - removed
      }), offset))
    }
    // The swallowed tail may hold another URL; match it on its own.
    const rest = m.lastIndex - removed
    return result.concat(cutMatches(linkify, match, text.slice(rest), offset + rest))
  }
  return result
}

function shift (m, offset) {
  m.index += offset
  m.lastIndex += offset
  return m
}

export function stopLinksAtFullWidthPunctuation (linkify) {
  const match = linkify.match
  linkify.match = function (text) {
    const result = cutMatches(this, match, text, 0)
    return result.length ? result : null
  }
  return linkify
}
