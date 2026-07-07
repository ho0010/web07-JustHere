import { Test, TestingModule } from '@nestjs/testing'
import { CanvasRepository } from './canvas.repository'
import { PrismaService } from '@/lib/prisma/prisma.service'
import { Prisma } from '@prisma/client'
import * as Y from 'yjs'

describe('CanvasRepository', () => {
  let repository: CanvasRepository

  // Manual Mock 객체 정의
  let mockPrisma: {
    categoryUpdateLog: {
      findMany: jest.Mock
      create: jest.Mock
      deleteMany: jest.Mock
    }
    categoryUpdateReceipt: {
      findMany: jest.Mock
      createMany: jest.Mock
    }
    categorySnapshot: {
      findUnique: jest.Mock
      upsert: jest.Mock
    }
    $queryRaw: jest.Mock
    $transaction: jest.Mock
  }

  beforeEach(async () => {
    // Mock 구현
    mockPrisma = {
      categoryUpdateLog: {
        findMany: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      categoryUpdateReceipt: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      categorySnapshot: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    }
    mockPrisma.$transaction.mockImplementation((input: unknown) => {
      if (typeof input === 'function') {
        const transaction = input as (client: typeof mockPrisma) => Promise<unknown>
        return transaction(mockPrisma)
      }
      if (Array.isArray(input)) return Promise.all(input as Promise<unknown>[])
      throw new Error('지원하지 않는 transaction 입력입니다.')
    })

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanvasRepository,
        {
          provide: PrismaService,
          useValue: mockPrisma, // Manual Mock 주입
        },
      ],
    }).compile()

    repository = module.get<CanvasRepository>(CanvasRepository)
  })

  describe('getMergedUpdate', () => {
    it('로그가 없으면 빈 Uint8Array를 반환해야 한다', async () => {
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([])

      const result = await repository.getMergedUpdate('cat-1')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(result.byteLength).toBe(0)
      expect(mockPrisma.categorySnapshot.findUnique).toHaveBeenCalledWith({
        where: { categoryId: 'cat-1' },
      })
      expect(mockPrisma.categoryUpdateLog.findMany).toHaveBeenCalledWith({
        where: { categoryId: 'cat-1' },
        orderBy: { id: 'asc' },
      })
    })

    it('로그가 있으면 병합된 업데이트를 반환해야 한다', async () => {
      // 1. 'Hello'를 추가하는 첫 번째 업데이트 생성
      const docForUpdate1 = new Y.Doc()
      docForUpdate1.getText('content').insert(0, 'Hello')
      const update1 = Y.encodeStateAsUpdate(docForUpdate1)

      // 2. 첫 번째 업데이트 상태에서 ' World'를 추가하는 두 번째 업데이트(diff) 생성
      const docForUpdate2 = new Y.Doc()
      Y.applyUpdate(docForUpdate2, update1) // 첫 번째 업데이트 적용
      docForUpdate2.getText('content').insert(5, ' World')
      const stateVectorAfter1 = Y.encodeStateVector(docForUpdate1)
      const update2 = Y.encodeStateAsUpdate(docForUpdate2, stateVectorAfter1) // diff 생성

      // DB에서 순차적인 로그들을 가져온 것처럼 모킹
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([{ updateData: Buffer.from(update1) }, { updateData: Buffer.from(update2) }])

      const result = await repository.getMergedUpdate('cat-1')

      // 병합된 결과 검증
      const resultDoc = new Y.Doc()
      Y.applyUpdate(resultDoc, result)

      const content = resultDoc.getText('content').toJSON()
      expect(content).toBe('Hello World')
    })

    it('snapshot과 이후에 남은 로그를 함께 병합해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'snapshot')
      const snapshotData = Y.encodeStateAsUpdate(doc)
      const snapshotStateVector = Y.encodeStateVector(doc)

      doc.getText('content').insert(8, ' + log')
      const remainingUpdate = Y.encodeStateAsUpdate(doc, snapshotStateVector)

      mockPrisma.categorySnapshot.findUnique.mockResolvedValue({
        categoryId: 'cat-1',
        snapshotData: Buffer.from(snapshotData),
        lastLogId: 10n,
      })
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([{ id: 11n, updateData: Buffer.from(remainingUpdate) }])

      const result = await repository.getMergedUpdate('cat-1')
      const restoredDoc = new Y.Doc()
      Y.applyUpdate(restoredDoc, result)

      expect(restoredDoc.getText('content').toJSON()).toBe('snapshot + log')
    })
  })

  describe('saveDurableUpdates', () => {
    it('새 update들을 하나의 로그로 병합하고 receipt와 함께 저장해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'A')
      const update1 = Y.encodeStateAsUpdate(doc)
      const stateAfterUpdate1 = Y.encodeStateVector(doc)
      doc.getText('content').insert(1, 'B')
      const update2 = Y.encodeStateAsUpdate(doc, stateAfterUpdate1)
      let capturedCreate: Prisma.CategoryUpdateLogCreateArgs | undefined
      mockPrisma.categoryUpdateLog.create.mockImplementation((args: Prisma.CategoryUpdateLogCreateArgs) => {
        capturedCreate = args
        return Promise.resolve()
      })

      const result = await repository.saveDurableUpdates('cat-1', [
        { updateId: '00000000-0000-4000-8000-000000000001', update: update1 },
        { updateId: '00000000-0000-4000-8000-000000000002', update: update2 },
      ])

      expect(capturedCreate).toBeDefined()
      if (!capturedCreate) throw new Error('update log create가 호출되지 않았습니다.')
      const restoredDoc = new Y.Doc()
      Y.applyUpdate(restoredDoc, new Uint8Array(capturedCreate.data.updateData))

      expect(restoredDoc.getText('content').toJSON()).toBe('AB')
      expect(mockPrisma.categoryUpdateReceipt.createMany).toHaveBeenCalledWith({
        data: [
          { categoryId: 'cat-1', updateId: '00000000-0000-4000-8000-000000000001' },
          { categoryId: 'cat-1', updateId: '00000000-0000-4000-8000-000000000002' },
        ],
      })
      expect(result.get('00000000-0000-4000-8000-000000000001')).toBe('persisted')
      expect(result.get('00000000-0000-4000-8000-000000000002')).toBe('persisted')
    })

    it('이미 receipt가 존재하는 update는 로그에 다시 포함하지 않아야 한다', async () => {
      const duplicateId = '00000000-0000-4000-8000-000000000001'
      const newId = '00000000-0000-4000-8000-000000000002'
      const duplicateUpdate = new Uint8Array([0, 0])
      const newDoc = new Y.Doc()
      newDoc.getMap('fixture').set('new', true)
      const newUpdate = Y.encodeStateAsUpdate(newDoc)
      mockPrisma.categoryUpdateReceipt.findMany.mockResolvedValue([{ updateId: duplicateId }])

      const result = await repository.saveDurableUpdates('cat-1', [
        { updateId: duplicateId, update: duplicateUpdate },
        { updateId: newId, update: newUpdate },
      ])

      expect(mockPrisma.categoryUpdateLog.create).toHaveBeenCalledWith({
        data: {
          categoryId: 'cat-1',
          updateData: Buffer.from(newUpdate),
        },
      })
      expect(mockPrisma.categoryUpdateReceipt.createMany).toHaveBeenCalledWith({
        data: [{ categoryId: 'cat-1', updateId: newId }],
      })
      expect(result.get(duplicateId)).toBe('duplicate')
      expect(result.get(newId)).toBe('persisted')
    })

    it('모든 update가 중복이면 로그와 receipt를 추가하지 않아야 한다', async () => {
      const updateId = '00000000-0000-4000-8000-000000000001'
      mockPrisma.categoryUpdateReceipt.findMany.mockResolvedValue([{ updateId }])

      const result = await repository.saveDurableUpdates('cat-1', [{ updateId, update: new Uint8Array([0, 0]) }])

      expect(mockPrisma.categoryUpdateLog.create).not.toHaveBeenCalled()
      expect(mockPrisma.categoryUpdateReceipt.createMany).not.toHaveBeenCalled()
      expect(result.get(updateId)).toBe('duplicate')
    })

    it('동시 저장 transaction 충돌은 제한된 횟수 안에서 재시도해야 한다', async () => {
      const transactionConflict = Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      mockPrisma.$transaction.mockRejectedValueOnce(transactionConflict)

      const updateId = '00000000-0000-4000-8000-000000000003'
      const doc = new Y.Doc()
      doc.getMap('fixture').set('retry', true)

      const result = await repository.saveDurableUpdates('cat-1', [{ updateId, update: Y.encodeStateAsUpdate(doc) }])

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
      expect(result.get(updateId)).toBe('persisted')
    })
  })

  describe('compactUpdateLogs', () => {
    it('누적 로그가 임계값보다 적으면 compaction을 수행하지 않아야 한다', async () => {
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([{ id: 1n, updateData: Buffer.from([1]) }])

      const result = await repository.compactUpdateLogs('cat-1', 2)

      expect(result).toEqual({ compacted: false, compactedLogCount: 0 })
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(mockPrisma.categorySnapshot.findUnique).not.toHaveBeenCalled()
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    })

    it('기존 snapshot과 임계값만큼의 로그를 병합하고 조회한 로그만 원자적으로 삭제해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'A')
      const snapshotData = Y.encodeStateAsUpdate(doc)
      const stateAfterSnapshot = Y.encodeStateVector(doc)

      doc.getText('content').insert(1, 'B')
      const update1 = Y.encodeStateAsUpdate(doc, stateAfterSnapshot)
      const stateAfterUpdate1 = Y.encodeStateVector(doc)

      doc.getText('content').insert(2, 'C')
      const update2 = Y.encodeStateAsUpdate(doc, stateAfterUpdate1)

      mockPrisma.categorySnapshot.findUnique.mockResolvedValue({
        categoryId: 'cat-1',
        snapshotData: Buffer.from(snapshotData),
        lastLogId: 7n,
      })
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([
        { id: 8n, updateData: Buffer.from(update1) },
        { id: 10n, updateData: Buffer.from(update2) },
      ])

      let capturedUpsert: Prisma.CategorySnapshotUpsertArgs | undefined
      mockPrisma.categorySnapshot.upsert.mockImplementation((args: Prisma.CategorySnapshotUpsertArgs) => {
        capturedUpsert = args
        return Promise.resolve()
      })

      const result = await repository.compactUpdateLogs('cat-1', 2)

      expect(capturedUpsert).toBeDefined()
      if (!capturedUpsert) throw new Error('snapshot upsert가 호출되지 않았습니다.')
      const compactedDoc = new Y.Doc()
      Y.applyUpdate(compactedDoc, new Uint8Array(capturedUpsert.create.snapshotData))

      expect(compactedDoc.getText('content').toJSON()).toBe('ABC')
      expect(capturedUpsert.where).toEqual({ categoryId: 'cat-1' })
      expect(capturedUpsert.create.categoryId).toBe('cat-1')
      expect(capturedUpsert.create.lastLogId).toBe(10n)
      expect(capturedUpsert.update.lastLogId).toBe(10n)
      expect(Buffer.isBuffer(capturedUpsert.create.snapshotData)).toBe(true)
      expect(Buffer.isBuffer(capturedUpsert.update.snapshotData)).toBe(true)
      expect(mockPrisma.categoryUpdateLog.deleteMany).toHaveBeenCalledWith({
        where: {
          categoryId: 'cat-1',
          id: { in: [8n, 10n] },
        },
      })
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
      expect(result.compacted).toBe(true)
      expect(result.compactedLogCount).toBe(2)
      expect(result.snapshotByteLength).toBeGreaterThan(0)
      expect(result.lastLogId).toBe(10n)
    })

    it('transaction이 실패하면 compaction 실패를 호출자에게 전달해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'data')
      const update = Y.encodeStateAsUpdate(doc)
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([{ id: 1n, updateData: Buffer.from(update) }])
      mockPrisma.$transaction.mockRejectedValue(new Error('transaction failed'))

      await expect(repository.compactUpdateLogs('cat-1', 1)).rejects.toThrow('transaction failed')
    })

    it('삭제 update를 snapshot에 포함해 복원해야 한다', async () => {
      const doc = new Y.Doc()
      const items = doc.getArray<string>('items')
      items.insert(0, ['deleted later'])
      const snapshotData = Y.encodeStateAsUpdate(doc)
      const stateBeforeDelete = Y.encodeStateVector(doc)

      items.delete(0)
      const deleteUpdate = Y.encodeStateAsUpdate(doc, stateBeforeDelete)

      mockPrisma.categorySnapshot.findUnique.mockResolvedValue({
        categoryId: 'cat-1',
        snapshotData: Buffer.from(snapshotData),
        lastLogId: 1n,
      })
      mockPrisma.categoryUpdateLog.findMany.mockResolvedValue([{ id: 2n, updateData: Buffer.from(deleteUpdate) }])

      let capturedSnapshot: Uint8Array | undefined
      mockPrisma.categorySnapshot.upsert.mockImplementation((args: Prisma.CategorySnapshotUpsertArgs) => {
        capturedSnapshot = new Uint8Array(args.create.snapshotData)
        return Promise.resolve()
      })

      await repository.compactUpdateLogs('cat-1', 1)

      expect(capturedSnapshot).toBeDefined()
      if (!capturedSnapshot) throw new Error('snapshot upsert가 호출되지 않았습니다.')
      const restoredDoc = new Y.Doc()
      Y.applyUpdate(restoredDoc, capturedSnapshot)

      expect(restoredDoc.getArray('items').toArray()).toEqual([])
    })
  })
})
