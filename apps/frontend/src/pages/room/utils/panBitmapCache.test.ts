import { describe, expect, it } from 'vitest'
import { getPanBitmapCacheConfig } from './panBitmapCache'

describe('panBitmapCache', () => {
  it('현재 화면 배율과 device pixel ratio를 반영해 cache 해상도를 정한다', () => {
    expect(getPanBitmapCacheConfig({ x: -10.5, y: 20.2, width: 6000, height: 3000 }, 0.2, 2, 593)).toEqual({
      x: -11,
      y: 20,
      width: 6000,
      height: 3000,
      pixelRatio: 0.4,
      hitCanvasPixelRatio: 0.01,
      imageSmoothingEnabled: true,
    })
  })

  it('객체 수가 적으면 cache 생성 비용을 사용하지 않는다', () => {
    expect(getPanBitmapCacheConfig({ x: 0, y: 0, width: 1000, height: 1000 }, 0.2, 2, 50)).toBeNull()
  })

  it('물리 cache 크기가 안전 한도를 넘으면 적용하지 않는다', () => {
    expect(getPanBitmapCacheConfig({ x: 0, y: 0, width: 20000, height: 10000 }, 0.5, 2, 593)).toBeNull()
  })
})
