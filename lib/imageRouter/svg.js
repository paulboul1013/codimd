'use strict'

const { TextDecoder } = require('util')
const { SaxesParser } = require('saxes')
const css = require('css-tree')

const svgNamespace = 'http://www.w3.org/2000/svg'
const xlinkNamespace = 'http://www.w3.org/1999/xlink'
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace'

// Keep static vector graphics. Unknown elements and their subtrees are removed.
const elements = new Set(`svg g defs title desc symbol use switch view style
  path rect circle ellipse line polyline polygon text tspan textPath
  linearGradient radialGradient stop pattern clipPath mask marker image
  filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix
  feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood
  feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode
  feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile
  feTurbulence`.split(/\s+/))

const attributes = new Set(`id class x y x1 x2 y1 y2 dx dy cx cy r rx ry
  width height viewBox preserveAspectRatio transform d points pathLength
  href offset gradientUnits gradientTransform spreadMethod fx fy fr
  patternUnits patternContentUnits patternTransform clipPathUnits maskUnits
  maskContentUnits markerWidth markerHeight markerUnits refX refY orient
  textLength lengthAdjust rotate filterUnits primitiveUnits in in2 result
  type values mode operator k1 k2 k3 k4 order kernelMatrix divisor bias
  targetX targetY edgeMode kernelUnitLength preserveAlpha surfaceScale
  diffuseConstant specularConstant specularExponent limitingConeAngle
  scale xChannelSelector yChannelSelector stdDeviation radius azimuth
  elevation z pointsAtX pointsAtY pointsAtZ exponent amplitude intercept
  slope tableValues seed numOctaves baseFrequency stitchTiles`.split(/\s+/))

// Presentation properties may appear as XML attributes or CSS declarations.
const properties = new Set(`fill fill-opacity fill-rule stroke stroke-width
  stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit
  stroke-dasharray stroke-dashoffset opacity color color-interpolation
  color-interpolation-filters stop-color stop-opacity flood-color flood-opacity
  lighting-color clip-path clip-rule mask filter marker marker-start marker-mid
  marker-end display visibility overflow vector-effect paint-order
  font-family font-size font-style font-weight font-variant font-stretch
  text-anchor text-decoration dominant-baseline alignment-baseline baseline-shift
  letter-spacing word-spacing white-space writing-mode direction unicode-bidi
  shape-rendering text-rendering image-rendering transform transform-origin`.split(/\s+/))

const functions = new Set(`rgb rgba hsl hsla hwb lab lch oklab oklch color
  color-mix calc min max clamp matrix matrix3d translate translateX translateY
  scale scaleX scaleY rotate skewX skewY`.toLowerCase().split(/\s+/))

function escapeXml (text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isLocalReference (value) {
  return /^#[^\s"'<>()[\]\\]+$/.test(value)
}

function safeCssValue (value) {
  let ast
  try {
    ast = css.parse(value, { context: 'value' })
  } catch (err) {
    return null
  }
  let safe = true
  css.walk(ast, node => {
    if (node.type === 'Raw' ||
      (node.type === 'Url' && !isLocalReference(node.value)) ||
      (node.type === 'Function' && !functions.has(css.ident.decode(node.name).toLowerCase()))) {
      safe = false
    }
  })
  return safe ? css.generate(ast) : null
}

function sanitizeCss (text, context) {
  const ast = css.parse(text, { context })
  css.walk(ast, {
    enter (node, item, list) {
      if (node.type === 'Atrule' || node.type === 'Raw') {
        list.remove(item)
        return this.skip
      }
      if (node.type === 'Declaration') {
        const property = css.ident.decode(node.property).toLowerCase()
        if (!properties.has(property) || safeCssValue(css.generate(node.value)) === null) {
          list.remove(item)
        }
        return this.skip
      }
    }
  })
  return css.generate(ast)
}

/** Parse and serialize a standalone SVG, retaining only static image content. */
module.exports = function sanitizeSvg (buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  const parser = new SaxesParser({ xmlns: true })
  const stack = []
  const output = []
  let hasRoot = false

  parser.on('doctype', () => { throw new Error('SVG document types are not allowed') })
  parser.on('opentag', node => {
    if (!hasRoot) {
      if (node.local !== 'svg' || node.uri !== svgNamespace) throw new Error('Invalid SVG root')
      hasRoot = true
    }
    if (stack.length >= 100) throw new Error('SVG nesting is too deep')
    const parent = stack[stack.length - 1]
    const keep = (!parent || parent.keep) && node.uri === svgNamespace && elements.has(node.local)
    const entry = { keep, name: node.local, text: '' }
    stack.push(entry)
    if (!keep) return

    output.push('<' + node.local)
    if (stack.length === 1) {
      output.push(` xmlns="${svgNamespace}" xmlns:xlink="${xlinkNamespace}"`)
    }
    for (const attr of Object.values(node.attributes)) {
      let name = attr.local
      let value = attr.value
      if (attr.uri === xmlNamespace && ['lang', 'space'].includes(name)) {
        name = 'xml:' + name
      } else if (attr.uri && !(attr.uri === xlinkNamespace && name === 'href')) {
        continue
      } else if (name === 'href') {
        if (!isLocalReference(value)) continue
        if (attr.uri === xlinkNamespace) name = 'xlink:href'
      } else if (name === 'style') {
        value = sanitizeCss(value, 'declarationList')
      } else if (properties.has(name)) {
        value = safeCssValue(value)
        if (value === null) continue
      } else if (!attributes.has(name)) {
        continue
      }
      output.push(` ${name}="${escapeXml(value)}"`)
    }
    output.push('>')
  })

  const appendText = text => {
    const current = stack[stack.length - 1]
    if (!current || !current.keep) return
    if (current.name === 'style') current.text += text
    else output.push(escapeXml(text))
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', () => {
    const current = stack.pop()
    if (!current.keep) return
    if (current.name === 'style') output.push(escapeXml(sanitizeCss(current.text, 'stylesheet')))
    output.push(`</${current.name}>`)
  })
  parser.write(text).close()
  if (!hasRoot) throw new Error('Missing SVG root')
  return output.join('')
}
