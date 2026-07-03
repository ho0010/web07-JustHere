import { useEffect, useRef, useCallback, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { encodeStateVector } from 'yjs'
import type { AwarenessState, CanvasAttachPayload, CanvasDetachPayload, YjsAwarenessPayload, YjsUpdateAck, YjsUpdatePayload } from '@/shared/types'
import { throttle, type ThrottledFunction } from '@/shared/utils'
import { useSocketClient } from '@/shared/hooks'
import { socketBaseUrl } from '@/shared/config/socket'
import { addSocketBreadcrumb, reportError } from '@/shared/utils'
import { CANVAS_EVENTS, CURSOR_FREQUENCY, YJS_EVENTS, YJS_UPDATE_RETRY_MS } from '@/pages/room/constants'
import { useCursorPresenceStore } from '@/pages/room/stores'
import { useYjsDoc, useYjsHistory, useYjsSocketEvents, useYjsTelemetry, useYjsCommands, YjsDurableOutbox, resolveYjsSyncStatus } from './yjs'

interface UseYjsSocketOptions {
  roomId: string
  canvasId: string
  serverUrl?: string
  userName: string
}

export function useYjsSocket({ roomId, canvasId, userName }: UseYjsSocketOptions) {
  const canvasIdRef = useRef(canvasId)
  const socketRef = useRef<Socket | null>(null)
  const syncReadyRef = useRef(false)
  const durableAckSupportedRef = useRef(false)
  const durableOutboxRef = useRef(new YjsDurableOutbox())
  const [isOutboxPersistenceReady, setIsOutboxPersistenceReady] = useState(false)
  const [outboxPersistenceError, setOutboxPersistenceError] = useState<Error | null>(null)
  const [pendingUpdateCount, setPendingUpdateCount] = useState(0)
  const [isSyncReady, setIsSyncReady] = useState(false)

  const applyAwareness = useCursorPresenceStore(state => state.applyAwareness)
  const clearCursors = useCursorPresenceStore(state => state.clearCursors)

  const {
    docRef,
    localPersistenceRef,
    isLocalPersistenceReady,
    localPersistenceError,
    localOriginRef,
    localMaxTimestampRef,
    sharedTypes,
    postits,
    placeCards,
    lines,
    textBoxes,
    zIndexOrder,
  } = useYjsDoc({ roomId, canvasId })

  const handleSocketError = useCallback(
    (error: Error) => {
      reportError({
        error,
        code: 'SOCKET_ERROR',
        context: {
          namespace: 'canvas',
          roomId,
          canvasId,
        },
      })
    },
    [roomId, canvasId],
  )
  const { trackHighFreq, trackHighFreqRef } = useYjsTelemetry({ roomId, canvasId })
  const emitDurablePayload = useCallback(
    (payload: YjsUpdatePayload, targetSocket: Socket | null = socketRef.current) => {
      if (!targetSocket?.connected) return false

      targetSocket.emit(YJS_EVENTS.update, payload)
      durableOutboxRef.current.markSent(payload.updateId)
      trackHighFreqRef.current(YJS_EVENTS.updateSend, payload.update.length)
      if (!durableAckSupportedRef.current) {
        durableOutboxRef.current.acknowledge({ ...payload, status: 'persisted' })
      }
      return true
    },
    [trackHighFreqRef],
  )
  const reconcilePendingUpdates = useCallback(
    (update: Uint8Array | null) => {
      const payload = durableOutboxRef.current.reconcile(canvasId, update)
      if (payload) emitDurablePayload(payload)
    },
    [canvasId, emitDurablePayload],
  )
  const markSyncReady = useCallback(() => {
    syncReadyRef.current = true
    setIsSyncReady(true)
  }, [])
  const setDurableAckCapability = useCallback((supported: boolean) => {
    durableAckSupportedRef.current = supported
  }, [])

  const cursorPositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const cursorChatRef = useRef<{ chatActive: boolean; chatMessage: string }>({ chatActive: false, chatMessage: '' })

  const { undoManagerRef, canUndo, canRedo, undo, redo, stopCapturing, updateHistoryState } = useYjsHistory({
    sharedTypes,
    localOriginRef,
  })

  const { getSocket, status } = useSocketClient({
    namespace: 'canvas',
    baseUrl: socketBaseUrl,
    onError: handleSocketError,
  })
  const isPersistenceReady = isLocalPersistenceReady && isOutboxPersistenceReady
  const isConnected = status === 'connected' && isPersistenceReady
  const syncStatus = resolveYjsSyncStatus({
    persistenceReady: isPersistenceReady,
    socketStatus: status,
    syncReady: isSyncReady,
    pendingUpdateCount,
    hasPersistenceError: localPersistenceError !== null || outboxPersistenceError !== null,
  })

  useEffect(() => {
    canvasIdRef.current = canvasId
  }, [canvasId])

  const emitAwareness = useCallback(
    (
      state: AwarenessState,
      options?: {
        socket?: Socket | null
        canvasId?: string
        track?: boolean
      },
    ) => {
      const targetSocket = options?.socket ?? socketRef.current
      if (!targetSocket?.connected) return

      const awarenessPayload: YjsAwarenessPayload = {
        canvasId: options?.canvasId ?? canvasIdRef.current,
        state,
      }
      targetSocket.emit(YJS_EVENTS.awareness, awarenessPayload)

      if (options?.track !== false) {
        trackHighFreqRef.current(YJS_EVENTS.awarenessSend)
      }
    },
    [trackHighFreqRef],
  )

  useEffect(() => {
    const outbox = durableOutboxRef.current
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let writeQueue: Promise<void> | null = null

    outbox.clear()
    setPendingUpdateCount(0)
    setIsOutboxPersistenceReady(false)
    setOutboxPersistenceError(null)

    if (!isLocalPersistenceReady) return

    const persistence = localPersistenceRef.current
    if (!persistence) {
      setIsOutboxPersistenceReady(true)
      return () => outbox.clear()
    }

    void persistence
      .loadOutbox()
      .then(payloads => {
        if (disposed) return

        outbox.restore(payloads, canvasId)
        setPendingUpdateCount(outbox.size)
        unsubscribe = outbox.subscribe(snapshot => {
          setPendingUpdateCount(snapshot.length)
          const save = writeQueue ? writeQueue.then(() => persistence.saveOutbox(snapshot)) : persistence.saveOutbox(snapshot)
          writeQueue = save
            .then(() => {
              if (!disposed) setOutboxPersistenceError(null)
            })
            .catch(error => {
              if (disposed) return
              const persistenceError = error instanceof Error ? error : new Error('Yjs outbox 저장에 실패했습니다.')
              setOutboxPersistenceError(persistenceError)
              reportError({
                error: persistenceError,
                code: 'CLIENT_UNKNOWN',
                level: 'warning',
                context: { source: 'yjs_outbox_save', roomId, canvasId },
              })
            })
        })
        setIsOutboxPersistenceReady(true)
      })
      .catch(error => {
        if (disposed) return
        const persistenceError = error instanceof Error ? error : new Error('Yjs outbox 복원에 실패했습니다.')
        setOutboxPersistenceError(persistenceError)
        reportError({
          error: persistenceError,
          code: 'CLIENT_UNKNOWN',
          level: 'warning',
          context: { source: 'yjs_outbox_load', roomId, canvasId },
        })
        if (!disposed) setIsOutboxPersistenceReady(true)
      })

    return () => {
      disposed = true
      unsubscribe?.()
      outbox.clear()
    }
  }, [roomId, canvasId, isLocalPersistenceReady, localPersistenceRef])

  useYjsSocketEvents({
    resolveSocket: getSocket,
    enabled: isPersistenceReady && status !== 'disconnected',
    roomId,
    canvasId,
    docRef,
    applyAwareness,
    trackHighFreq,
    onDurableAckCapability: setDurableAckCapability,
    onReconciledUpdate: reconcilePendingUpdates,
    onSynced: markSyncReady,
  })

  const updateCursorThrottledRef = useRef<ThrottledFunction<[number, number]> | null>(null)

  useEffect(() => {
    if (!isPersistenceReady) return

    const socket = getSocket()
    if (!socket) return

    const doc = docRef.current
    if (!doc) return

    socketRef.current = socket
    syncReadyRef.current = false

    const handleConnect = () => {
      syncReadyRef.current = false
      setIsSyncReady(false)
      durableAckSupportedRef.current = false
      const attachPayload: CanvasAttachPayload = {
        roomId,
        canvasId,
        clientStateVector: Array.from(encodeStateVector(doc)),
      }
      socket.emit(CANVAS_EVENTS.attach, attachPayload)
      addSocketBreadcrumb(CANVAS_EVENTS.attach, { roomId, canvasId })
    }

    const handleDisconnect = () => {
      syncReadyRef.current = false
      setIsSyncReady(false)
      durableAckSupportedRef.current = false
    }

    const handleUpdateAck = (ack: YjsUpdateAck) => {
      durableOutboxRef.current.acknowledge(ack)
    }

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === socket || !socket.connected || !syncReadyRef.current) return

      const updatePayload = durableOutboxRef.current.enqueue(canvasId, update)
      emitDurablePayload(updatePayload, socket)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(YJS_EVENTS.updateAck, handleUpdateAck)
    doc.on('update', handleUpdate)

    const retryInterval = window.setInterval(() => {
      if (!socket.connected || !syncReadyRef.current) return
      for (const pending of durableOutboxRef.current.getRetryable(YJS_UPDATE_RETRY_MS)) {
        emitDurablePayload(pending, socket)
      }
    }, 1000)

    if (socket.connected) {
      handleConnect()
    }

    return () => {
      emitAwareness({}, { socket, canvasId, track: false })

      const detachPayload: CanvasDetachPayload = { canvasId }
      socket.emit(CANVAS_EVENTS.detach, detachPayload)
      clearCursors()

      doc.off('update', handleUpdate)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(YJS_EVENTS.updateAck, handleUpdateAck)
      window.clearInterval(retryInterval)
      syncReadyRef.current = false
      setIsSyncReady(false)
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [roomId, canvasId, getSocket, clearCursors, status, docRef, socketRef, emitAwareness, emitDurablePayload, isPersistenceReady])

  useEffect(() => {
    const throttled = throttle((x: number, y: number) => {
      if (!socketRef.current?.connected) return
      cursorPositionRef.current = { x, y }
      const cursor = {
        x,
        y,
        name: userName,
        chatActive: cursorChatRef.current.chatActive,
        chatMessage: cursorChatRef.current.chatMessage,
      }
      emitAwareness({ cursor })
    }, CURSOR_FREQUENCY)

    updateCursorThrottledRef.current = throttled

    return () => {
      throttled.cancel()
      if (updateCursorThrottledRef.current === throttled) {
        updateCursorThrottledRef.current = null
      }
    }
  }, [emitAwareness, userName])

  const updateCursor = useCallback((x: number, y: number) => {
    updateCursorThrottledRef.current?.(x, y)
  }, [])

  const sendCursorChat = useCallback(
    (chatActive: boolean, chatMessage?: string) => {
      cursorChatRef.current = { chatActive, chatMessage: chatMessage ?? '' }
      const cursor = {
        x: cursorPositionRef.current.x,
        y: cursorPositionRef.current.y,
        name: userName,
        chatActive,
        chatMessage,
      }
      if (!socketRef.current?.connected) return

      emitAwareness({ cursor })
    },
    [emitAwareness, userName],
  )

  const { addPostIt, updatePostIt, addPlaceCard, updatePlaceCard, addLine, updateLine, addTextBox, updateTextBox, deleteCanvasItem, moveToTop } =
    useYjsCommands({
      docRef,
      undoManagerRef,
      localOriginRef,
      localMaxTimestampRef,
      updateHistoryState,
    })

  return {
    isConnected,
    syncStatus,
    pendingUpdateCount,
    postits,
    placeCards,
    lines,
    textBoxes,
    zIndexOrder,
    canUndo,
    canRedo,
    updateCursor,
    sendCursorChat,
    undo,
    redo,
    stopCapturing,
    addPostIt,
    updatePostIt,
    addPlaceCard,
    updatePlaceCard,
    addLine,
    updateLine,
    addTextBox,
    updateTextBox,
    deleteCanvasItem,
    moveToTop,
  }
}
