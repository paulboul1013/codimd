/* eslint-env node, mocha */
'use strict'

const assert = require('assert')

const { PALETTE, assignColor, labelParticipants } = require('../../lib/realtime/participants')

describe('realtime participants', function () {
  function makeNote () {
    return { users: {}, authors: {}, accountColors: {} }
  }

  describe('assignColor', function () {
    it('gives two accounts different palette colors', function () {
      const note = makeNote()
      const first = assignColor(note, 'a')
      note.users.s1 = { userid: 'a', color: first }
      const second = assignColor(note, 'b')
      assert.notStrictEqual(first.toLowerCase(), second.toLowerCase())
      assert(PALETTE.includes(first) && PALETTE.includes(second))
    })

    it('keeps the account color for another tab and after a reconnect', function () {
      const note = makeNote()
      const color = assignColor(note, 'a')
      note.users.s1 = { userid: 'a', color }
      assert.strictEqual(assignColor(note, 'a'), color)
      delete note.users.s1
      note.users.s2 = { userid: 'b', color: assignColor(note, 'b') }
      assert.strictEqual(assignColor(note, 'a'), color)
    })

    it('does not let a historical author color collide with an online account', function () {
      const note = makeNote()
      note.users.s1 = { userid: 'a', color: assignColor(note, 'a') }
      note.authors.b = { color: note.users.s1.color.toUpperCase() }
      assert.notStrictEqual(assignColor(note, 'b').toLowerCase(), note.users.s1.color.toLowerCase())
    })

    it('reuses a free author color', function () {
      const note = makeNote()
      note.authors.a = { color: '#123456' }
      assert.strictEqual(assignColor(note, 'a'), '#123456')
    })

    it('still finds a distinct color once the palette is used up', function () {
      const note = makeNote()
      PALETTE.forEach((color, index) => { note.users['s' + index] = { userid: 'u' + index, color } })
      const color = assignColor(note, 'extra')
      assert(!PALETTE.map(c => c.toLowerCase()).includes(color.toLowerCase()))
    })
  })

  describe('labelParticipants', function () {
    function user (id, userid, name) {
      return { id, userid, login: true, profileName: name, name }
    }

    it('adds account-based suffixes only for colliding names', function () {
      const users = [user('s1', 'aaaa1111', 'root1'), user('s2', 'bbbb2222', 'root1'), user('s3', 'cccc3333', 'root2')]
      labelParticipants(users)
      assert.deepStrictEqual(users.map(u => u.name), ['root1 · AAAA', 'root1 · BBBB', 'root2'])
    })

    it('extends the suffix when the short codes collide', function () {
      const users = [user('s1', 'abcd1111', 'x'), user('s2', 'abcd2222', 'x')]
      labelParticipants(users)
      assert.deepStrictEqual(users.map(u => u.name), ['x · ABCD1', 'x · ABCD2'])
    })

    it('treats tabs of one account as one identity', function () {
      const users = [user('s1', 'aaaa', 'root1'), user('s2', 'aaaa', 'root1')]
      labelParticipants(users)
      assert.deepStrictEqual(users.map(u => u.name), ['root1', 'root1'])
    })

    it('restores the plain name once the collision leaves', function () {
      const users = [user('s1', 'aaaa', 'root1'), user('s2', 'bbbb', 'root1')]
      labelParticipants(users)
      const changed = labelParticipants(users.slice(0, 1))
      assert.strictEqual(users[0].name, 'root1')
      assert.deepStrictEqual(changed, [users[0]])
    })
  })
})
