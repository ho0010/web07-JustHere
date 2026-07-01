export const isCanvasPerformanceEnabled = import.meta.env.VITE_ENABLE_CANVAS_PERF === 'true'

export type CanvasDurationMetric =
  | 'yjsInitialApply'
  | 'yjsUpdateApply'
  | 'projectPostits'
  | 'projectPlaceCards'
  | 'projectLines'
  | 'projectTextBoxes'
  | 'projectZIndex'
  | 'reactRender'
  | 'panBitmapCacheCreate'
  | 'mainLayerDraw'
  | 'mainLayerHitDraw'
  | 'cursorLayerDraw'

export interface CanvasItemCounts {
  postits: number
  placeCards: number
  lines: number
  linePoints: number
  textBoxes: number
  cursors: number
  visibleItems?: number
  renderCandidateItems?: number
  renderedItems?: number
}

interface DurationSummary {
  count: number
  totalMs: number
  averageMs: number
  p95Ms: number
  maxMs: number
}

export interface CanvasPerformanceSnapshot {
  capturedAt: string
  windowMs: number
  itemCounts: CanvasItemCounts
  frames: {
    fps: number
    p95Ms: number
    maxMs: number
    slowFrameThresholdMs: number
    slowFrameRatio: number
  }
  longTasks: {
    count: number
    totalMs: number
    maxMs: number
  }
  inboundYjs: {
    updates: number
    binaryBytes: number
  }
  cursorPipeline: {
    awarenessReceived: number
    storeCommits: number
  }
  projectionPipeline: {
    fullCollectionScans: number
    incrementalPatches: number
    projectedItems: number
  }
  panPipeline: {
    stageDragMoves: number
    bitmapCacheCreates: number
    bitmapCacheSkips: number
    bitmapCacheActive: boolean
  }
  durations: Partial<Record<CanvasDurationMetric, DurationSummary>>
}

interface WindowState {
  startedAt: number
  durations: Map<CanvasDurationMetric, number[]>
  frameDurations: number[]
  longTaskDurations: number[]
  inboundUpdates: number
  inboundBytes: number
  awarenessReceived: number
  cursorStoreCommits: number
  projectionFullCollectionScans: number
  projectionIncrementalPatches: number
  projectedItems: number
  stageDragMoves: number
  bitmapCacheCreates: number
  bitmapCacheSkips: number
}

const HISTORY_LIMIT = 300
const SLOW_FRAME_THRESHOLD_MS = 20

const createWindowState = (): WindowState => ({
  startedAt: performance.now(),
  durations: new Map(),
  frameDurations: [],
  longTaskDurations: [],
  inboundUpdates: 0,
  inboundBytes: 0,
  awarenessReceived: 0,
  cursorStoreCommits: 0,
  projectionFullCollectionScans: 0,
  projectionIncrementalPatches: 0,
  projectedItems: 0,
  stageDragMoves: 0,
  bitmapCacheCreates: 0,
  bitmapCacheSkips: 0,
})

let currentWindow = createWindowState()
let history: CanvasPerformanceSnapshot[] = []
let panBitmapCacheActive = false

const round = (value: number) => Number(value.toFixed(2))

const percentile = (values: number[], ratio: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

const summarizeDurations = (values: number[]): DurationSummary => {
  const totalMs = values.reduce((total, value) => total + value, 0)
  return {
    count: values.length,
    totalMs: round(totalMs),
    averageMs: round(totalMs / values.length),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values)),
  }
}

export const measureCanvasPerformance = <T>(metric: CanvasDurationMetric, callback: () => T): T => {
  if (!isCanvasPerformanceEnabled) return callback()
  const startedAt = performance.now()
  try {
    return callback()
  } finally {
    recordCanvasPerformanceDuration(metric, performance.now() - startedAt)
  }
}

export const recordCanvasPerformanceDuration = (metric: CanvasDurationMetric, durationMs: number) => {
  if (!isCanvasPerformanceEnabled || !Number.isFinite(durationMs)) return
  const values = currentWindow.durations.get(metric) ?? []
  values.push(durationMs)
  currentWindow.durations.set(metric, values)
}

export const recordCanvasPerformanceFrame = (durationMs: number) => {
  if (!isCanvasPerformanceEnabled || !Number.isFinite(durationMs) || durationMs <= 0) return
  currentWindow.frameDurations.push(durationMs)
}

export const recordCanvasPerformanceLongTask = (durationMs: number) => {
  if (!isCanvasPerformanceEnabled || !Number.isFinite(durationMs) || durationMs <= 0) return
  currentWindow.longTaskDurations.push(durationMs)
}

