'use strict'

const get = require('lodash/get')

const config = require('../config')
const models = require('../models')
const logger = require('../logger')

class RealtimeClientConnection {
  constructor (socket) {
    this.socket = socket
    this.realtime = require('./realtime')
  }

  registerEventHandler () {
    // received client refresh request
    this.socket.on('refresh', this.refreshEventHandler.bind(this))
    // received user status
    this.socket.on('user status', this.userStatusEventHandler.bind(this))
    // when a new client disconnect
    this.socket.on('disconnect', this.disconnectEventHandler.bind(this))
    // received cursor focus
    this.socket.on('cursor focus', this.cursorFocusEventHandler.bind(this))
    // received cursor activity
    this.socket.on('cursor activity', this.cursorActivityEventHandler.bind(this))
    // received cursor blur
    this.socket.on('cursor blur', this.cursorBlurEventHandler.bind(this))
    // check version
    this.socket.on('version', this.checkVersionEventHandler.bind(this))
    // received sync of online users request
    this.socket.on('online users', this.onlineUsersEventHandler.bind(this))
    // reveiced when user logout or changed
    this.socket.on('user changed', this.userChangedEventHandler.bind(this))
    // delete a note
    this.socket.on('delete', this.deleteNoteEventHandler.bind(this))
    // received note permission change request
    this.socket.on('permission', this.permissionChangeEventHandler.bind(this))
  }

  isUserLoggedIn () {
    return this.socket.request.user && this.socket.request.user.logged_in
  }

  isNoteAndUserExists () {
    const note = this.realtime.getNoteFromNotePool(this.socket.noteId)
    const user = this.realtime.getUserFromUserPool(this.socket.id)
    return note && user
  }

  isNoteOwner () {
    const note = this.getCurrentNote()
    return get(note, 'owner') === this.getCurrentLoggedInUserId()
  }

  isAnonymousEnable () {
    // TODO: move this method to config module
    return config.allowAnonymous || config.allowAnonymousEdits
  }

  getAvailablePermissions () {
    // TODO: move this method to config module
    const availablePermission = Object.assign({}, config.permission)
    if (!config.allowAnonymous && !config.allowAnonymousViews) {
      delete availablePermission.freely
      delete availablePermission.editable
      delete availablePermission.locked
    } else if (!config.allowAnonymous && !config.allowAnonymousEdits) {
      delete availablePermission.freely
    }
    return availablePermission
  }

  getCurrentUser () {
    if (!this.socket.id) return
    return this.realtime.getUserFromUserPool(this.socket.id)
  }

  getCurrentLoggedInUserId () {
    return get(this.socket, 'request.user.id')
  }

  getCurrentNote () {
    if (!this.socket.noteId) return
    return this.realtime.getNoteFromNotePool(this.socket.noteId)
  }

  getNoteChannel () {
    return this.socket.broadcast.to(this.socket.noteId)
  }

  async destroyNote (id) {
    return models.Note.destroy({
      where: { id: id }
    })
  }

  async changeNotePermission (newPermission) {
    const [changedRows] = await models.Note.update({
      permission: newPermission
    }, {
      where: {
        id: this.getCurrentNote().id
      }
    })
    if (changedRows !== 1) {
      throw new Error(`updated permission failed, cannot set permission ${newPermission} to note ${this.getCurrentNote().id}`)
    }
  }

  notifyPermissionChanged () {
    const note = this.getCurrentNote()
    // Revoked sockets leave the room first, so the broadcast below never reaches them.
    note.socks.forEach((sock) => {
      if (sock && !this.realtime.checkViewPermission(sock.request, note)) {
        sock.revoked = true
        if (typeof sock.leave === 'function') sock.leave(note.id)
        sock.emit('info', {
          code: 403,
          reason: 'revoked'
        })
        setTimeout(function () {
          sock.disconnect(true)
        }, 0)
      }
    })
    this.realtime.io.to(note.id).emit('permission', {
      permission: note.permission
    })
  }

