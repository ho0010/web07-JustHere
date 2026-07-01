import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YjsAwarenessBroadcast } from '@/shared/types'
import { recordCanvasPerformanceCursorStoreCommit } from '@/pages/room/perf/canvasPerformance'
import { useCursorPresenceStore } from './useCursorPresenceStore'

vi.mock('@/pages/room/perf/canvasPerformance', () => ({
  recordCanvasPerformanceCursorStoreCommit: vi.fn(),
}))

const frameCallbacks = new Map<number, FrameRequestCallback>()
let frameId = 0

const createCursorPayload = (socketId: string, x: number, message = ''): YjsAwarenessBroadcast => ({
  socketId,
  state: {
    cursor: {
      x,
      y: x * 2,
      name: `user-${socketId}`,
      chatActive: message.length > 0,
      chatMessage: message,
    },
  },
})

const flushNextFrame = () => {
  const next = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined
  if (!next) throw new Error('예약된 animation frame이 없습니다.')
  const [id, callback] = next
  frameCallbacks.delete(id)
  callback(performance.now())
}

describe('useCursorPresenceStore', () => {
  beforeEach(() => {
    frameCallbacks.clear()
    frameId = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameId += 1
        frameCallbacks.set(frameId, callback)
        return frameId
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frameCallbacks.delete(id)
      }),
    )

    useCursorPresenceStore.getState().clearCursors()
    useCursorPresenceStore.setState({ cursors: new Map() })
    vi.clearAllMocks()
  })

  afterEach(() => {
    useCursorPresenceStore.getState().clearCursors()
    vi.unstubAllGlobals()
  })

  it('한 frame의 awareness를 한 번의 store commit으로 반영한다', () => {
    const { applyAwareness } = useCursorPresenceStore.getState()

    applyAwareness(createCursorPayload('socket-a', 10))
    applyAwareness(createCursorPayload('socket-b', 20))
    applyAwareness(createCursorPayload('socket-a', 30, '최신 메시지'))

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(useCursorPresenceStore.getState().cursors.size).toBe(0)

    flushNextFrame()

    const cursors = useCursorPresenceStore.getState().cursors
    expect(cursors.size).toBe(2)
    expect(cursors.get('socket-a')).toMatchObject({ x: 30, y: 60, chatActive: true, chatMessage: '최신 메시지' })
    expect(cursors.get('socket-b')).toMatchObject({ x: 20, y: 40 })
    expect(recordCanvasPerformanceCursorStoreCommit).toHaveBeenCalledTimes(1)
  })

  it('cursor가 없는 최신 awareness를 frame에서 반영해 사용자를 제거한다', () => {
    const { applyAwareness } = useCursorPresenceStore.getState()
    applyAwareness(createCursorPayload('socket-a', 10))
    flushNextFrame()

    applyAwareness({ socketId: 'socket-a', state: {} })
    expect(useCursorPresenceStore.getState().cursors.has('socket-a')).toBe(true)

    flushNextFrame()

    expect(useCursorPresenceStore.getState().cursors.has('socket-a')).toBe(false)
    expect(recordCanvasPerformanceCursorStoreCommit).toHaveBeenCalledTimes(2)
  })

  it('clearCursors가 예약된 frame과 pending awareness를 함께 제거한다', () => {
    const { applyAwareness, clearCursors } = useCursorPresenceStore.getState()
    applyAwareness(createCursorPayload('socket-a', 10))
    flushNextFrame()

    applyAwareness(createCursorPayload('socket-a', 20))

    clearCursors()

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(frameCallbacks.size).toBe(0)
    expect(useCursorPresenceStore.getState().cursors.size).toBe(0)
    expect(recordCanvasPerformanceCursorStoreCommit).toHaveBeenCalledTimes(1)
  })
})
