import { create } from 'zustand'
import type { AwarenessState, CursorInfoWithId, YjsAwarenessBroadcast } from '@/shared/types'
import { recordCanvasPerformanceCursorStoreCommit } from '@/pages/room/perf/canvasPerformance'

interface CursorPresenceState {
  cursors: Map<string, CursorInfoWithId>
  applyAwareness: (payload: YjsAwarenessBroadcast) => void
  clearCursors: () => void
}

const isSameCursor = (current: CursorInfoWithId | undefined, next: CursorInfoWithId) =>
  current !== undefined &&
  current.x === next.x &&
  current.y === next.y &&
  current.name === next.name &&
  current.chatActive === next.chatActive &&
  current.chatMessage === next.chatMessage

export const useCursorPresenceStore = create<CursorPresenceState>((set, get) => {
  const pendingBySocketId = new Map<string, AwarenessState>()
  let scheduledFrameId: number | null = null

  const flushPendingAwareness = () => {
    scheduledFrameId = null
    if (pendingBySocketId.size === 0) return

    const pendingEntries = Array.from(pendingBySocketId.entries())
    pendingBySocketId.clear()

    const next = new Map(get().cursors)
    let hasChanges = false

    pendingEntries.forEach(([socketId, state]) => {
      const cursor = state.cursor
      if (!cursor) {
        hasChanges = next.delete(socketId) || hasChanges
        return
      }

      const nextCursor: CursorInfoWithId = {
        x: cursor.x,
        y: cursor.y,
        name: cursor.name,
        chatActive: cursor.chatActive,
        chatMessage: cursor.chatMessage,
        socketId,
      }

      if (isSameCursor(next.get(socketId), nextCursor)) return
      next.set(socketId, nextCursor)
      hasChanges = true
    })

    if (!hasChanges) return
    set({ cursors: next })
    recordCanvasPerformanceCursorStoreCommit()
  }

  const clearPendingAwareness = () => {
    if (scheduledFrameId !== null) {
      cancelAnimationFrame(scheduledFrameId)
      scheduledFrameId = null
    }
    pendingBySocketId.clear()
  }

  return {
    cursors: new Map(),
    applyAwareness: ({ socketId, state }) => {
      pendingBySocketId.set(socketId, state)
      if (scheduledFrameId !== null) return
      scheduledFrameId = requestAnimationFrame(flushPendingAwareness)
    },
    clearCursors: () => {
      clearPendingAwareness()
      if (get().cursors.size === 0) return
      set({ cursors: new Map() })
    },
  }
})
