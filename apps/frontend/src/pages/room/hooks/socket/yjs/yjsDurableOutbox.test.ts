import { describe, expect, it } from 'vitest'
import { YjsDurableOutbox } from './yjsDurableOutbox'

describe('YjsDurableOutbox', () => {
  it('ack 전 update를 보관하고 일치하는 ack가 오면 제거해야 한다', () => {
    const outbox = new YjsDurableOutbox(() => '00000000-0000-4000-8000-000000000001')
    const payload = outbox.enqueue('canvas-1', new Uint8Array([1, 2, 3]))

    expect(outbox.size).toBe(1)
    expect(payload).toEqual({
      canvasId: 'canvas-1',
      updateId: '00000000-0000-4000-8000-000000000001',
      update: [1, 2, 3],
    })
    expect(outbox.acknowledge({ ...payload, status: 'persisted' })).toBe(true)
    expect(outbox.size).toBe(0)
  })

  it('다른 canvas의 ack로 pending update를 제거하지 않아야 한다', () => {
    const outbox = new YjsDurableOutbox(() => '00000000-0000-4000-8000-000000000001')
    const payload = outbox.enqueue('canvas-1', new Uint8Array([1]))

    expect(outbox.acknowledge({ canvasId: 'canvas-2', updateId: payload.updateId, status: 'duplicate' })).toBe(false)
    expect(outbox.size).toBe(1)
  })

  it('재시도 시간이 지난 pending update만 반환해야 한다', () => {
    let now = 1000
    const outbox = new YjsDurableOutbox(
      () => '00000000-0000-4000-8000-000000000001',
      () => now,
    )
    const payload = outbox.enqueue('canvas-1', new Uint8Array([1]))

    expect(outbox.getRetryable(10000)).toEqual([payload])
    outbox.markSent(payload.updateId)
    now = 10999
    expect(outbox.getRetryable(10000)).toEqual([])
    now = 11000
    expect(outbox.getRetryable(10000)).toEqual([payload])
  })

  it('재접속 diff로 기존 pending을 교체해야 한다', () => {
    let sequence = 0
    const outbox = new YjsDurableOutbox(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`)
    outbox.enqueue('canvas-1', new Uint8Array([1]))
    outbox.enqueue('canvas-1', new Uint8Array([2]))

    const reconciled = outbox.reconcile('canvas-1', new Uint8Array([3, 4]))

    expect(outbox.size).toBe(1)
    expect(reconciled?.update).toEqual([3, 4])
    expect(outbox.getRetryable(10000)).toEqual([reconciled])
  })

  it('서버에 없는 diff가 없으면 기존 pending을 모두 제거해야 한다', () => {
    const outbox = new YjsDurableOutbox(() => '00000000-0000-4000-8000-000000000001')
    outbox.enqueue('canvas-1', new Uint8Array([1]))

    expect(outbox.reconcile('canvas-1', null)).toBeNull()
    expect(outbox.size).toBe(0)
  })
})
