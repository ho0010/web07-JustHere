import { memo, useEffect, useMemo, useRef } from 'react'
import { Layer } from 'react-konva'
import type Konva from 'konva'
import { useCursorPresenceStore } from '@/pages/room/stores'
import { isCanvasPerformanceEnabled, recordCanvasPerformanceDuration } from '@/pages/room/perf'
import { AnimatedCursor } from './animated-cursor'
import { CursorAnimationScheduler } from './cursorAnimationScheduler'

export const CursorLayer = memo(() => {
  const layerRef = useRef<Konva.Layer>(null)
  const drawStartedAtRef = useRef(0)
  const cursors = useCursorPresenceStore(state => state.cursors)
  const animationScheduler = useMemo(() => new CursorAnimationScheduler(), [])

  useEffect(() => {
    return () => {
      animationScheduler.clear()
    }
  }, [animationScheduler])

  useEffect(() => {
    if (!isCanvasPerformanceEnabled) return
    const layer = layerRef.current
    if (!layer) return

    const handleBeforeDraw = () => {
      drawStartedAtRef.current = performance.now()
    }
    const handleDraw = () => {
      if (drawStartedAtRef.current === 0) return
      recordCanvasPerformanceDuration('cursorLayerDraw', performance.now() - drawStartedAtRef.current)
      drawStartedAtRef.current = 0
    }

    layer.on('beforeDraw.canvasPerformance', handleBeforeDraw)
    layer.on('draw.canvasPerformance', handleDraw)
    return () => {
      layer.off('beforeDraw.canvasPerformance', handleBeforeDraw)
      layer.off('draw.canvasPerformance', handleDraw)
    }
  }, [])

  return (
    <Layer ref={layerRef}>
      {Array.from(cursors.values()).map(cursor => (
        <AnimatedCursor key={cursor.socketId} cursor={cursor} animationScheduler={animationScheduler} />
      ))}
    </Layer>
  )
})

CursorLayer.displayName = 'CursorLayer'
