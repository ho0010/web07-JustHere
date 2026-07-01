import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Group } from 'react-konva'
import { Html } from 'react-konva-utils'
import Konva from 'konva'
import { CursorIcon } from '@/shared/assets'
import type { CursorInfoWithId } from '@/shared/types'
import { getCursorColor, getParticipantColor, cn } from '@/shared/utils'
import type { CursorAnimationScheduler } from '../cursorAnimationScheduler'

interface AnimatedCursorProps {
  cursor: CursorInfoWithId
  animationScheduler: CursorAnimationScheduler
}

export const AnimatedCursor = React.memo(({ cursor, animationScheduler }: AnimatedCursorProps) => {
  const groupRef = useRef<Konva.Group>(null)
  const initialPositionRef = useRef({ x: cursor.x, y: cursor.y })

  const [isChatFading, setIsChatFading] = useState(false)
  const [isChatFaded, setIsChatFaded] = useState(false)
  const chatInactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevChatMessageRef = useRef(cursor.chatMessage)

  const deactivateFade = useCallback(() => {
    if (chatInactivityTimerRef.current) {
      clearTimeout(chatInactivityTimerRef.current)
      chatInactivityTimerRef.current = null
    }
    if (chatFadeTimerRef.current) {
      clearTimeout(chatFadeTimerRef.current)
      chatFadeTimerRef.current = null
    }
    setIsChatFading(false)
    setIsChatFaded(false)
  }, [])

  const startFadeOut = useCallback(() => {
    setIsChatFading(true)
    chatFadeTimerRef.current = setTimeout(() => {
      setIsChatFading(false)
      setIsChatFaded(true)
      chatFadeTimerRef.current = null
    }, 3000)
  }, [])

  const resetInactivityTimer = useCallback(() => {
    if (chatInactivityTimerRef.current) {
      clearTimeout(chatInactivityTimerRef.current)
    }
    if (chatFadeTimerRef.current) {
      clearTimeout(chatFadeTimerRef.current)
      chatFadeTimerRef.current = null
    }
    setIsChatFading(false)
    setIsChatFaded(false)

    chatInactivityTimerRef.current = setTimeout(() => {
      startFadeOut()
    }, 3000)
  }, [startFadeOut])

  /* eslint-disable react-hooks/set-state-in-effect -- 기존 채팅 fade 상태를 외부 cursor 상태와 동기화한다. */
  useEffect(() => {
    if (cursor.chatActive) {
      if (prevChatMessageRef.current !== cursor.chatMessage) {
        prevChatMessageRef.current = cursor.chatMessage
        resetInactivityTimer()
      }
    } else {
      deactivateFade()
    }
  }, [cursor.chatActive, cursor.chatMessage, resetInactivityTimer, deactivateFade])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    return () => {
      if (chatInactivityTimerRef.current) {
        clearTimeout(chatInactivityTimerRef.current)
      }
      if (chatFadeTimerRef.current) {
        clearTimeout(chatFadeTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return

    return animationScheduler.register(cursor.socketId, group, initialPositionRef.current)
  }, [animationScheduler, cursor.socketId])

  useEffect(() => {
    animationScheduler.setTarget(cursor.socketId, { x: cursor.x, y: cursor.y })
  }, [animationScheduler, cursor.socketId, cursor.x, cursor.y])

  return (
    <Group ref={groupRef}>
      <Html
        transformFunc={attrs => ({
          ...attrs,
          scaleX: 1,
          scaleY: 1,
        })}
        divProps={{
          style: {
            pointerEvents: 'none',
            userSelect: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: 'max-content',
          },
        }}
      >
        <div className="relative flex flex-col items-start overflow-visible">
          <CursorIcon className={cn('w-6 h-6 drop-shadow-md', getCursorColor(cursor.name))} />

          <div
            className={cn(
              'ml-5 -mt-1 text-white shadow-lg whitespace-nowrap w-max',
              getParticipantColor(cursor.name),
              cursor.chatActive && !isChatFaded ? 'px-3 py-2' : 'px-2 py-1',
            )}
            style={{
              borderRadius: cursor.chatActive && !isChatFaded ? '0 0.75rem 0.75rem 0.75rem' : '0.375rem',
              transition: 'border-radius 0.3s ease-out, padding 0.3s ease-out',
            }}
          >
            <div className="text-xs">{cursor.name}</div>

            {cursor.chatActive && (
              <div
                className="text-sm"
                style={{
                  opacity: isChatFading || isChatFaded ? 0 : 1,
                  transition: isChatFading ? 'opacity 3s ease-out' : 'opacity 0.1s ease-out',
                }}
              >
                {cursor.chatMessage || 'ㅤ'}
              </div>
            )}
          </div>
        </div>
      </Html>
    </Group>
  )
})

AnimatedCursor.displayName = 'AnimatedCursor'
