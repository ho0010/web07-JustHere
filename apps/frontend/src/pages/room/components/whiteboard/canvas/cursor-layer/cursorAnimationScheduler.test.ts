import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorAnimationScheduler } from './cursorAnimationScheduler'

const frameCallbacks = new Map<number, FrameRequestCallback>()
let frameId = 0

const runNextFrame = (timestamp: number) => {
  const next = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined
  if (!next) throw new Error('예약된 animation frame이 없습니다.')
  const [id, callback] = next
  frameCallbacks.delete(id)
  callback(timestamp)
}

describe('CursorAnimationScheduler', () => {
  beforeEach(() => {
    frameCallbacks.clear()
    frameId = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameId += 1
        frameCallbacks.set(frameId, callback)
        return frameId
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frameCallbacks.delete(id)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('여러 커서를 하나의 animation frame에서 함께 갱신한다', () => {
    const scheduler = new CursorAnimationScheduler()
    const nodes = Array.from({ length: 30 }, () => ({ position: vi.fn() }))

    nodes.forEach((node, index) => {
      scheduler.register(`cursor-${index}`, node, { x: 0, y: 0 })
      scheduler.setTarget(`cursor-${index}`, { x: 100, y: 100 })
    })

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    runNextFrame(0)

    nodes.forEach(node => {
      const lastPosition = node.position.mock.lastCall?.[0]
      expect(lastPosition?.x).toBeCloseTo(20)
      expect(lastPosition?.y).toBeCloseTo(20)
    })
  })

  it('커서 위치 렌더링을 최대 30FPS로 제한한다', () => {
    const scheduler = new CursorAnimationScheduler(30)
    const node = { position: vi.fn() }
    scheduler.register('cursor', node, { x: 0, y: 0 })
    scheduler.setTarget('cursor', { x: 100, y: 0 })

    runNextFrame(0)
    expect(node.position).toHaveBeenCalledTimes(2)

    runNextFrame(16)
    expect(node.position).toHaveBeenCalledTimes(2)

    runNextFrame(33)
    expect(node.position).toHaveBeenCalledTimes(3)
  })

  it('목표에 도달하면 frame 예약을 중단하고 clear 시 pending frame을 취소한다', () => {
    const scheduler = new CursorAnimationScheduler()
    const node = { position: vi.fn() }
    scheduler.register('cursor', node, { x: 0, y: 0 })
    scheduler.setTarget('cursor', { x: 0.1, y: 0.1 })

    runNextFrame(0)
    expect(frameCallbacks.size).toBe(0)

    scheduler.setTarget('cursor', { x: 100, y: 100 })
    expect(frameCallbacks.size).toBe(1)

    scheduler.clear()
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(frameCallbacks.size).toBe(0)
  })
})
