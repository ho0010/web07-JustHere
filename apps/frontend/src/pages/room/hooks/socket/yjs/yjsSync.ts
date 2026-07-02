import { decodeUpdate, encodeStateAsUpdate, type Doc as YDoc } from 'yjs'

export const createMissingYjsUpdate = (doc: YDoc, remoteStateVector: Uint8Array): Uint8Array | null => {
  const update = encodeStateAsUpdate(doc, remoteStateVector)
  const decoded = decodeUpdate(update)

  if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) {
    return null
  }

  return update
}
