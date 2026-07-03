import { CustomException } from '@/lib/exceptions/custom.exception'
import { ErrorType } from '@/lib/types/response.type'
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import * as Y from 'yjs'
import { encodeStateAsUpdate, encodeStateVector, applyUpdate } from 'yjs'
import { CanvasRepository, type DurableYjsUpdateStatus } from './canvas.repository'

interface YjsDocument {
  doc: Y.Doc
  roomId: string
  categoryId: string
}

export interface YjsUpdateAck {
  canvasId: string
  updateId: string
  status: DurableYjsUpdateStatus
}

export interface ProcessedYjsUpdate {
  shouldBroadcast: boolean
  persisted: Promise<YjsUpdateAck>
}

interface BufferedYjsUpdate {
  updateId: string
  update: Uint8Array
  resolve: (ack: YjsUpdateAck) => void
  persisted: Promise<YjsUpdateAck>
}

const YJS_COMPACTION_LOG_THRESHOLD = 100
const RECENTLY_PERSISTED_UPDATE_LIMIT = 5000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

@Injectable()
export class CanvasService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanvasService.name)

  constructor(private readonly canvasRepository: CanvasRepository) {}

  // categoryId -> YjsDocument 매핑
  private documents = new Map<string, YjsDocument>()

  // socketId -> Set<categoryId> 매핑 (역방향 인덱스)
  private clientConnections = new Map<string, Set<string>>()

  // 업데이트 버퍼: categoryId -> durable update 배열
  private updateBuffer = new Map<string, BufferedYjsUpdate[]>()

  // 같은 update ID가 ack 전에 재전송되면 동일한 저장 Promise를 공유한다.
  private pendingUpdates = new Map<string, BufferedYjsUpdate>()

  // ack 유실 직후 재전송을 DB flush 없이 즉시 멱등 처리하기 위한 bounded cache.
  private recentlyPersistedUpdates = new Map<string, true>()

  // 배치 저장 타이머
  private saveInterval: NodeJS.Timeout

  onModuleInit() {
    // 5초마다 버퍼에 쌓인 데이터를 DB에 저장
    this.saveInterval = setInterval(() => {
      void this.flushBufferToDB().catch(err => {
        this.logger.error('Background Flush Failed', err instanceof Error ? err.stack : err)
      })
    }, 5000)
  }

  onModuleDestroy() {
    // 서버 종료 시 남은 데이터 강제 저장
    clearInterval(this.saveInterval)
    void this.flushBufferToDB().catch(err => {
      this.logger.error('Final Flush Failed', err instanceof Error ? err.stack : err)
    })
  }

  /**
   * Category용 Yjs 문서 생성 또는 가져오기
   * Y.Doc이 메모리에 없다면, DB에서 조회해서 메모리 초기화.
   */
  private async getOrCreateDocument(roomId: string, categoryId: string): Promise<Y.Doc> {
    const existing = this.documents.get(categoryId)
    if (existing) return existing.doc

    const doc = new Y.Doc()

    try {
      // DB에서 기존 데이터 불러와서 병합
      const initialUpdate = await this.canvasRepository.getMergedUpdate(categoryId)
      if (initialUpdate.byteLength > 0) {
        Y.applyUpdate(doc, initialUpdate)
      }
    } catch (error) {
      this.logger.error(`Failed to load document from DB: ${categoryId}`, error)
      throw new CustomException(ErrorType.InternalServerError, '캔버스 데이터를 불러오는데 실패했습니다.')
    }

    this.documents.set(categoryId, {
      doc,
      roomId,
      categoryId,
    })

    return doc
  }

  /**
   * 클라이언트를 문서에 연결
   */
  connectClient(categoryId: string, socketId: string) {
    // 문서가 존재하는지 확인
    if (this.documents.has(categoryId)) {
      // 역방향 매핑 업데이트
      if (!this.clientConnections.has(socketId)) {
        this.clientConnections.set(socketId, new Set())
      }
      this.clientConnections.get(socketId)!.add(categoryId)
    }
  }

  /**
   * 클라이언트 연결 해제
   */
  disconnectClient(socketId: string): string[] {
    const categoryIds = this.clientConnections.get(socketId)
    if (!categoryIds) return []

    const disconnectedCategories: string[] = []

    for (const categoryId of categoryIds) {
      // 문서가 메모리에 존재하는지 확인
      if (this.documents.has(categoryId)) {
        disconnectedCategories.push(categoryId)
      }
    }

    // 역방향 매핑 제거
    this.clientConnections.delete(socketId)

    return disconnectedCategories
  }

  /**
   * 캔버스 접속 초기화 로직 통합
   * 1. 문서 가져오기 (DB or Memory)
   * 2. 클라이언트 접속 등록
   * 3. 초기 동기화 데이터(StateVector) 반환
   */
  async initializeConnection(roomId: string, categoryId: string, socketId: string, clientStateVector?: Uint8Array) {
    try {
      // 1. 문서 확보
      const doc = await this.getOrCreateDocument(roomId, categoryId)

      // 2. 접속자 등록
      this.connectClient(categoryId, socketId)

      // 3. 클라이언트가 아직 갖지 못한 서버 변경만 계산
      let update: Uint8Array
      try {
        update = clientStateVector ? encodeStateAsUpdate(doc, clientStateVector) : encodeStateAsUpdate(doc)
      } catch {
        throw new CustomException(ErrorType.BadRequest, '잘못된 Yjs state vector입니다.')
      }
      const serverStateVector = encodeStateVector(doc)
      const docKey = `${roomId}-${categoryId}`

      return {
        docKey,
        update: this.hasUpdateContent(update) ? Array.from(update) : undefined,
        serverStateVector: Array.from(serverStateVector),
        durableAckSupported: true,
      }
    } catch (error) {
      this.logger.error(`Failed to initialize connection for ${categoryId}`, error)
      if (error instanceof CustomException && error.type === ErrorType.BadRequest) throw error
      throw new CustomException(ErrorType.InternalServerError, '캔버스 연결 초기화에 실패했습니다.')
    }
  }

  private hasUpdateContent(update: Uint8Array): boolean {
    const decoded = Y.decodeUpdate(update)
    return decoded.structs.length > 0 || decoded.ds.clients.size > 0
  }

  /**
   * 업데이트를 메모리 문서에 즉시 적용하고 durable ack용 버퍼에 담는다.
   * 같은 update ID가 pending 또는 최근 저장 상태라면 다시 적용하거나 브로드캐스트하지 않는다.
   */
  processUpdate(categoryId: string, updateId: string, update: Uint8Array): ProcessedYjsUpdate {
    const yjsDoc = this.documents.get(categoryId)

    if (!yjsDoc) {
      throw new CustomException(ErrorType.NotFound, '활성화된 캔버스 세션을 찾을 수 없습니다. 다시 접속해주세요.')
    }

    if (!UUID_PATTERN.test(updateId)) {
      throw new CustomException(ErrorType.BadRequest, '잘못된 Yjs update ID입니다.')
    }

    const pendingKey = this.createPendingKey(categoryId, updateId)
    if (this.recentlyPersistedUpdates.has(pendingKey)) {
      return {
        shouldBroadcast: false,
        persisted: Promise.resolve({ canvasId: categoryId, updateId, status: 'duplicate' }),
      }
    }

    const existingPending = this.pendingUpdates.get(pendingKey)
    if (existingPending) {
      return { shouldBroadcast: false, persisted: existingPending.persisted }
    }

    try {
      applyUpdate(yjsDoc.doc, update)
    } catch (error) {
      this.logger.error(`Yjs Update Error [${categoryId}]`, error)
      throw new CustomException(ErrorType.BadRequest, '잘못된 캔버스 데이터 형식입니다.')
    }

    let resolveAck!: (ack: YjsUpdateAck) => void
    const persisted = new Promise<YjsUpdateAck>(resolve => {
      resolveAck = resolve
    })
    const bufferedUpdate: BufferedYjsUpdate = {
      updateId,
      update,
      resolve: resolveAck,
      persisted,
    }

    this.pendingUpdates.set(pendingKey, bufferedUpdate)
    this.bufferUpdate(categoryId, bufferedUpdate)

    return { shouldBroadcast: true, persisted }
  }

  private createPendingKey(categoryId: string, updateId: string) {
    return `${categoryId}:${updateId}`
  }

  private bufferUpdate(categoryId: string, update: BufferedYjsUpdate) {
    if (!this.updateBuffer.has(categoryId)) {
      this.updateBuffer.set(categoryId, [])
    }
    this.updateBuffer.get(categoryId)!.push(update)
  }

  private rememberPersistedUpdate(pendingKey: string) {
    this.recentlyPersistedUpdates.set(pendingKey, true)
    if (this.recentlyPersistedUpdates.size <= RECENTLY_PERSISTED_UPDATE_LIMIT) return

    const oldestKey = this.recentlyPersistedUpdates.keys().next().value as string | undefined
    if (oldestKey) this.recentlyPersistedUpdates.delete(oldestKey)
  }

  /**
   * YjsUpdateLog 버퍼 내용을 병합하여 DB에 저장 (Flush)
   */
  async flushBufferToDB() {
    if (this.updateBuffer.size === 0) return

    // 현재 버퍼의 스냅샷을 뜨고 맵을 비움 (동시성 이슈 방지)
    const currentBuffer = new Map(this.updateBuffer)
    this.updateBuffer.clear()

    for (const [categoryId, bufferedUpdates] of currentBuffer.entries()) {
      if (bufferedUpdates.length === 0) continue

      try {
        const statuses = await this.canvasRepository.saveDurableUpdates(
          categoryId,
          bufferedUpdates.map(({ updateId, update }) => ({ updateId, update })),
        )

        for (const bufferedUpdate of bufferedUpdates) {
          const pendingKey = this.createPendingKey(categoryId, bufferedUpdate.updateId)
          const status = statuses.get(bufferedUpdate.updateId) ?? 'persisted'
          bufferedUpdate.resolve({ canvasId: categoryId, updateId: bufferedUpdate.updateId, status })
          if (this.pendingUpdates.get(pendingKey) === bufferedUpdate) {
            this.pendingUpdates.delete(pendingKey)
          }
          this.rememberPersistedUpdate(pendingKey)
        }

        this.logger.log(`[Yjs] Durably flushed ${bufferedUpdates.length} updates for category ${categoryId}`)
      } catch (err) {
        this.logger.error(`Flush failed for ${categoryId}, restoring buffer...`, err)

        const newUpdates = this.updateBuffer.get(categoryId) || []
        this.updateBuffer.set(categoryId, [...bufferedUpdates, ...newUpdates])
        continue
      }

      try {
        const result = await this.canvasRepository.compactUpdateLogs(categoryId, YJS_COMPACTION_LOG_THRESHOLD)
        if (result.compacted) {
          this.logger.log(
            `[Yjs] Compacted ${result.compactedLogCount} logs for category ${categoryId} ` +
              `(snapshot=${result.snapshotByteLength}B, lastLogId=${result.lastLogId?.toString()})`,
          )
        }
      } catch (err) {
        // update log 저장은 이미 완료되었다. compaction 실패는 데이터 유실이 아니므로
        // 버퍼에 복구하지 않고 다음 flush에서 다시 시도한다.
        this.logger.error(`Compaction failed for ${categoryId}; persisted logs remain intact`, err)
      }
    }
  }
}
