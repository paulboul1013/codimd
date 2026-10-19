'use strict'

const models = require('../models')
const config = require('../config')
const logger = require('../logger')

function deploymentBase () {
  const base = new URL(config.serverURL)
  return { origin: base.origin, path: base.pathname.replace(/\/$/, '') }
}

// A `next` path is relative to this deployment; absolute targets must stay inside it.
// Paths such as `//host` or `/\host` are rejected because browsers resolve them off-site.
function safeReturnTo (target) {
  if (!target) return null
  const base = deploymentBase()
  try {
    const url = /^\/(?![/\\])/.test(target) ? new URL(base.path + target, base.origin) : new URL(target)
    if (url.origin !== base.origin) return null
    if (url.pathname !== base.path && !url.pathname.startsWith(base.path + '/')) return null
    return url.toString()
  } catch (err) {
    return null
  }
}

exports.safeReturnTo = safeReturnTo

exports.setReturnToFromReferer = function setReturnToFromReferer (req) {
  if (!req.session) req.session = {}

  var referer = req.get('referer')
  var nextURL
  if (referer) {
    try {
      var refererSearchParams = new URLSearchParams(new URL(referer).search)
      nextURL = refererSearchParams.get('next')
    } catch (err) {
      logger.warn(err)
    }
  }

  if (nextURL) {
    req.session.returnTo = safeReturnTo(nextURL) || config.serverURL
  } else {
    req.session.returnTo = safeReturnTo(referer) || undefined
  }
}

// The sign-in page that keeps the pending destination, used after failures and registration.
exports.signinPageURL = function signinPageURL (req) {
  const base = deploymentBase()
  const home = new URL(base.path + '/', base.origin)
  const target = safeReturnTo(req.session && req.session.returnTo)
  if (!target) return home.toString()
  const url = new URL(target)
  const path = url.pathname.slice(base.path.length)
  if (path === '' || path === '/') return home.toString()
  home.search = new URLSearchParams({ next: path + url.search + url.hash }).toString()
  return home.toString()
}

exports.passportGeneralCallback = function callback (accessToken, refreshToken, profile, done) {
  var stringifiedProfile = JSON.stringify(profile)
  models.User.findOrCreate({
    where: {
      profileid: profile.id.toString()
    },
    defaults: {
      profile: stringifiedProfile,
      accessToken: accessToken,
      refreshToken: refreshToken
    }
  }).spread(function (user, created) {
    if (user) {
      var needSave = false
      if (user.profile !== stringifiedProfile) {
        user.profile = stringifiedProfile
        needSave = true
      }
      if (user.accessToken !== accessToken) {
        user.accessToken = accessToken
        needSave = true
      }
      if (user.refreshToken !== refreshToken) {
        user.refreshToken = refreshToken
        needSave = true
      }
      if (needSave) {
        user.save().then(function () {
          if (config.debug) { logger.info('user login: ' + user.id) }
          return done(null, user)
        })
      } else {
        if (config.debug) { logger.info('user login: ' + user.id) }
        return done(null, user)
      }
    }
  }).catch(function (err) {
    logger.error('auth callback failed: ' + err)
    return done(err, null)
  })
}
