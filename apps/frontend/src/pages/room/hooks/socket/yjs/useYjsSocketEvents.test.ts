import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import * as Y from 'yjs'
import { CANVAS_EVENTS, YJS_EVENTS } from '@/pages/room/constants'
import { useYjsSocketEvents } from './useYjsSocketEvents'

const effectState = vi.hoisted(() => ({
  cleanups: [] as Array<(() => void) | undefined>,
}))

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    effectState.cleanups.push(effect() ?? undefined)
  },
}))

vi.mock('@/shared/utils', () => ({
  addSocketBreadcrumb: vi.fn(),
}))

describe('useYjsSocketEvents', () => {
  afterEach(() => {
    effectState.cleanups.splice(0).forEach(cleanup => cleanup?.())
    vi.clearAllMocks()
  })

  it('서버의 canvas:attached 이벤트로 초기 Yjs 문서를 적용한다', () => {
    const on = vi.fn()
    const off = vi.fn()
    const emit = vi.fn()
    const socket = { on, off, emit } as unknown as Socket
    const onReconciledUpdate = vi.fn()
    const onDurableAckCapability = vi.fn()
    const targetDoc = new Y.Doc()
    const sourceDoc = new Y.Doc()
    sourceDoc.getMap('fixture').set('loaded', true)

    const TestHarness = () => {
      useYjsSocketEvents({
        resolveSocket: () => socket,
        roomId: 'room-id',
        canvasId: 'canvas-id',
        docRef: { current: targetDoc },
        applyAwareness: vi.fn(),
        trackHighFreq: vi.fn(),
        onDurableAckCapability,
        onReconciledUpdate,
      })
      return null
    }

    TestHarness()

    const attachedCall = on.mock.calls.find(([event]) => event === CANVAS_EVENTS.attached)
    expect(attachedCall).toBeDefined()
    expect(on).not.toHaveBeenCalledWith(CANVAS_EVENTS.attach, expect.any(Function))

    const handleAttached = attachedCall?.[1] as (payload: { update: number[]; serverStateVector: number[] }) => void
    handleAttached({
      update: Array.from(Y.encodeStateAsUpdate(sourceDoc)),
      serverStateVector: Array.from(Y.encodeStateVector(sourceDoc)),
    })

    expect(targetDoc.getMap('fixture').get('loaded')).toBe(true)
    expect(onDurableAckCapability).toHaveBeenCalledWith(false)
    expect(onReconciledUpdate).toHaveBeenCalledWith(null)
    expect(emit).not.toHaveBeenCalledWith(YJS_EVENTS.update, expect.anything())

    sourceDoc.destroy()
    targetDoc.destroy()
  })

  it('재접속 시 서버 diff를 적용한 뒤 서버에 없는 로컬 diff를 전송해야 한다', () => {
    const on = vi.fn()
    const off = vi.fn()
    const emit = vi.fn()
    const socket = { on, off, emit } as unknown as Socket
    const onSynced = vi.fn()
    const onReconciledUpdate = vi.fn()
    const onDurableAckCapability = vi.fn()
    const serverDoc = new Y.Doc()
    const clientDoc = new Y.Doc()

    const baseDoc = new Y.Doc()
    baseDoc.getMap('fixture').set('base', true)
    const baseUpdate = Y.encodeStateAsUpdate(baseDoc)
    Y.applyUpdate(serverDoc, baseUpdate)
    Y.applyUpdate(clientDoc, baseUpdate)

    serverDoc.getMap('fixture').set('server-only', 'online edit')
    clientDoc.getMap('fixture').set('client-only', 'offline edit')

    const TestHarness = () => {
      useYjsSocketEvents({
        resolveSocket: () => socket,
        roomId: 'room-id',
        canvasId: 'canvas-id',
        docRef: { current: clientDoc },
        applyAwareness: vi.fn(),
        trackHighFreq: vi.fn(),
        onDurableAckCapability,
        onReconciledUpdate,
        onSynced,
      })
      return null
    }

    TestHarness()

    const handleAttached = on.mock.calls.find(([event]) => event === CANVAS_EVENTS.attached)?.[1] as (payload: {
      update: number[]
      serverStateVector: number[]
      durableAckSupported?: boolean
    }) => void

    handleAttached({
      update: Array.from(Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(clientDoc))),
      serverStateVector: Array.from(Y.encodeStateVector(serverDoc)),
      durableAckSupported: true,
    })

    expect(onReconciledUpdate).toHaveBeenCalledOnce()
    expect(onDurableAckCapability).toHaveBeenCalledWith(true)
    const clientUpdate = onReconciledUpdate.mock.calls[0][0] as Uint8Array
    Y.applyUpdate(serverDoc, clientUpdate)
    expect(emit).not.toHaveBeenCalledWith(YJS_EVENTS.update, expect.anything())

    expect(clientDoc.getMap('fixture').toJSON()).toEqual({
      base: true,
      'client-only': 'offline edit',
      'server-only': 'online edit',
    })
    expect(serverDoc.getMap('fixture').toJSON()).toEqual(clientDoc.getMap('fixture').toJSON())
    expect(onSynced).toHaveBeenCalledOnce()

    baseDoc.destroy()
    clientDoc.destroy()
    serverDoc.destroy()
  })

  it('구버전 서버 응답에 state vector가 없으면 역방향 diff 없이 기존 update만 적용해야 한다', () => {
    const on = vi.fn()
    const off = vi.fn()
    const emit = vi.fn()
    const socket = { on, off, emit } as unknown as Socket
    const onDurableAckCapability = vi.fn()
    const targetDoc = new Y.Doc()
    const sourceDoc = new Y.Doc()
    sourceDoc.getMap('fixture').set('loaded', true)

    const TestHarness = () => {
      useYjsSocketEvents({
        resolveSocket: () => socket,
        roomId: 'room-id',
        canvasId: 'canvas-id',
        docRef: { current: targetDoc },
        applyAwareness: vi.fn(),
        trackHighFreq: vi.fn(),
        onDurableAckCapability,
      })
      return null
    }

    TestHarness()

    const handleAttached = on.mock.calls.find(([event]) => event === CANVAS_EVENTS.attached)?.[1] as (payload: { update: number[] }) => void
    handleAttached({ update: Array.from(Y.encodeStateAsUpdate(sourceDoc)) })

    expect(targetDoc.getMap('fixture').get('loaded')).toBe(true)
    expect(onDurableAckCapability).toHaveBeenCalledWith(false)
    expect(emit).not.toHaveBeenCalledWith(YJS_EVENTS.update, expect.anything())

    sourceDoc.destroy()
    targetDoc.destroy()
  })
})
