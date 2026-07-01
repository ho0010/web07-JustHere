interface Point {
  x: number
  y: number
}

interface CursorPositionNode {
  position: (point: Point) => unknown
}

interface CursorAnimationEntry {
  node: CursorPositionNode
  current: Point
  target: Point
}

const BASE_FRAME_MS = 1000 / 60
const DEFAULT_MAX_FPS = 30
const FRAME_INTERVAL_TOLERANCE_MS = 1
const LERP_FACTOR = 0.2
const MAX_ELAPSED_MS = 100
const SNAP_DISTANCE_SQUARED = 0.5 ** 2

export class CursorAnimationScheduler {
  private readonly entries = new Map<string, CursorAnimationEntry>()
  private readonly activeCursorIds = new Set<string>()
  private readonly frameIntervalMs: number
  private frameId: number | null = null
  private lastRenderedAt: number | null = null

  constructor(maxFps = DEFAULT_MAX_FPS) {
    this.frameIntervalMs = 1000 / maxFps
  }

  register(cursorId: string, node: CursorPositionNode, initialPosition: Point) {
    const position = { ...initialPosition }
    node.position(position)
    this.entries.set(cursorId, {
      node,
      current: position,
      target: position,
    })

    return () => {
      this.unregister(cursorId)
    }
  }

  setTarget(cursorId: string, target: Point) {
    const entry = this.entries.get(cursorId)
    if (!entry) return

    entry.target = { ...target }
    const dx = target.x - entry.current.x
    const dy = target.y - entry.current.y

    if (dx === 0 && dy === 0 && !this.activeCursorIds.has(cursorId)) return

    this.activeCursorIds.add(cursorId)
    this.requestNextFrame()
  }

  clear() {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId)
    }
    this.frameId = null
    this.lastRenderedAt = null
    this.activeCursorIds.clear()
    this.entries.clear()
  }

  private unregister(cursorId: string) {
    this.entries.delete(cursorId)
    this.activeCursorIds.delete(cursorId)
    this.stopWhenIdle()
  }

  private requestNextFrame() {
    if (this.frameId !== null) return
    this.frameId = requestAnimationFrame(this.handleFrame)
  }

  private readonly handleFrame = (timestamp: number) => {
    this.frameId = null

    if (this.activeCursorIds.size === 0) {
      this.lastRenderedAt = null
      return
    }

    if (this.lastRenderedAt !== null && timestamp - this.lastRenderedAt < this.frameIntervalMs - FRAME_INTERVAL_TOLERANCE_MS) {
      this.requestNextFrame()
      return
    }

    const elapsedMs = this.lastRenderedAt === null ? BASE_FRAME_MS : Math.min(timestamp - this.lastRenderedAt, MAX_ELAPSED_MS)
    const lerpFactor = 1 - Math.pow(1 - LERP_FACTOR, elapsedMs / BASE_FRAME_MS)
    this.lastRenderedAt = timestamp

    for (const cursorId of this.activeCursorIds) {
      const entry = this.entries.get(cursorId)
      if (!entry) {
        this.activeCursorIds.delete(cursorId)
        continue
      }

      const dx = entry.target.x - entry.current.x
      const dy = entry.target.y - entry.current.y
      const distanceSquared = dx * dx + dy * dy

      if (distanceSquared < SNAP_DISTANCE_SQUARED) {
        entry.current = { ...entry.target }
        entry.node.position(entry.current)
        this.activeCursorIds.delete(cursorId)
        continue
      }

      entry.current = {
        x: entry.current.x + dx * lerpFactor,
        y: entry.current.y + dy * lerpFactor,
      }
      entry.node.position(entry.current)
    }

    if (this.activeCursorIds.size > 0) {
      this.requestNextFrame()
    } else {
      this.lastRenderedAt = null
    }
  }

  private stopWhenIdle() {
    if (this.activeCursorIds.size > 0) return

    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId)
      this.frameId = null
    }
    this.lastRenderedAt = null
  }
}