  refreshEventHandler () {
    this.realtime.emitRefresh(this.socket)
  }

  checkVersionEventHandler () {
    this.socket.emit('version', {
      version: config.fullversion,
      minimumCompatibleVersion: config.minimumCompatibleVersion
    })
  }

  userStatusEventHandler (data) {
    if (!this.isNoteAndUserExists()) return
    const user = this.getCurrentUser()
    if (config.debug) {
      logger.info('SERVER received [' + this.socket.noteId + '] user status from [' + this.socket.id + ']: ' + JSON.stringify(data))
    }
    if (data) {
      user.idle = data.idle
      user.type = data.type
    }
    this.realtime.emitUserStatus(this.socket)
  }

  userChangedEventHandler () {
    logger.info('user changed')

    const note = this.getCurrentNote()
    if (!note) return
    const user = note.users[this.socket.id]
    if (!user) return

    this.realtime.updateUserData(this.socket, user)
    this.realtime.relabelParticipants(note)
    this.realtime.emitOnlineUsers(this.socket)
  }

  onlineUsersEventHandler () {
    if (!this.isNoteAndUserExists()) return

    const currentNote = this.getCurrentNote()

    const currentNoteOnlineUserList = Object.keys(currentNote.users)
      .map(key => this.realtime.buildUserOutData(currentNote.users[key]))

    this.socket.emit('online users', {
      users: currentNoteOnlineUserList
    })
  }

  cursorFocusEventHandler (data) {
    if (!this.isNoteAndUserExists()) return
    const user = this.getCurrentUser()
    user.cursor = data
    user.blur = false
    const out = this.realtime.buildUserOutData(user)
    this.getNoteChannel().emit('cursor focus', out)
  }

  cursorActivityEventHandler (data) {
    if (!this.isNoteAndUserExists()) return
    const user = this.getCurrentUser()
    user.cursor = data
    user.blur = false
    const out = this.realtime.buildUserOutData(user)
    this.getNoteChannel().emit('cursor activity', out)
  }

  cursorBlurEventHandler () {
    if (!this.isNoteAndUserExists()) return
    const user = this.getCurrentUser()
    // keep the last position so others can show a dimmed cursor
    user.blur = true
    this.getNoteChannel().emit('cursor blur', this.realtime.buildUserOutData(user))
  }

  deleteNoteEventHandler () {
    // need login to do more actions
    if (this.isUserLoggedIn() && this.isNoteAndUserExists()) {
      const note = this.getCurrentNote()
      // Only owner can delete note
      if (note.owner && note.owner === this.getCurrentLoggedInUserId()) {
        this.destroyNote(note.id)
          .then((successRows) => {
            if (!successRows) return
            this.realtime.disconnectSocketOnNote(note)
          })
          .catch(function (err) {
            return logger.error('delete note failed: ' + err)
          })
      }
    }
  }

  // acknowledge is optional: { ok: true, permission } once saved and applied, else { ok: false, code }
  permissionChangeEventHandler (permission, acknowledge) {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    if (!this.isUserLoggedIn()) return reply({ ok: false, code: 'unauthenticated' })
    if (!this.isNoteAndUserExists()) return reply({ ok: false, code: 'unavailable' })

    const note = this.getCurrentNote()
    // Only owner can change permission
    if (!this.isNoteOwner()) return reply({ ok: false, code: 'forbidden' })
    if (!(permission in this.getAvailablePermissions())) return reply({ ok: false, code: 'unsupported' })

    this.changeNotePermission(permission)
      .then(() => {
        note.permission = permission
        this.notifyPermissionChanged()
        reply({ ok: true, permission })
      })
      .catch(err => {
        logger.error('update note permission failed: ' + err)
        reply({ ok: false, code: 'save-failed' })
      })
  }

  disconnectEventHandler () {
    if (this.realtime.disconnectProcessQueue.checkTaskIsInQueue(this.socket.id)) {
      return
    }
    this.realtime.queueForDisconnect(this.socket)
  }
}

exports.RealtimeClientConnection = RealtimeClientConnection
