import stream from 'stream'
import { CID } from 'multiformats/cid'
import { BlobNotFoundError, BlobStore } from '@atproto/repo'
import { randomStr } from '@atproto/crypto'
import { bytesToStream, streamToArray } from '@atproto/common'

export class MemoryBlobStore implements BlobStore {
  temp: Map<string, Uint8Array> = new Map()
  blocks: Map<string, Uint8Array> = new Map()

  constructor() {}

  private genKey() {
    return randomStr(32, 'base32')
  }

  async hasTemp(key: string): Promise<boolean> {
    return this.temp.has(key)
  }

  async hasStored(cid: CID): Promise<boolean> {
    return this.blocks.has(cid.toString())
  }

  async putTemp(bytes: Uint8Array | stream.Readable): Promise<string> {
    const key = this.genKey()
    let byteArray: Uint8Array
    if (ArrayBuffer.isView(bytes)) {
      byteArray = bytes
    } else {
      byteArray = await streamToArray(bytes)
    }
    this.temp.set(key, byteArray)
    return key
  }

  async makePermanent(key: string, cid: CID): Promise<void> {
    const value = this.temp.get(key)
    if (!value) {
      throw new BlobNotFoundError()
    }
    this.blocks.set(cid.toString(), value)
    this.temp.delete(key)
  }

  async putPermanent(
    cid: CID,
    bytes: Uint8Array | stream.Readable,
  ): Promise<void> {
    let byteArray: Uint8Array
    if (ArrayBuffer.isView(bytes)) {
      byteArray = bytes
    } else {
      byteArray = await streamToArray(bytes)
    }
    this.blocks.set(cid.toString(), byteArray)
  }

  async getBytes(cid: CID): Promise<Uint8Array> {
    const value = this.blocks.get(cid.toString())
    if (!value) {
      throw new BlobNotFoundError()
    }
    return value
  }

  async getStream(cid: CID): Promise<stream.Readable> {
    const bytes = await this.getBytes(cid)
    return bytesToStream(bytes)
  }
}

export default MemoryBlobStore
