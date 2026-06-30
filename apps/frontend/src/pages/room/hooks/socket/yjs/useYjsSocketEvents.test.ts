import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'socket.io-client'
import * as Y from 'yjs'
import { CANVAS_EVENTS } from '@/pages/room/constants'
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
    const socket = { on, off } as unknown as Socket
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
      })
      return null
    }

    TestHarness()

    const attachedCall = on.mock.calls.find(([event]) => event === CANVAS_EVENTS.attached)
    expect(attachedCall).toBeDefined()
    expect(on).not.toHaveBeenCalledWith(CANVAS_EVENTS.attach, expect.any(Function))

    const handleAttached = attachedCall?.[1] as (payload: { update: number[] }) => void
    handleAttached({ update: Array.from(Y.encodeStateAsUpdate(sourceDoc)) })

    expect(targetDoc.getMap('fixture').get('loaded')).toBe(true)

    sourceDoc.destroy()
    targetDoc.destroy()
  })
})
