'use strict'

const randomcolor = require('randomcolor')

// Mid-tone colors that stay readable on both the light and the night theme.
const PALETTE = [
  '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1',
  '#d81b60', '#7cb342', '#5e35b1', '#f4511e', '#00897b', '#c0ca33'
]

function normalize (color) {
  return String(color || '').toLowerCase()
}

/**
 * Pick the color for a joining connection. An account keeps one color while the
 * note stays open in the pool; the map resets once everyone has left.
 *
 * @param {{ users: Object<string, { userid: ?string, color: string }>, authors: Object, accountColors: Object<string, string> }} note
 * @param {?string} userid
 * @returns {string}
 */
function assignColor (note, userid) {
  if (userid && note.accountColors[userid]) return note.accountColors[userid]
  const taken = new Set()
  Object.values(note.users).forEach(user => {
    if (!userid || user.userid !== userid) taken.add(normalize(user.color))
  })
  Object.keys(note.accountColors).forEach(id => {
    if (id !== userid) taken.add(normalize(note.accountColors[id]))
  })
  const author = userid && note.authors[userid]
  const candidates = (author && author.color ? [author.color] : []).concat(PALETTE)
  let color = candidates.find(candidate => !taken.has(normalize(candidate)))
  for (let attempt = 0; !color && attempt < 50; attempt++) {
    const random = randomcolor({ luminosity: 'dark' })
    if (!taken.has(normalize(random))) color = random
  }
  color = color || randomcolor()
  if (userid) note.accountColors[userid] = color
  return color
}

function shortCode (userid, length) {
  return String(userid).replace(/[^a-zA-Z0-9]/g, '').slice(0, length).toUpperCase()
}

/**
 * Give accounts that share a display name a short, account-based suffix.
 * Several tabs of one account keep one label. Returns the users whose label changed.
 *
 * @param {Array<{ userid: ?string, login: boolean, profileName: string, name: string }>} users
 * @returns {Array<object>}
 */
function labelParticipants (users) {
  const accountsByName = new Map()
  users.forEach(user => {
    if (!user.login || !user.userid) return
    const ids = accountsByName.get(user.profileName) || new Set()
    ids.add(user.userid)
    accountsByName.set(user.profileName, ids)
  })
  const labels = new Map()
  accountsByName.forEach((ids, name) => {
    if (ids.size < 2) return
    const accounts = Array.from(ids)
    const longest = Math.max(...accounts.map(id => shortCode(id, Infinity).length))
    let length = 4
    while (length < longest && new Set(accounts.map(id => shortCode(id, length))).size < accounts.length) length++
    accounts.forEach(id => labels.set(id, name + ' · ' + shortCode(id, length)))
  })
  const changed = []
  users.forEach(user => {
    if (!user.login || !user.userid) return
    const label = labels.get(user.userid) || user.profileName
    if (user.name !== label) {
      user.name = label
      changed.push(user)
    }
  })
  return changed
}

exports.PALETTE = PALETTE
exports.assignColor = assignColor
exports.labelParticipants = labelParticipants
