import { useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import type { BoundingBox } from '@/shared/types'
import { containsBoundingBox, expandBoundingBox, getCanvasViewportBounds } from '@/pages/room/utils'

interface CanvasTransform {
  x: number
  y: number
  scale: number
}

interface CanvasViewportState {
  viewportBounds: BoundingBox
  renderBounds: BoundingBox
}

interface UseCanvasViewportProps {
  stageRef: React.RefObject<Konva.Stage | null>
  initialTransform?: CanvasTransform
}

const VIEWPORT_OVERSCAN_PX = 300
const VIEWPORT_REFRESH_MARGIN_PX = 100
const SCALE_REFRESH_RATIO = 0.1

const getInitialViewportState = (initialTransform?: CanvasTransform): CanvasViewportState => {
  const transform = initialTransform ?? { x: 0, y: 0, scale: 1 }
  const stageTransform = {
    ...transform,
    width: window.innerWidth,
    height: window.innerHeight,
  }

  return {
    viewportBounds: getCanvasViewportBounds(stageTransform),
    renderBounds: getCanvasViewportBounds(stageTransform, VIEWPORT_OVERSCAN_PX),
  }
}

export const useCanvasViewport = ({ stageRef, initialTransform }: UseCanvasViewportProps) => {
  const [viewportState, setViewportState] = useState<CanvasViewportState>(() => getInitialViewportState(initialTransform))
  const renderBoundsRef = useRef(viewportState.renderBounds)
  const lastScaleRef = useRef(initialTransform?.scale ?? 1)
  const hasSyncedRef = useRef(false)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    let frameId: number | null = null
    const parent = stage.container().parentElement

    const syncViewport = () => {
      frameId = null

      const parentRect = parent?.getBoundingClientRect()
      const width = parentRect?.width && parentRect.width > 0 ? parentRect.width : stage.width()
      const height = parentRect?.height && parentRect.height > 0 ? parentRect.height : stage.height()
      const scale = stage.scaleX() || 1
      const transform = {
        x: stage.x(),
        y: stage.y(),
        scale,
        width,
        height,
      }
      const viewportBounds = getCanvasViewportBounds(transform)
      const refreshMargin = VIEWPORT_REFRESH_MARGIN_PX / scale
      const scaleRatio = scale / (lastScaleRef.current || 1)
      const scaleChanged = scaleRatio > 1 + SCALE_REFRESH_RATIO || scaleRatio < 1 - SCALE_REFRESH_RATIO
      const needsRefresh =
        !hasSyncedRef.current || scaleChanged || !containsBoundingBox(renderBoundsRef.current, expandBoundingBox(viewportBounds, refreshMargin))

      if (!needsRefresh) return

      const renderBounds = getCanvasViewportBounds(transform, VIEWPORT_OVERSCAN_PX)
      hasSyncedRef.current = true
      lastScaleRef.current = scale
      renderBoundsRef.current = renderBounds
      setViewportState({ viewportBounds, renderBounds })
    }

    const scheduleSync = () => {
      if (frameId !== null) return
      frameId = requestAnimationFrame(syncViewport)
    }

    stage.on('xChange.viewportCulling yChange.viewportCulling scaleXChange.viewportCulling scaleYChange.viewportCulling', scheduleSync)
    window.addEventListener('resize', scheduleSync)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && parent) {
      resizeObserver = new ResizeObserver(scheduleSync)
      resizeObserver.observe(parent)
    }
    scheduleSync()

    return () => {
      stage.off('xChange.viewportCulling yChange.viewportCulling scaleXChange.viewportCulling scaleYChange.viewportCulling', scheduleSync)
      window.removeEventListener('resize', scheduleSync)
      resizeObserver?.disconnect()
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [stageRef])

  return viewportState
}
