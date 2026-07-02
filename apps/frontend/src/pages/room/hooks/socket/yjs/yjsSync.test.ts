import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createMissingYjsUpdate } from './yjsSync'

describe('createMissingYjsUpdate', () => {
  it('상대 문서에 없는 로컬 변경만 update로 생성해야 한다', () => {
    const remoteDoc = new Y.Doc()
    const localDoc = new Y.Doc()
    remoteDoc.getMap('fixture').set('shared', true)
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc))
    localDoc.getMap('fixture').set('local-only', true)

    const update = createMissingYjsUpdate(localDoc, Y.encodeStateVector(remoteDoc))
    expect(update).not.toBeNull()

    Y.applyUpdate(remoteDoc, update!)
    expect(remoteDoc.getMap('fixture').toJSON()).toEqual({ shared: true, 'local-only': true })

    localDoc.destroy()
    remoteDoc.destroy()
  })

  it('두 문서가 이미 같으면 빈 update를 반환하지 않아야 한다', () => {
    const remoteDoc = new Y.Doc()
    const localDoc = new Y.Doc()
    remoteDoc.getMap('fixture').set('shared', true)
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc))

    expect(createMissingYjsUpdate(localDoc, Y.encodeStateVector(remoteDoc))).toBeNull()

    localDoc.destroy()
    remoteDoc.destroy()
  })

  it('새 struct가 없는 삭제 변경도 누락하지 않아야 한다', () => {
    const remoteDoc = new Y.Doc()
    const localDoc = new Y.Doc()
    remoteDoc.getArray('fixture').push(['keep', 'delete'])
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc))
    localDoc.getArray('fixture').delete(1, 1)

    const update = createMissingYjsUpdate(localDoc, Y.encodeStateVector(remoteDoc))
    expect(update).not.toBeNull()

    Y.applyUpdate(remoteDoc, update!)
    expect(remoteDoc.getArray('fixture').toArray()).toEqual(['keep'])

    localDoc.destroy()
    remoteDoc.destroy()
  })
})
