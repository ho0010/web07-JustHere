import type { YjsUpdateAck, YjsUpdatePayload } from '@/shared/types'

interface PendingYjsUpdate {
  payload: YjsUpdatePayload
  lastSentAt: number | null
  attempts: number
}

type UpdateIdFactory = () => string
type Clock = () => number
type OutboxListener = (payloads: YjsUpdatePayload[]) => void
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class YjsDurableOutbox {
  private readonly pending = new Map<string, PendingYjsUpdate>()
  private readonly listeners = new Set<OutboxListener>()
  private readonly createUpdateId: UpdateIdFactory
  private readonly now: Clock

  constructor(createUpdateId: UpdateIdFactory = () => crypto.randomUUID(), now: Clock = () => Date.now()) {
    this.createUpdateId = createUpdateId
    this.now = now
  }

  enqueue(canvasId: string, update: Uint8Array): YjsUpdatePayload {
    const payload = this.createPayload(canvasId, update)
    this.pending.set(payload.updateId, { payload, lastSentAt: null, attempts: 0 })
    this.notifyChange()
    return payload
  }

  reconcile(canvasId: string, update: Uint8Array | null): YjsUpdatePayload | null {
    this.pending.clear()
    const payload = update ? this.createPayload(canvasId, update) : null
    if (payload) {
      this.pending.set(payload.updateId, { payload, lastSentAt: null, attempts: 0 })
    }
    this.notifyChange()
    return payload
  }

  acknowledge(ack: YjsUpdateAck): boolean {
    const pending = this.pending.get(ack.updateId)
    if (!pending || pending.payload.canvasId !== ack.canvasId) return false

    this.pending.delete(ack.updateId)
    this.notifyChange()
    return true
  }

  markSent(updateId: string): void {
    const pending = this.pending.get(updateId)
    if (!pending) return

    pending.lastSentAt = this.now()
    pending.attempts += 1
  }

  getRetryable(retryAfterMs: number): YjsUpdatePayload[] {
    const now = this.now()
    return [...this.pending.values()]
      .filter(pending => pending.lastSentAt === null || now - pending.lastSentAt >= retryAfterMs)
      .map(pending => pending.payload)
  }

  clear(): void {
    if (this.pending.size === 0) return
    this.pending.clear()
    this.notifyChange()
  }

  restore(payloads: YjsUpdatePayload[], canvasId: string): number {
    this.pending.clear()
    for (const payload of payloads) {
      if (!this.isValidPayload(payload, canvasId)) continue
      this.pending.set(payload.updateId, {
        payload: { ...payload, update: [...payload.update] },
        lastSentAt: null,
        attempts: 0,
      })
    }
    return this.pending.size
  }

  snapshot(): YjsUpdatePayload[] {
    return [...this.pending.values()].map(({ payload }) => ({ ...payload, update: [...payload.update] }))
  }

  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get size(): number {
    return this.pending.size
  }

  private createPayload(canvasId: string, update: Uint8Array): YjsUpdatePayload {
    return {
      canvasId,
      updateId: this.createUpdateId(),
      update: Array.from(update),
    }
  }

  private isValidPayload(payload: YjsUpdatePayload, canvasId: string): boolean {
    return (
      payload.canvasId === canvasId &&
      UUID_PATTERN.test(payload.updateId) &&
      Array.isArray(payload.update) &&
      payload.update.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    )
  }

  private notifyChange(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
