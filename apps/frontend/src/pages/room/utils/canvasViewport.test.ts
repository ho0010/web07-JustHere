import { describe, expect, it } from 'vitest'
import {
  collectIntersectingItemKeys,
  containsBoundingBox,
  expandBoundingBox,
  getCanvasViewportBounds,
  isBoundingBoxIntersecting,
} from './canvasViewport'

describe('canvasViewport', () => {
  it('Stage 위치와 scale을 Canvas 좌표계 viewport로 변환한다', () => {
    expect(getCanvasViewportBounds({ x: -200, y: -100, scale: 2, width: 1000, height: 600 })).toEqual({
      x: 100,
      y: 50,
      width: 500,
      height: 300,
    })
  })

  it('overscan을 화면 px 기준으로 Canvas 좌표계에 반영한다', () => {
    expect(getCanvasViewportBounds({ x: -200, y: -100, scale: 2, width: 1000, height: 600 }, 200)).toEqual({
      x: 0,
      y: -50,
      width: 700,
      height: 500,
    })
  })

  it('viewport 경계에 일부만 걸친 객체도 교차한다고 판단한다', () => {
    const viewport = { x: 100, y: 100, width: 500, height: 300 }

    expect(isBoundingBoxIntersecting(viewport, { x: 590, y: 390, width: 50, height: 50 })).toBe(true)
    expect(isBoundingBoxIntersecting(viewport, { x: 601, y: 401, width: 50, height: 50 })).toBe(false)
  })

  it('확장 영역 내부에 viewport와 refresh margin이 포함되는지 확인한다', () => {
    const renderBounds = { x: 0, y: 0, width: 1000, height: 800 }
    const viewport = { x: 200, y: 200, width: 500, height: 300 }

    expect(containsBoundingBox(renderBounds, expandBoundingBox(viewport, 100))).toBe(true)
    expect(containsBoundingBox(renderBounds, expandBoundingBox(viewport, 250))).toBe(false)
  })

  it('viewport와 교차하거나 반드시 유지해야 하는 객체 key만 수집한다', () => {
    const bounds = new Map([
      ['inside', { x: 100, y: 100, width: 50, height: 50 }],
      ['outside', { x: 1000, y: 1000, width: 50, height: 50 }],
      ['selected', { x: 1200, y: 1200, width: 50, height: 50 }],
    ])

    expect(
      collectIntersectingItemKeys(['inside', 'outside', 'selected'], bounds, { x: 0, y: 0, width: 500, height: 500 }, new Set(['selected'])),
    ).toEqual(new Set(['inside', 'selected']))
  })
})
