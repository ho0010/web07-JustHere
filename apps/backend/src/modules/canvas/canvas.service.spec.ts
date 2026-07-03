import { Test, TestingModule } from '@nestjs/testing'
import { CanvasService } from './canvas.service'
import { CanvasRepository } from './canvas.repository'
import { Logger } from '@nestjs/common'
import * as Y from 'yjs'
import { CustomException } from '@/lib/exceptions/custom.exception'
import { ErrorType } from '@/lib/types/response.type'

describe('YjsService', () => {
  let service: CanvasService

  const updateId = (sequence: number) => `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`

  // Manual Mock 객체 정의
  let mockRepository: {
    getMergedUpdate: jest.Mock
    saveDurableUpdates: jest.Mock
    compactUpdateLogs: jest.Mock
  }

  beforeEach(async () => {
    // 타이머 모킹 설정 (각 테스트마다 초기화)
    jest.useFakeTimers()

    // Mock 구현체 초기화
    mockRepository = {
      getMergedUpdate: jest.fn(),
      saveDurableUpdates: jest.fn().mockImplementation((_categoryId: string, updates: Array<{ updateId: string }>) => {
        return Promise.resolve(new Map(updates.map(update => [update.updateId, 'persisted'])))
      }),
      compactUpdateLogs: jest.fn().mockResolvedValue({ compacted: false, compactedLogCount: 0 }),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanvasService,
        {
          provide: CanvasRepository,
          useValue: mockRepository, // Manual Mock 주입
        },
      ],
    }).compile()

    service = module.get<CanvasService>(CanvasService)

    // Logger 모킹
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    // 타이머 정리
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('initializeConnection', () => {
    const roomId = 'room-1'
    const categoryId = 'cat-1'
    const socketId = 'socket-1'

    it('새 문서를 생성하고 초기 업데이트 데이터를 반환해야 한다', async () => {
      // spyOn 대신 mock 객체 직접 제어
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())

      const result = await service.initializeConnection(roomId, categoryId, socketId)

      expect(result.docKey).toBe(`${roomId}-${categoryId}`)
      expect(result.update).toBeUndefined()
      expect(result.serverStateVector).toEqual(Array.from(Y.encodeStateVector(new Y.Doc())))
      expect(result.durableAckSupported).toBe(true)
      expect(mockRepository.getMergedUpdate).toHaveBeenCalledWith(categoryId)
    })

    it('기존 DB 데이터를 불러와 문서를 초기화해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('test').insert(0, 'hello')
      const update = Y.encodeStateAsUpdate(doc)

      // YDoc 문서 병합
      mockRepository.getMergedUpdate.mockResolvedValue(update)

      const result = await service.initializeConnection(roomId, categoryId, socketId)

      const clientDoc = new Y.Doc()
      if (result.update) {
        Y.applyUpdate(clientDoc, new Uint8Array(result.update))
      }

      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      expect(clientDoc.getText('test').toString()).toBe('hello')
    })

    it('이미 메모리에 로드된 문서가 있다면 DB 조회 없이 반환해야 한다', async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())

      // 첫 번째 호출 (DB 조회 발생)
      await service.initializeConnection(roomId, categoryId, socketId)

      // 두 번째 호출 (메모리 캐시 사용)
      await service.initializeConnection(roomId, categoryId, 'socket-2')

      expect(mockRepository.getMergedUpdate).toHaveBeenCalledTimes(1)
    })

    it('DB에서 문서 로드 실패 시 InternalServerError 예외를 던져야 한다', async () => {
      mockRepository.getMergedUpdate.mockRejectedValue(new Error('DB Error'))

      await expect(service.initializeConnection(roomId, categoryId, socketId)).rejects.toThrow(
        new CustomException(ErrorType.InternalServerError, '캔버스 연결 초기화에 실패했습니다.'),
      )
    })

    it('손상된 client state vector는 BadRequest로 거절해야 한다', async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())

      await expect(service.initializeConnection(roomId, categoryId, socketId, new Uint8Array([255]))).rejects.toThrow(
        new CustomException(ErrorType.BadRequest, '잘못된 Yjs state vector입니다.'),
      )
    })

    it('클라이언트 state vector를 기준으로 서버의 누락된 변경만 반환해야 한다', async () => {
      const serverDoc = new Y.Doc()
      const clientDoc = new Y.Doc()
      serverDoc.getMap('fixture').set('shared', true)
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc))
      serverDoc.getMap('fixture').set('server-only', true)

      const fullServerUpdate = Y.encodeStateAsUpdate(serverDoc)
      mockRepository.getMergedUpdate.mockResolvedValue(fullServerUpdate)

      const result = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))

      expect(result.update).toBeDefined()
      expect(result.update!.length).toBeLessThan(fullServerUpdate.byteLength)
      Y.applyUpdate(clientDoc, new Uint8Array(result.update!))
      expect(clientDoc.getMap('fixture').toJSON()).toEqual(serverDoc.getMap('fixture').toJSON())

      clientDoc.destroy()
      serverDoc.destroy()
    })

    it('새 struct가 없는 서버 삭제 변경도 누락 update에 포함해야 한다', async () => {
      const serverDoc = new Y.Doc()
      const clientDoc = new Y.Doc()
      serverDoc.getArray('fixture').push(['keep', 'delete'])
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc))
      serverDoc.getArray('fixture').delete(1, 1)
      mockRepository.getMergedUpdate.mockResolvedValue(Y.encodeStateAsUpdate(serverDoc))

      const result = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))

      expect(result.update).toBeDefined()
      Y.applyUpdate(clientDoc, new Uint8Array(result.update!))
      expect(clientDoc.getArray('fixture').toArray()).toEqual(['keep'])

      clientDoc.destroy()
      serverDoc.destroy()
    })

    it('서버와 오프라인 클라이언트가 각각 수정해도 재접속 후 양방향으로 수렴해야 한다', async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())

      const clientDoc = new Y.Doc()
      const initial = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))
      if (initial.update) {
        Y.applyUpdate(clientDoc, new Uint8Array(initial.update))
      }

      clientDoc.getMap('fixture').set('client-only', 'offline edit')

      const remoteDoc = new Y.Doc()
      remoteDoc.getMap('fixture').set('server-only', 'online edit')
      service.processUpdate(categoryId, updateId(1), Y.encodeStateAsUpdate(remoteDoc))

      const reconnected = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))
      if (reconnected.update) {
        Y.applyUpdate(clientDoc, new Uint8Array(reconnected.update))
      }

      const clientOnlyUpdate = Y.encodeStateAsUpdate(clientDoc, new Uint8Array(reconnected.serverStateVector))
      service.processUpdate(categoryId, updateId(2), clientOnlyUpdate)

      const verificationDoc = new Y.Doc()
      const verification = await service.initializeConnection(roomId, categoryId, 'verification-socket', Y.encodeStateVector(verificationDoc))
      if (verification.update) {
        Y.applyUpdate(verificationDoc, new Uint8Array(verification.update))
      }

      expect(verificationDoc.getMap('fixture').toJSON()).toEqual({
        'client-only': 'offline edit',
        'server-only': 'online edit',
      })

      verificationDoc.destroy()
      remoteDoc.destroy()
      clientDoc.destroy()
    })

    it('같은 key의 동시 수정과 중복 update가 있어도 재접속 후 같은 상태로 수렴해야 한다', async () => {
      const baseDoc = new Y.Doc()
      baseDoc.getMap('fixture').set('conflict', 'base')
      const baseUpdate = Y.encodeStateAsUpdate(baseDoc)
      mockRepository.getMergedUpdate.mockResolvedValue(baseUpdate)

      const clientDoc = new Y.Doc()
      const initial = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))
      Y.applyUpdate(clientDoc, new Uint8Array(initial.update!))

      clientDoc.getMap('fixture').set('conflict', 'offline client')

      const onlineDoc = new Y.Doc()
      Y.applyUpdate(onlineDoc, baseUpdate)
      onlineDoc.getMap('fixture').set('conflict', 'online client')
      const onlineUpdate = Y.encodeStateAsUpdate(onlineDoc, Y.encodeStateVector(baseDoc))
      service.processUpdate(categoryId, updateId(3), onlineUpdate)

      const reconnected = await service.initializeConnection(roomId, categoryId, socketId, Y.encodeStateVector(clientDoc))
      if (reconnected.update) {
        Y.applyUpdate(clientDoc, new Uint8Array(reconnected.update))
      }

      const clientUpdate = Y.encodeStateAsUpdate(clientDoc, new Uint8Array(reconnected.serverStateVector))
      service.processUpdate(categoryId, updateId(4), clientUpdate)
      service.processUpdate(categoryId, updateId(4), clientUpdate)

      const verificationDoc = new Y.Doc()
      const verification = await service.initializeConnection(roomId, categoryId, 'verification-socket', Y.encodeStateVector(verificationDoc))
      Y.applyUpdate(verificationDoc, new Uint8Array(verification.update!))

      expect(verificationDoc.getMap('fixture').toJSON()).toEqual(clientDoc.getMap('fixture').toJSON())

      verificationDoc.destroy()
      onlineDoc.destroy()
      clientDoc.destroy()
      baseDoc.destroy()
    })
  })

  describe('connectClient', () => {
    it('문서가 존재하지 않으면 클라이언트를 연결하지 않아야 한다', () => {
      // initializeConnection을 호출하지 않고 connectClient 직접 호출
      service.connectClient('non-existent-cat', 'socket-1')

      // 연결되지 않았으므로 disconnect 시 빈 배열 반환
      const disconnected = service.disconnectClient('socket-1')
      expect(disconnected).toEqual([])
    })

    it('이미 연결된 클라이언트가 같은 카테고리에 다시 연결되어도 중복되지 않아야 한다', async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())
      await service.initializeConnection('room-1', 'cat-1', 'socket-1')

      // 다시 연결 시도
      service.connectClient('cat-1', 'socket-1')

      const disconnected = service.disconnectClient('socket-1')
      expect(disconnected).toHaveLength(1)
      expect(disconnected).toContain('cat-1')
    })
  })

  describe('disconnectClient', () => {
    it('클라이언트 연결을 해제하고 참여 중이던 캔버스 ID 목록을 반환해야 한다', async () => {
      const socketId = 'user-1'
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())

      await service.initializeConnection('room-1', 'cat-1', socketId)
      await service.initializeConnection('room-1', 'cat-2', socketId)

      const result = service.disconnectClient(socketId)

      expect(result).toHaveLength(2)
      expect(result).toContain('cat-1')
      expect(result).toContain('cat-2')
    })

    it('연결되지 않은 클라이언트 해제 시 빈 배열을 반환해야 한다', () => {
      const result = service.disconnectClient('unknown-socket')
      expect(result).toEqual([])
    })
  })

  describe('processUpdate', () => {
    const roomId = 'room-1'
    const categoryId = 'cat-1'
    const socketId = 'socket-1'

    beforeEach(async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())
      await service.initializeConnection(roomId, categoryId, socketId)
    })

    it('업데이트를 메모리 문서에 적용하고 버퍼에 쌓아야 한다', () => {
      const clientDoc = new Y.Doc()
      clientDoc.getText('content').insert(0, 'A')
      const update = Y.encodeStateAsUpdate(clientDoc)

      expect(() => service.processUpdate(categoryId, updateId(10), update)).not.toThrow()
    })

    it('존재하지 않는 캔버스에 업데이트 시 NotFound 예외를 던져야 한다', () => {
      const update = new Uint8Array([0, 0])
      expect(() => service.processUpdate('invalid-cat', updateId(11), update)).toThrow(
        new CustomException(ErrorType.NotFound, '활성화된 캔버스 세션을 찾을 수 없습니다. 다시 접속해주세요.'),
      )
    })

    it('잘못된 형식의 업데이트 데이터인 경우 BadRequest 예외를 던져야 한다', () => {
      const invalidUpdate = new Uint8Array([1, 2, 3, 4, 5])

      expect(() => service.processUpdate(categoryId, updateId(12), invalidUpdate)).toThrow(
        new CustomException(ErrorType.BadRequest, '잘못된 캔버스 데이터 형식입니다.'),
      )
    })

    it('잘못된 update ID는 BadRequest로 거절해야 한다', () => {
      const validDoc = new Y.Doc()
      validDoc.getMap('fixture').set('valid', true)

      expect(() => service.processUpdate(categoryId, 'invalid-update-id', Y.encodeStateAsUpdate(validDoc))).toThrow(
        new CustomException(ErrorType.BadRequest, '잘못된 Yjs update ID입니다.'),
      )
    })

    it('같은 update ID가 ack 전에 재전송되면 동일한 저장 Promise를 공유해야 한다', () => {
      const clientDoc = new Y.Doc()
      clientDoc.getMap('fixture').set('value', true)
      const update = Y.encodeStateAsUpdate(clientDoc)

      const first = service.processUpdate(categoryId, updateId(13), update)
      const duplicate = service.processUpdate(categoryId, updateId(13), update)

      expect(first.shouldBroadcast).toBe(true)
      expect(duplicate.shouldBroadcast).toBe(false)
      expect(duplicate.persisted).toBe(first.persisted)
    })

    it('DB flush가 성공한 뒤에만 durable ack를 resolve해야 한다', async () => {
      const clientDoc = new Y.Doc()
      clientDoc.getMap('fixture').set('value', true)
      const processed = service.processUpdate(categoryId, updateId(14), Y.encodeStateAsUpdate(clientDoc))
      const ackListener = jest.fn()
      void processed.persisted.then(ackListener)

      await Promise.resolve()
      expect(ackListener).not.toHaveBeenCalled()

      await service.flushBufferToDB()
      await expect(processed.persisted).resolves.toEqual({
        canvasId: categoryId,
        updateId: updateId(14),
        status: 'persisted',
      })
    })

    it('저장 완료된 update ID 재전송은 즉시 duplicate ack하고 다시 버퍼링하지 않아야 한다', async () => {
      const clientDoc = new Y.Doc()
      clientDoc.getMap('fixture').set('value', true)
      const encodedUpdate = Y.encodeStateAsUpdate(clientDoc)
      const first = service.processUpdate(categoryId, updateId(15), encodedUpdate)
      await service.flushBufferToDB()
      await first.persisted

      const duplicate = service.processUpdate(categoryId, updateId(15), encodedUpdate)

      expect(duplicate.shouldBroadcast).toBe(false)
      await expect(duplicate.persisted).resolves.toEqual({
        canvasId: categoryId,
        updateId: updateId(15),
        status: 'duplicate',
      })
      expect(mockRepository.saveDurableUpdates).toHaveBeenCalledTimes(1)
    })
  })

  describe('Buffer Flush (onModuleInit & onModuleDestroy)', () => {
    const roomId = 'room-1'
    const categoryId = 'cat-1'

    beforeEach(async () => {
      mockRepository.getMergedUpdate.mockResolvedValue(new Uint8Array())
      await service.initializeConnection(roomId, categoryId, 'socket-1')
    })

    it('onModuleInit: 일정 주기로 버퍼 내용을 DB에 저장해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'a')
      const update = Y.encodeStateAsUpdate(doc)
      let capturedUpdates: Array<{ updateId: string; update: Uint8Array }> = []
      mockRepository.saveDurableUpdates.mockImplementation((_categoryId: string, updates: typeof capturedUpdates) => {
        capturedUpdates = updates
        return Promise.resolve(new Map(updates.map(item => [item.updateId, 'persisted'])))
      })
      service.processUpdate(categoryId, updateId(20), update)

      // 1. 인터벌 시작
      service.onModuleInit()

      // 2. 시간 앞당기기
      jest.advanceTimersByTime(5000)
      await Promise.resolve() // 마이크로태스크 큐 처리

      expect(capturedUpdates).toHaveLength(1)
      expect(capturedUpdates[0].updateId).toBe(updateId(20))
      expect(capturedUpdates[0].update).toBeInstanceOf(Uint8Array)
    })

    it('onModuleDestroy: 종료 시 버퍼 내용을 DB에 저장해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'b')
      const update = Y.encodeStateAsUpdate(doc)
      let capturedUpdates: Array<{ updateId: string; update: Uint8Array }> = []
      mockRepository.saveDurableUpdates.mockImplementation((_categoryId: string, updates: typeof capturedUpdates) => {
        capturedUpdates = updates
        return Promise.resolve(new Map(updates.map(item => [item.updateId, 'persisted'])))
      })
      service.processUpdate(categoryId, updateId(21), update)

      service.onModuleDestroy()
      await Promise.resolve()

      expect(capturedUpdates).toHaveLength(1)
      expect(capturedUpdates[0].updateId).toBe(updateId(21))
      expect(capturedUpdates[0].update).toBeInstanceOf(Uint8Array)
    })

    it('버퍼가 비어있으면 DB 저장을 수행하지 않아야 한다', async () => {
      service.onModuleDestroy()
      await Promise.resolve()

      expect(mockRepository.saveDurableUpdates).not.toHaveBeenCalled()
    })

    it('update log 저장 성공 후 compaction 임계값을 확인해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'snapshot candidate')
      service.processUpdate(categoryId, updateId(22), Y.encodeStateAsUpdate(doc))

      await service.flushBufferToDB()

      expect(mockRepository.compactUpdateLogs).toHaveBeenCalledWith(categoryId, 100)
    })

    it('compaction 실패 시 이미 저장된 update를 버퍼에 다시 넣지 않아야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'persisted')
      service.processUpdate(categoryId, updateId(23), Y.encodeStateAsUpdate(doc))
      mockRepository.compactUpdateLogs.mockRejectedValueOnce(new Error('Compaction Error'))

      await service.flushBufferToDB()
      await service.flushBufferToDB()

      expect(mockRepository.saveDurableUpdates).toHaveBeenCalledTimes(1)
      expect(mockRepository.compactUpdateLogs).toHaveBeenCalledTimes(1)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(Logger.prototype.error).toHaveBeenCalledWith(`Compaction failed for ${categoryId}; persisted logs remain intact`, expect.any(Error))
    })

    it('DB 저장 실패 시 버퍼를 복구해야 하며, 그 사이 들어온 새 데이터도 보존해야 한다', async () => {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'old')
      const oldUpdate = Y.encodeStateAsUpdate(doc)
      const oldProcessed = service.processUpdate(categoryId, updateId(24), oldUpdate)
      const ackListener = jest.fn()
      void oldProcessed.persisted.then(ackListener)

      // DB 저장 실패 Mocking
      mockRepository.saveDurableUpdates.mockRejectedValueOnce(new Error('DB Save Error'))

      // private method 호출을 위해 any 캐스팅
      const flushPromise = service.flushBufferToDB()

      // Flush 도중 새로운 업데이트 발생 시뮬레이션
      const doc2 = new Y.Doc()
      doc2.getText('t').insert(0, 'new')
      const newUpdate = Y.encodeStateAsUpdate(doc2)
      service.processUpdate(categoryId, updateId(25), newUpdate)

      // Flush 완료 대기
      await flushPromise
      await Promise.resolve()

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(Logger.prototype.error).toHaveBeenCalled()
      expect(ackListener).not.toHaveBeenCalled()

      // 버퍼가 복구되었는지 확인 (old + new)
      // 다시 Flush 시도하여 verify
      mockRepository.saveDurableUpdates.mockResolvedValueOnce(
        new Map([
          [updateId(24), 'persisted'],
          [updateId(25), 'persisted'],
        ]),
      )
      await service.flushBufferToDB()
      await expect(oldProcessed.persisted).resolves.toEqual({
        canvasId: categoryId,
        updateId: updateId(24),
        status: 'persisted',
      })

      expect(mockRepository.saveDurableUpdates).toHaveBeenCalledTimes(2)
      expect(mockRepository.compactUpdateLogs).toHaveBeenCalledTimes(1)
    })
  })
})
