import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCursorPresenceStore } from '@/pages/room/stores'
import {
  exportCanvasPerformanceReport,
  isCanvasPerformanceEnabled,
  recordCanvasPerformanceFrame,
  recordCanvasPerformanceLongTask,
  resetCanvasPerformance,
  takeCanvasPerformanceSnapshot,
  type CanvasItemCounts,
  type CanvasPerformanceSnapshot,
} from './canvasPerformance'

interface CanvasPerformanceOverlayProps {
  itemCounts: Omit<CanvasItemCounts, 'cursors'>
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const downloadReport = () => {
  const report = exportCanvasPerformanceReport()
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `canvas-performance-${new Date().toISOString().replaceAll(':', '-')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export const CanvasPerformanceOverlay = ({ itemCounts }: CanvasPerformanceOverlayProps) => {
  const cursorCount = useCursorPresenceStore(state => state.cursors.size)
  const countsRef = useRef<CanvasItemCounts>({ ...itemCounts, cursors: cursorCount })
  const [snapshot, setSnapshot] = useState<CanvasPerformanceSnapshot | null>(null)

  useEffect(() => {
    countsRef.current = { ...itemCounts, cursors: cursorCount }
  }, [cursorCount, itemCounts])

  useEffect(() => {
    if (!isCanvasPerformanceEnabled) return
    let frameId = 0
    let previousFrameAt: number | null = null

    const measureFrame = (timestamp: number) => {
      if (previousFrameAt != null && document.visibilityState === 'visible') {
        recordCanvasPerformanceFrame(timestamp - previousFrameAt)
      }
      previousFrameAt = timestamp
      frameId = requestAnimationFrame(measureFrame)
    }
    frameId = requestAnimationFrame(measureFrame)

    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver(entries => {
          entries.getEntries().forEach(entry => recordCanvasPerformanceLongTask(entry.duration))
        })
      : null
    observer?.observe({ entryTypes: ['longtask'] })

    const intervalId = window.setInterval(() => {
      setSnapshot(takeCanvasPerformanceSnapshot(countsRef.current))
    }, 1000)

    return () => {
      cancelAnimationFrame(frameId)
      window.clearInterval(intervalId)
      observer?.disconnect()
    }
  }, [])

  const handleReset = useCallback(() => {
    resetCanvasPerformance()
    setSnapshot(null)
  }, [])

  const objectSummary = useMemo(
    () => `${itemCounts.postits + itemCounts.placeCards + itemCounts.lines + itemCounts.textBoxes}개 / 좌표 ${itemCounts.linePoints}쌍`,
    [itemCounts],
  )
  const visibilitySummary = useMemo(() => {
    if (itemCounts.visibleItems == null || itemCounts.renderCandidateItems == null || itemCounts.renderedItems == null) return null
    return `가시/후보/렌더: ${itemCounts.visibleItems}/${itemCounts.renderCandidateItems}/${itemCounts.renderedItems}`
  }, [itemCounts.renderCandidateItems, itemCounts.renderedItems, itemCounts.visibleItems])

  if (!isCanvasPerformanceEnabled) return null

  const reactRenderP95 = snapshot?.durations.reactRender?.p95Ms

  return (
    <aside className="absolute right-3 top-3 z-50 w-80 rounded-lg bg-slate-950/90 p-3 font-mono text-[11px] leading-5 text-slate-100 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <strong className="text-xs text-emerald-300">Canvas Perf</strong>
        <div className="flex gap-2">
          <button type="button" className="text-slate-300 hover:text-white" onClick={handleReset}>
            초기화
          </button>
          <button type="button" className="text-slate-300 hover:text-white" onClick={downloadReport}>
            JSON
          </button>
        </div>
      </div>
      <div>객체: {objectSummary}</div>
      {visibilitySummary && <div>{visibilitySummary}</div>}
      <div>가상/실제 커서: {cursorCount}</div>
      {snapshot ? (
        <>
          <div>
            FPS: {snapshot.frames.fps} · frame p95: {snapshot.frames.p95Ms} ms
          </div>
          <div>
            {snapshot.frames.slowFrameThresholdMs}ms 초과: {(snapshot.frames.slowFrameRatio * 100).toFixed(1)}% · long task:{' '}
            {snapshot.longTasks.count}
          </div>
          <div>
            Yjs 수신: {snapshot.inboundYjs.updates}/s · {formatBytes(snapshot.inboundYjs.binaryBytes)}/s
          </div>
          <div>
            Cursor: awareness {snapshot.cursorPipeline.awarenessReceived}/s · store {snapshot.cursorPipeline.storeCommits}/s
          </div>
          <div>Pan: stage move {snapshot.panPipeline.stageDragMoves}/s</div>
          <div>
            Pan cache: {snapshot.panPipeline.bitmapCacheActive ? 'on' : 'off'} · create {snapshot.durations.panBitmapCacheCreate?.p95Ms ?? 0} ms
          </div>
          <div>Yjs apply p95: {snapshot.durations.yjsUpdateApply?.p95Ms ?? 0} ms</div>
          <div>
            상태 투영 p95:{' '}
            {Math.max(
              snapshot.durations.projectPostits?.p95Ms ?? 0,
              snapshot.durations.projectPlaceCards?.p95Ms ?? 0,
              snapshot.durations.projectLines?.p95Ms ?? 0,
              snapshot.durations.projectTextBoxes?.p95Ms ?? 0,
              snapshot.durations.projectZIndex?.p95Ms ?? 0,
            )}{' '}
            ms
          </div>
          <div>React render p95: {reactRenderP95 == null ? 'N/A' : `${reactRenderP95} ms`}</div>
          <div>
            Konva draw p95: scene {snapshot.durations.mainLayerDraw?.p95Ms ?? 0} ms · hit {snapshot.durations.mainLayerHitDraw?.p95Ms ?? 0} ms
          </div>
          <div>Cursor draw p95: {snapshot.durations.cursorLayerDraw?.p95Ms ?? 0} ms</div>
        </>
      ) : (
        <div className="text-slate-400">첫 1초 표본을 수집하는 중...</div>
      )}
    </aside>
  )
}