export const recordCanvasPerformanceInboundUpdate = (binaryBytes: number) => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.inboundUpdates += 1
  currentWindow.inboundBytes += binaryBytes
}

export const recordCanvasPerformanceAwarenessReceived = () => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.awarenessReceived += 1
}

export const recordCanvasPerformanceCursorStoreCommit = () => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.cursorStoreCommits += 1
}

export const recordCanvasPerformanceProjection = (mode: 'full' | 'incremental', itemCount: number) => {
  if (!isCanvasPerformanceEnabled) return
  if (mode === 'full') {
    currentWindow.projectionFullCollectionScans += 1
  } else {
    currentWindow.projectionIncrementalPatches += 1
  }
  currentWindow.projectedItems += Math.max(0, itemCount)
}

export const recordCanvasPerformanceStagePanMove = () => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.stageDragMoves += 1
}

export const recordCanvasPerformancePanBitmapCacheCreate = (durationMs: number) => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.bitmapCacheCreates += 1
  recordCanvasPerformanceDuration('panBitmapCacheCreate', durationMs)
}

export const recordCanvasPerformancePanBitmapCacheSkip = () => {
  if (!isCanvasPerformanceEnabled) return
  currentWindow.bitmapCacheSkips += 1
}

export const setCanvasPerformancePanBitmapCacheActive = (active: boolean) => {
  if (!isCanvasPerformanceEnabled) return
  panBitmapCacheActive = active
}

export const takeCanvasPerformanceSnapshot = (itemCounts: CanvasItemCounts): CanvasPerformanceSnapshot => {
  const capturedAt = new Date().toISOString()
  const now = performance.now()
  const windowState = currentWindow
  currentWindow = createWindowState()

  const frameTotalMs = windowState.frameDurations.reduce((total, duration) => total + duration, 0)
  const longTaskTotalMs = windowState.longTaskDurations.reduce((total, duration) => total + duration, 0)
  const durations = Object.fromEntries(
    Array.from(windowState.durations.entries()).map(([metric, values]) => [metric, summarizeDurations(values)]),
  ) as Partial<Record<CanvasDurationMetric, DurationSummary>>

  const snapshot: CanvasPerformanceSnapshot = {
    capturedAt,
    windowMs: round(now - windowState.startedAt),
    itemCounts,
    frames: {
      fps: frameTotalMs > 0 ? round((windowState.frameDurations.length * 1000) / frameTotalMs) : 0,
      p95Ms: round(percentile(windowState.frameDurations, 0.95)),
      maxMs: windowState.frameDurations.length > 0 ? round(Math.max(...windowState.frameDurations)) : 0,
      slowFrameThresholdMs: SLOW_FRAME_THRESHOLD_MS,
      slowFrameRatio:
        windowState.frameDurations.length > 0
          ? round(windowState.frameDurations.filter(duration => duration > SLOW_FRAME_THRESHOLD_MS).length / windowState.frameDurations.length)
          : 0,
    },
    longTasks: {
      count: windowState.longTaskDurations.length,
      totalMs: round(longTaskTotalMs),
      maxMs: windowState.longTaskDurations.length > 0 ? round(Math.max(...windowState.longTaskDurations)) : 0,
    },
    inboundYjs: {
      updates: windowState.inboundUpdates,
      binaryBytes: windowState.inboundBytes,
    },
    cursorPipeline: {
      awarenessReceived: windowState.awarenessReceived,
      storeCommits: windowState.cursorStoreCommits,
    },
    projectionPipeline: {
      fullCollectionScans: windowState.projectionFullCollectionScans,
      incrementalPatches: windowState.projectionIncrementalPatches,
      projectedItems: windowState.projectedItems,
    },
    panPipeline: {
      stageDragMoves: windowState.stageDragMoves,
      bitmapCacheCreates: windowState.bitmapCacheCreates,
      bitmapCacheSkips: windowState.bitmapCacheSkips,
      bitmapCacheActive: panBitmapCacheActive,
    },
    durations,
  }

  history = [...history.slice(-(HISTORY_LIMIT - 1)), snapshot]
  return snapshot
}

export const resetCanvasPerformance = () => {
  currentWindow = createWindowState()
  history = []
}

export const exportCanvasPerformanceReport = () => ({
  schemaVersion: 6,
  exportedAt: new Date().toISOString(),
  page: window.location.href,
  userAgent: navigator.userAgent,
  devicePixelRatio: window.devicePixelRatio,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  samples: history,
})
