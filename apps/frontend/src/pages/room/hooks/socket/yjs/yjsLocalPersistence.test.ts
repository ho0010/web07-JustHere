import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createYjsLocalDatabaseName, YjsLocalPersistence } from './yjsLocalPersistence'
import { createMissingYjsUpdate } from './yjsSync'

describe('YjsLocalPersistence', () => {
  it('브라우저 세션이 바뀌어도 Y.Doc과 durable outbox를 복원해야 한다', async () => {
    const databaseName = createYjsLocalDatabaseName('room-1', `canvas-${crypto.randomUUID()}`)
    const firstDoc = new Y.Doc()
    const firstPersistence = new YjsLocalPersistence(databaseName, firstDoc)
    await firstPersistence.whenSynced

    firstDoc.getMap('fixture').set('offline-edit', true)
    const pendingPayload = {
      canvasId: 'canvas-1',
      updateId: '00000000-0000-4000-8000-000000000001',
      update: [1, 2, 3],
    }
    await firstPersistence.saveOutbox([pendingPayload])
    await firstPersistence.destroy()
    firstDoc.destroy()

    const restoredDoc = new Y.Doc()
    const restoredPersistence = new YjsLocalPersistence(databaseName, restoredDoc)
    await restoredPersistence.whenSynced

    expect(restoredDoc.getMap('fixture').get('offline-edit')).toBe(true)
    await expect(restoredPersistence.loadOutbox()).resolves.toEqual([pendingPayload])

    await restoredPersistence.clearData()
    restoredDoc.destroy()
  })

  it('복원한 오프라인 변경을 서버 state vector 기준 diff로 만들어 수렴해야 한다', async () => {
    const databaseName = createYjsLocalDatabaseName('room-1', `canvas-${crypto.randomUUID()}`)
    const serverDoc = new Y.Doc()
    const offlineDoc = new Y.Doc()
    const firstPersistence = new YjsLocalPersistence(databaseName, offlineDoc)
    await firstPersistence.whenSynced

    serverDoc.getMap('fixture').set('shared', true)
    Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(serverDoc))
    offlineDoc.getMap('fixture').set('offline-only', true)
    await firstPersistence.saveOutbox([])
    await firstPersistence.destroy()
    offlineDoc.destroy()

    const restoredDoc = new Y.Doc()
    const restoredPersistence = new YjsLocalPersistence(databaseName, restoredDoc)
    await restoredPersistence.whenSynced

    const missingUpdate = createMissingYjsUpdate(restoredDoc, Y.encodeStateVector(serverDoc))
    expect(missingUpdate).not.toBeNull()
    Y.applyUpdate(serverDoc, missingUpdate!)
    expect(serverDoc.getMap('fixture').toJSON()).toEqual({ shared: true, 'offline-only': true })

    await restoredPersistence.clearData()
    restoredDoc.destroy()
    serverDoc.destroy()
  })

  it('room과 canvas 조합으로 서로 다른 IndexedDB 이름을 생성해야 한다', () => {
    expect(createYjsLocalDatabaseName('room-1', 'canvas-1')).toBe('justhere:yjs:v1:room-1:canvas-1')
    expect(createYjsLocalDatabaseName('room-1', 'canvas-2')).not.toBe(createYjsLocalDatabaseName('room-1', 'canvas-1'))
  })
})
