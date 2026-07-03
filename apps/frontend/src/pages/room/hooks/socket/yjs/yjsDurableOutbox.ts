import type { YjsUpdateAck, YjsUpdatePayload } from '@/shared/types'

interface PendingYjsUpdate {
  payload: YjsUpdatePayload
  lastSentAt: number | null
  attempts: number
}

type UpdateIdFactory = () => string
type Clock = () => number

export class YjsDurableOutbox {
  private readonly pending = new Map<string, PendingYjsUpdate>()
  private readonly createUpdateId: UpdateIdFactory
  private readonly now: Clock

  constructor(createUpdateId: UpdateIdFactory = () => crypto.randomUUID(), now: Clock = () => Date.now()) {
    this.createUpdateId = createUpdateId
    this.now = now
  }

  enqueue(canvasId: string, update: Uint8Array): YjsUpdatePayload {
    const payload: YjsUpdatePayload = {
      canvasId,
      updateId: this.createUpdateId(),
      update: Array.from(update),
    }
    this.pending.set(payload.updateId, { payload, lastSentAt: null, attempts: 0 })
    return payload
  }

  reconcile(canvasId: string, update: Uint8Array | null): YjsUpdatePayload | null {
    this.pending.clear()
    return update ? this.enqueue(canvasId, update) : null
  }

  acknowledge(ack: YjsUpdateAck): boolean {
    const pending = this.pending.get(ack.updateId)
    if (!pending || pending.payload.canvasId !== ack.canvasId) return false

    this.pending.delete(ack.updateId)
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
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
