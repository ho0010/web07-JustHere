import type { BoundingBox } from '@/shared/types'

const MIN_CACHE_ITEM_COUNT = 100
const MIN_PIXEL_RATIO = 0.1
const MAX_PIXEL_RATIO = 1
const MAX_CACHE_DIMENSION_PX = 4096
const MAX_CACHE_AREA_PX = 10_000_000
const HIT_CANVAS_PIXEL_RATIO = 0.01

export interface PanBitmapCacheConfig extends BoundingBox {
  pixelRatio: number
  hitCanvasPixelRatio: number
  imageSmoothingEnabled: boolean
}

export const getPanBitmapCacheConfig = (
  bounds: BoundingBox,
  stageScale: number,
  devicePixelRatio: number,
  itemCount: number,
): PanBitmapCacheConfig | null => {
  if (itemCount < MIN_CACHE_ITEM_COUNT || bounds.width <= 0 || bounds.height <= 0) return null
  if (![bounds.x, bounds.y, bounds.width, bounds.height, stageScale, devicePixelRatio].every(Number.isFinite)) return null

  const pixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, stageScale * devicePixelRatio))
  const physicalWidth = Math.ceil(bounds.width * pixelRatio)
  const physicalHeight = Math.ceil(bounds.height * pixelRatio)

  if (physicalWidth > MAX_CACHE_DIMENSION_PX || physicalHeight > MAX_CACHE_DIMENSION_PX || physicalWidth * physicalHeight > MAX_CACHE_AREA_PX) {
    return null
  }

  return {
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.ceil(bounds.width),
    height: Math.ceil(bounds.height),
    pixelRatio,
    hitCanvasPixelRatio: HIT_CANVAS_PIXEL_RATIO,
    imageSmoothingEnabled: true,
  }
}
