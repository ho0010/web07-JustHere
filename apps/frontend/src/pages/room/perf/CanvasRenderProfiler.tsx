import { Profiler, useCallback, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { isCanvasPerformanceEnabled, recordCanvasPerformanceDuration } from './canvasPerformance'

interface CanvasRenderProfilerProps {
  children: ReactNode
}

export const CanvasRenderProfiler = ({ children }: CanvasRenderProfilerProps) => {
  const handleRender = useCallback<ProfilerOnRenderCallback>((_id, _phase, actualDuration) => {
    recordCanvasPerformanceDuration('reactRender', actualDuration)
  }, [])

  if (!isCanvasPerformanceEnabled) return children
  return (
    <Profiler id="whiteboard-canvas" onRender={handleRender}>
      {children}
    </Profiler>
  )
}
