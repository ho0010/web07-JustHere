import { useEffect } from 'react'
import { Doc as YDoc, applyUpdate as YapplyUpdate } from 'yjs'
import type { Socket } from 'socket.io-client'
import type { CanvasAttachedPayload, YjsAwarenessBroadcast, YjsUpdateBroadcast } from '@/shared/types'
import { addSocketBreadcrumb } from '@/shared/utils'
import { CANVAS_EVENTS, YJS_EVENTS } from '@/pages/room/constants'
import { measureCanvasPerformance, recordCanvasPerformanceAwarenessReceived, recordCanvasPerformanceInboundUpdate } from '@/pages/room/perf'
import { createMissingYjsUpdate } from './yjsSync'

interface UseYjsSocketEventsOptions {
  resolveSocket: () => Socket | null
  enabled?: boolean
  roomId: string
  canvasId: string
  docRef: { current: YDoc | null }
  applyAwareness: (payload: YjsAwarenessBroadcast) => void
  trackHighFreq: (key: string, bytes?: number) => void
  onSynced?: () => void
}

export const useYjsSocketEvents = ({
  resolveSocket,
  enabled = true,
  roomId,
  canvasId,
  docRef,
  applyAwareness,
  trackHighFreq,
  onSynced,
}: UseYjsSocketEventsOptions) => {
  useEffect(() => {
    if (!enabled) return

    const socket = resolveSocket()
    const doc = docRef.current
    if (!socket || !doc) return

    const handleCanvasAttached = ({ update, serverStateVector }: CanvasAttachedPayload) => {
      const updateArray = update ? new Uint8Array(update) : null
      if (updateArray && updateArray.byteLength > 0) {
        measureCanvasPerformance('yjsInitialApply', () => YapplyUpdate(doc, updateArray, socket))
      }

      const clientUpdate = serverStateVector ? createMissingYjsUpdate(doc, new Uint8Array(serverStateVector)) : null
      if (clientUpdate) {
        trackHighFreq(YJS_EVENTS.updateSend, clientUpdate.byteLength)
        socket.emit(YJS_EVENTS.update, { canvasId, update: Array.from(clientUpdate) })
      }

      addSocketBreadcrumb(CANVAS_EVENTS.attached, {
        roomId,
        canvasId,
        receivedBytes: updateArray?.byteLength ?? 0,
        returnedBytes: clientUpdate?.byteLength ?? 0,
      })
      onSynced?.()
    }

    const handleCanvasDetached = () => {
      addSocketBreadcrumb(CANVAS_EVENTS.detached, { roomId, canvasId })
    }

    const handleYjsUpdate = ({ canvasId: payloadCanvasId, update }: YjsUpdateBroadcast) => {
      if (payloadCanvasId !== canvasId) return
      const updateArray = new Uint8Array(update)
      recordCanvasPerformanceInboundUpdate(updateArray.byteLength)
      measureCanvasPerformance('yjsUpdateApply', () => YapplyUpdate(doc, updateArray, socket))
      trackHighFreq(YJS_EVENTS.updateRecv, updateArray.byteLength)
    }

    const handleAwareness = (payload: YjsAwarenessBroadcast) => {
      recordCanvasPerformanceAwarenessReceived()
      trackHighFreq(YJS_EVENTS.awarenessRecv)
      applyAwareness(payload)
    }

    socket.on(CANVAS_EVENTS.attached, handleCanvasAttached)
    socket.on(CANVAS_EVENTS.detached, handleCanvasDetached)
    socket.on(YJS_EVENTS.update, handleYjsUpdate)
    socket.on(YJS_EVENTS.awareness, handleAwareness)

    return () => {
      socket.off(CANVAS_EVENTS.attached, handleCanvasAttached)
      socket.off(CANVAS_EVENTS.detached, handleCanvasDetached)
      socket.off(YJS_EVENTS.update, handleYjsUpdate)
      socket.off(YJS_EVENTS.awareness, handleAwareness)
    }
  }, [resolveSocket, enabled, roomId, canvasId, docRef, applyAwareness, trackHighFreq, onSynced])
}
