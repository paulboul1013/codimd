'use strict'

const fs = require('fs')
const path = require('path')
const Router = require('express').Router
const formidable = require('formidable')

const readChunk = require('read-chunk')
const imageType = require('image-type')
const mime = require('mime-types')

const config = require('../config')
const logger = require('../logger')
const response = require('../response')
const sanitizeSvg = require('./svg')

const imageRouter = module.exports = Router()

async function checkImageValid (filepath) {
  try {
    const extension = path.extname(filepath).toLowerCase()
    if (extension === '.svg') {
      if (!config.allowedUploadMimeTypes.includes('image/svg+xml')) return false
      // Read the whole XML document, with a bound on parser memory and CPU use.
      if ((await fs.promises.stat(filepath)).size > 5 * 1024 * 1024) return false
      return sanitizeSvg(await fs.promises.readFile(filepath))
    }
    const buffer = readChunk.sync(filepath, 0, 12)
    /** @type {{ ext: string, mime: string } | null} */
    const mimetypeFromBuf = imageType(buffer)
    if (extension === '.jfif') {
      return mimetypeFromBuf && mimetypeFromBuf.mime === 'image/jpeg' &&
        config.allowedUploadMimeTypes.includes('image/jpeg')
    }
    const mimeTypeFromExt = mime.lookup(extension)

    return mimetypeFromBuf && config.allowedUploadMimeTypes.includes(mimetypeFromBuf.mime) &&
          mimeTypeFromExt && config.allowedUploadMimeTypes.includes(mimeTypeFromExt)
  } catch (err) {
    logger.error(err)
    return false
  }
}

// upload image
imageRouter.post('/uploadimage', function (req, res) {
  var form = new formidable.IncomingForm({
    keepExtensions: true
  })

  form.parse(req, async function (err, fields, files) {
    if (err || !files.image || !files.image.filepath) {
      response.errorForbidden(req, res)
    } else {
      if (config.debug) {
        logger.info('SERVER received uploadimage: ' + JSON.stringify(files.image))
      }

      const validatedImage = await checkImageValid(files.image.filepath)
      if (!validatedImage) {
        await fs.promises.unlink(files.image.filepath).catch(() => {})
        return response.errorForbidden(req, res)
      }

      if (typeof validatedImage === 'string') {
        try {
          await fs.promises.writeFile(files.image.filepath, validatedImage, 'utf8')
        } catch (err) {
          await fs.promises.unlink(files.image.filepath).catch(() => {})
          logger.error(err)
          return res.status(500).end('upload image error')
        }
      }

      // Store JFIF as .jpg so every provider can infer the JPEG content type.
      const imagePath = files.image.filepath.replace(/\.jfif$/i, '.jpg')
      if (imagePath !== files.image.filepath) {
        try {
          await fs.promises.rename(files.image.filepath, imagePath)
          files.image.filepath = imagePath
        } catch (err) {
          fs.unlink(files.image.filepath, () => {})
          logger.error(err)
          return res.status(500).end('upload image error')
        }
      }

      const uploadProvider = require('./' + config.imageUploadType)
      uploadProvider.uploadImage(files.image.filepath, function (err, url) {
        // remove temporary upload file, and ignore any error
        fs.unlink(files.image.filepath, () => {})
        if (err !== null) {
          logger.error(err)
          return res.status(500).end('upload image error')
        }
        res.send({
          link: url
        })
      })
    }
  })
})
