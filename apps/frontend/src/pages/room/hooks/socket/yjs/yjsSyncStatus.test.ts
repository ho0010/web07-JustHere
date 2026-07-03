import { describe, expect, it } from 'vitest'
import { resolveYjsSyncStatus } from './yjsSyncStatus'

const readyState = {
  persistenceReady: true,
  socketStatus: 'connected' as const,
  syncReady: true,
  pendingUpdateCount: 0,
  hasPersistenceError: false,
}

describe('resolveYjsSyncStatus', () => {
  it('로컬 복원 전에는 Socket 상태보다 restoring을 우선해야 한다', () => {
    expect(resolveYjsSyncStatus({ ...readyState, persistenceReady: false })).toBe('restoring')
  })

  it('연결과 재연결 및 오프라인 상태를 구분해야 한다', () => {
    expect(resolveYjsSyncStatus({ ...readyState, socketStatus: 'connecting' })).toBe('connecting')
    expect(resolveYjsSyncStatus({ ...readyState, socketStatus: 'reconnecting' })).toBe('reconnecting')
    expect(resolveYjsSyncStatus({ ...readyState, socketStatus: 'disconnected' })).toBe('offline')
  })

  it('handshake 또는 durable ack가 남아 있으면 syncing이어야 한다', () => {
    expect(resolveYjsSyncStatus({ ...readyState, syncReady: false })).toBe('syncing')
    expect(resolveYjsSyncStatus({ ...readyState, pendingUpdateCount: 1 })).toBe('syncing')
  })

  it('handshake와 durable ack가 모두 끝나야 saved여야 한다', () => {
    expect(resolveYjsSyncStatus(readyState)).toBe('saved')
  })

  it('로컬 영속화 오류를 다른 상태보다 우선해야 한다', () => {
    expect(resolveYjsSyncStatus({ ...readyState, socketStatus: 'disconnected', hasPersistenceError: true })).toBe('error')
  })
})
