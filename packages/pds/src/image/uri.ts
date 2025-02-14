import { createHmac } from 'crypto'
import * as uint8arrays from 'uint8arrays'
import { CID } from 'multiformats/cid'
import { Options } from './util'

type CommonSignedUris = 'avatar' | 'banner' | 'feed_thumbnail' | 'feed_fullsize'

export class ImageUriBuilder {
  public endpoint: string
  private salt: Uint8Array
  private key: Uint8Array

  constructor(
    endpoint: string,
    salt: Uint8Array | string,
    key: Uint8Array | string,
  ) {
    this.endpoint = endpoint
    this.salt =
      typeof salt === 'string' ? uint8arrays.fromString(salt, 'hex') : salt
    this.key =
      typeof key === 'string' ? uint8arrays.fromString(key, 'hex') : key
  }

  getSignedPath(opts: Options & { cid: CID }): string {
    const path = ImageUriBuilder.getPath(opts)
    const saltedPath = uint8arrays.concat([
      this.salt,
      uint8arrays.fromString(path),
    ])
    const sig = hmac(this.key, saltedPath).toString('base64url')
    return `/${sig}${path}`
  }

  getSignedUri(opts: Options & { cid: CID }): string {
    const path = this.getSignedPath(opts)
    return this.endpoint + path
  }

  getCommonSignedUri(id: CommonSignedUris, cid: string | CID): string {
    if (id === 'avatar') {
      return this.getSignedUri({
        cid: typeof cid === 'string' ? CID.parse(cid) : cid,
        format: 'jpeg',
        fit: 'cover',
        height: 500,
        width: 500,
        min: true,
      })
    } else if (id === 'banner') {
      return this.getSignedUri({
        cid: typeof cid === 'string' ? CID.parse(cid) : cid,
        format: 'jpeg',
        fit: 'cover',
        height: 500,
        width: 1500,
        min: true,
      })
    } else if (id === 'feed_fullsize') {
      return this.getSignedUri({
        cid: typeof cid === 'string' ? CID.parse(cid) : cid,
        format: 'jpeg',
        fit: 'inside',
        height: 1000,
        width: 1000,
        min: true,
      })
    } else if (id === 'feed_thumbnail') {
      return this.getSignedUri({
        cid: typeof cid === 'string' ? CID.parse(cid) : cid,
        format: 'jpeg',
        fit: 'cover',
        height: 500,
        width: 500,
        min: true,
      })
    } else {
      const exhaustiveCheck: never = id
      throw new Error(
        `Unrecognized requested common uri type: ${exhaustiveCheck}`,
      )
    }
  }

  getVerifiedOptions(path: string): Options & { cid: CID; signature: string } {
    if (path.at(0) !== '/') {
      throw new BadPathError('Invalid path: does not start with a slash')
    }
    const pathParts = path.split('/') // ['', sig, 'rs:fill:...', ...]
    const [sig] = pathParts.splice(1, 1) // ['', 'rs:fill:...', ...]
    const unsignedPath = pathParts.join('/')
    if (!sig || sig.includes(':')) {
      throw new BadPathError('Invalid path: missing signature')
    }
    const saltedPath = uint8arrays.concat([
      this.salt,
      uint8arrays.fromString(unsignedPath),
    ])
    const validSig = hmac(this.key, saltedPath).toString('base64url')
    if (sig !== validSig) {
      throw new BadPathError('Invalid path: bad signature')
    }
    const options = ImageUriBuilder.getOptions(unsignedPath)
    return {
      signature: validSig,
      ...options,
    }
  }

  static getPath(opts: Options & { cid: CID }) {
    const fit = opts.fit === 'inside' ? 'fit' : 'fill' // fit default is 'cover'
    const enlarge = opts.min === true ? 1 : 0 // min default is false
    const resize = `rs:${fit}:${opts.width}:${opts.height}:${enlarge}:0` // final ':0' is for interop with imgproxy
    const minWidth =
      opts.min && typeof opts.min === 'object' ? `mw:${opts.min.width}` : null
    const minHeight =
      opts.min && typeof opts.min === 'object' ? `mh:${opts.min.height}` : null
    const quality = opts.quality ? `q:${opts.quality}` : null
    return (
      `/` +
      [resize, minWidth, minHeight, quality].filter(Boolean).join('/') +
      `/plain/${opts.cid.toString()}@${opts.format}`
    )
  }

  static getOptions(path: string): Options & { cid: CID } {
    if (path.at(0) !== '/') {
      throw new BadPathError('Invalid path: does not start with a slash')
    }
    const parts = path.split('/')
    if (parts.at(-2) !== 'plain') {
      throw new BadPathError('Invalid path')
    }
    const cidAndFormat = parts.at(-1)
    const [cid, format, ...others] = cidAndFormat?.split('@') ?? []
    if (!cid || (format !== 'png' && format !== 'jpeg') || others.length) {
      throw new BadPathError('Invalid path: bad cid/format part')
    }
    const resizePart = parts.find((part) => part.startsWith('rs:'))
    const qualityPart = parts.find((part) => part.startsWith('q:'))
    const minWidthPart = parts.find((part) => part.startsWith('mw:'))
    const minHeightPart = parts.find((part) => part.startsWith('mh:'))
    const [, fit, width, height, enlarge] = resizePart?.split(':') ?? []
    const [, quality] = qualityPart?.split(':') ?? []
    const [, minWidth] = minWidthPart?.split(':') ?? []
    const [, minHeight] = minHeightPart?.split(':') ?? []
    if (fit !== 'fill' && fit !== 'fit') {
      throw new BadPathError('Invalid path: bad resize fit param')
    }
    if (isNaN(toInt(width)) || isNaN(toInt(height))) {
      throw new BadPathError('Invalid path: bad resize height/width param')
    }
    if (enlarge !== '0' && enlarge !== '1') {
      throw new BadPathError('Invalid path: bad resize enlarge param')
    }
    if (quality && isNaN(toInt(quality))) {
      throw new BadPathError('Invalid path: bad quality param')
    }
    if (
      (!minWidth && minHeight) ||
      (minWidth && !minHeight) ||
      (minWidth && isNaN(toInt(minWidth))) ||
      (minHeight && isNaN(toInt(minHeight))) ||
      (enlarge === '1' && (minHeight || minHeight))
    ) {
      throw new BadPathError('Invalid path: bad min width/height param')
    }
    return {
      cid: CID.parse(cid),
      format,
      height: toInt(height),
      width: toInt(width),
      fit: fit === 'fill' ? 'cover' : 'inside',
      quality: quality ? toInt(quality) : undefined,
      min:
        minWidth && minHeight
          ? { width: toInt(minWidth), height: toInt(minHeight) }
          : enlarge === '1',
    }
  }
}

export class BadPathError extends Error {}

function toInt(str: string) {
  if (!/^\d+$/.test(str)) {
    return NaN // String must be all numeric
  }
  return parseInt(str, 10)
}

function hmac(key: Uint8Array, message: Uint8Array) {
  return createHmac('sha256', key).update(message).digest()
}
