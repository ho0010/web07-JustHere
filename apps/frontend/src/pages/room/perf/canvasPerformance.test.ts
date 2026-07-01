import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('canvasPerformance', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_ENABLE_CANVAS_PERF', 'true')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('커서 파이프라인과 slow frame을 1초 표본으로 집계한다', async () => {
    const performance = await import('./canvasPerformance')

    performance.recordCanvasPerformanceFrame(16.7)
    performance.recordCanvasPerformanceFrame(21)
    performance.recordCanvasPerformanceFrame(40)
    performance.recordCanvasPerformanceAwarenessReceived()
    performance.recordCanvasPerformanceAwarenessReceived()
    performance.recordCanvasPerformanceCursorStoreCommit()
    performance.recordCanvasPerformanceStagePanMove()
    performance.recordCanvasPerformanceStagePanMove()
    performance.recordCanvasPerformanceDuration('cursorLayerDraw', 4)
    performance.recordCanvasPerformanceDuration('cursorLayerDraw', 8)

    const snapshot = performance.takeCanvasPerformanceSnapshot({
      postits: 0,
      placeCards: 0,
      lines: 0,
      linePoints: 0,
      textBoxes: 0,
      cursors: 2,
    })

    expect(snapshot.frames.slowFrameThresholdMs).toBe(20)
    expect(snapshot.frames.slowFrameRatio).toBe(0.67)
    expect(snapshot.cursorPipeline).toEqual({ awarenessReceived: 2, storeCommits: 1 })
    expect(snapshot.panPipeline).toEqual({ stageDragMoves: 2 })
    expect(snapshot.durations.cursorLayerDraw).toMatchObject({ count: 2, averageMs: 6, p95Ms: 8 })
  })
})
