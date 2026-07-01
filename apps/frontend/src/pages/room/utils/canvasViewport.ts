import type { BoundingBox } from '@/shared/types'

export interface CanvasStageTransform {
  x: number
  y: number
  scale: number
  width: number
  height: number
}

const normalizeScale = (scale: number) => (Number.isFinite(scale) && scale > 0 ? scale : 1)

export const getCanvasViewportBounds = (transform: CanvasStageTransform, overscanPx = 0): BoundingBox => {
  const scale = normalizeScale(transform.scale)
  const overscan = Math.max(0, overscanPx) / scale

  return {
    x: -transform.x / scale - overscan,
    y: -transform.y / scale - overscan,
    width: Math.max(0, transform.width) / scale + overscan * 2,
    height: Math.max(0, transform.height) / scale + overscan * 2,
  }
}

export const expandBoundingBox = (box: BoundingBox, padding: number): BoundingBox => {
  const normalizedPadding = Math.max(0, padding)
  return {
    x: box.x - normalizedPadding,
    y: box.y - normalizedPadding,
    width: box.width + normalizedPadding * 2,
    height: box.height + normalizedPadding * 2,
  }
}

export const isBoundingBoxIntersecting = (first: BoundingBox, second: BoundingBox) => {
  const firstRight = first.x + first.width
  const firstBottom = first.y + first.height
  const secondRight = second.x + second.width
  const secondBottom = second.y + second.height

  return first.x <= secondRight && firstRight >= second.x && first.y <= secondBottom && firstBottom >= second.y
}

export const containsBoundingBox = (container: BoundingBox, target: BoundingBox) =>
  target.x >= container.x &&
  target.y >= container.y &&
  target.x + target.width <= container.x + container.width &&
  target.y + target.height <= container.y + container.height

export const collectIntersectingItemKeys = (
  itemKeys: Iterable<string>,
  boundsByKey: ReadonlyMap<string, BoundingBox>,
  viewport: BoundingBox,
  alwaysInclude: ReadonlySet<string> = new Set(),
) => {
  const result = new Set<string>()

  for (const key of itemKeys) {
    const bounds = boundsByKey.get(key)
    if (alwaysInclude.has(key) || (bounds && isBoundingBoxIntersecting(viewport, bounds))) {
      result.add(key)
    }
  }

  return result
}
