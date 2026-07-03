import { IndexeddbPersistence } from 'y-indexeddb'
import type { Doc as YDoc } from 'yjs'
import type { YjsUpdatePayload } from '@/shared/types'

const OUTBOX_METADATA_KEY = 'durable-outbox:v1'

export const createYjsLocalDatabaseName = (roomId: string, canvasId: string) => `justhere:yjs:v1:${roomId}:${canvasId}`

const isYjsUpdatePayload = (value: unknown): value is YjsUpdatePayload => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<YjsUpdatePayload>
  return (
    typeof candidate.canvasId === 'string' &&
    typeof candidate.updateId === 'string' &&
    Array.isArray(candidate.update) &&
    candidate.update.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

export class YjsLocalPersistence {
  private readonly provider: IndexeddbPersistence

  constructor(databaseName: string, doc: YDoc) {
    this.provider = new IndexeddbPersistence(databaseName, doc)
  }

  get whenSynced(): Promise<void> {
    return this.provider.whenSynced.then(() => undefined)
  }

  async loadOutbox(): Promise<YjsUpdatePayload[]> {
    const stored = await this.provider.get(OUTBOX_METADATA_KEY)
    if (typeof stored !== 'string') return []

    try {
      const parsed: unknown = JSON.parse(stored)
      return Array.isArray(parsed) ? parsed.filter(isYjsUpdatePayload) : []
    } catch {
      return []
    }
  }

  async saveOutbox(payloads: YjsUpdatePayload[]): Promise<void> {
    await this.provider.set(OUTBOX_METADATA_KEY, JSON.stringify(payloads))
  }

  async destroy(): Promise<void> {
    await this.provider.destroy()
  }

  async clearData(): Promise<void> {
    await this.provider.clearData()
  }
}
