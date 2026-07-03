import 'fake-indexeddb/auto'
import { type INestApplication } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { register } from 'prom-client'
import { io, type Socket } from 'socket.io-client'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { AppModule } from '@/app.module'
import { PrismaService } from '@/lib/prisma/prisma.service'

interface TestRuntime {
  app: INestApplication
  prisma: PrismaService
  socketBaseUrl: string
}

interface CanvasAttachedPayload {
  update?: number[]
  serverStateVector: number[]
  durableAckSupported: boolean
}

interface YjsUpdateAck {
  canvasId: string
  updateId: string
  status: 'persisted' | 'duplicate'
}

const TEST_TIMEOUT_MS = 30_000
const EVENT_TIMEOUT_MS = 10_000
const OUTBOX_METADATA_KEY = 'durable-outbox:v1'

const startTestRuntime = async (): Promise<TestRuntime> => {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleFixture.createNestApplication()
  try {
    await app.listen(0, '127.0.0.1')
  } catch (error) {
    await app.close()
    throw error
  }

  const address = (app.getHttpServer() as Server).address() as AddressInfo
  return {
    app,
    prisma: app.get(PrismaService),
    socketBaseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const waitForSocketEvent = <T>(socket: Socket, event: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handleEvent)
      reject(new Error(`${event} 이벤트를 ${timeoutMs}ms 안에 받지 못했습니다.`))
    }, timeoutMs)
    const handleEvent = (payload: T) => {
      clearTimeout(timeout)
      resolve(payload)
    }
    socket.once(event, handleEvent)
  })

const connectCanvasSocket = async (socketBaseUrl: string): Promise<Socket> => {
  const socket = io(`${socketBaseUrl}/canvas`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Socket 연결을 ${EVENT_TIMEOUT_MS}ms 안에 완료하지 못했습니다.`))
    }, EVENT_TIMEOUT_MS)
    const handleConnect = () => {
      cleanup()
      resolve()
    }
    const handleConnectError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('connect', handleConnect)
      socket.off('connect_error', handleConnectError)
    }

    socket.once('connect', handleConnect)
    socket.once('connect_error', handleConnectError)
  })
  return socket
}

const attachCanvas = async (socket: Socket, roomId: string, canvasId: string, doc: Y.Doc): Promise<CanvasAttachedPayload> => {
  const attached = waitForSocketEvent<CanvasAttachedPayload>(socket, 'canvas:attached')
  socket.emit('canvas:attach', {
    roomId,
    canvasId,
    clientStateVector: Array.from(Y.encodeStateVector(doc)),
  })
  return attached
}

const applyServerUpdate = (doc: Y.Doc, payload: CanvasAttachedPayload, origin: unknown) => {
  if (payload.update?.length) {
    Y.applyUpdate(doc, new Uint8Array(payload.update), origin)
  }
}

const createMissingYjsUpdate = (doc: Y.Doc, remoteStateVector: Uint8Array): Uint8Array | null => {
  const update = Y.encodeStateAsUpdate(doc, remoteStateVector)
  const decoded = Y.decodeUpdate(update)
  return decoded.structs.length === 0 && decoded.ds.clients.size === 0 ? null : update
}

const addOfflineLine = (doc: Y.Doc, lineId: string) => {
  const line = new Y.Map<unknown>()
  line.set('id', lineId)
  line.set('points', [10, 10, 100, 100])
  line.set('stroke', '#111827')
  line.set('strokeWidth', 2)
  line.set('tension', 0.5)
  line.set('lineCap', 'round')
  line.set('lineJoin', 'round')
  line.set('tool', 'pen')
  doc.getArray<Y.Map<unknown>>('lines').push([line])
}

const getLineIds = (doc: Y.Doc): string[] =>
  doc
    .getArray<Y.Map<unknown>>('lines')
    .toArray()
    .map(line => line.get('id') as string)

describe('Yjs offline recovery (e2e)', () => {
  jest.setTimeout(TEST_TIMEOUT_MS)

  let runtime: TestRuntime
  let fixtureRoomId: string | null = null
  const sockets = new Set<Socket>()

  beforeAll(async () => {
    runtime = await startTestRuntime()
  })

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect()
    if (!runtime) return
    if (fixtureRoomId) {
      await runtime.prisma.room.deleteMany({ where: { id: fixtureRoomId } })
    }
    await runtime.app.close()
  })

  it('오프라인 편집을 브라우저 재실행과 서버 재시작 이후에도 DB에서 복원해야 한다', async () => {
    const room = await runtime.prisma.room.create({
      data: {
        slug: `e2e-${crypto.randomUUID()}`,
        x: 127.027621,
        y: 37.497952,
        place_name: 'Yjs recovery e2e',
      },
    })
    fixtureRoomId = room.id
    const category = await runtime.prisma.category.create({
      data: {
        roomId: room.id,
        title: '복구 테스트',
        orderIndex: 0,
      },
    })

    const databaseName = `justhere:yjs:v1:${room.id}:${category.id}`
    const lineId = crypto.randomUUID()

    // 최초 접속 후 네트워크가 끊긴 상황을 만든다.
    const firstDoc = new Y.Doc()
    const firstPersistence = new IndexeddbPersistence(databaseName, firstDoc)
    await firstPersistence.whenSynced
    const firstSocket = await connectCanvasSocket(runtime.socketBaseUrl)
    sockets.add(firstSocket)
    const firstAttached = await attachCanvas(firstSocket, room.id, category.id, firstDoc)
    applyServerUpdate(firstDoc, firstAttached, firstSocket)
    firstSocket.disconnect()
    sockets.delete(firstSocket)

    // Socket이 없는 상태에서 편집하고 탭을 닫는다.
    addOfflineLine(firstDoc, lineId)
    await firstPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([]))
    await firstPersistence.destroy()
    firstDoc.destroy()

    // 같은 IndexedDB 이름으로 새 브라우저 세션을 만들면 오프라인 편집이 복원되어야 한다.
    const restoredDoc = new Y.Doc()
    const restoredPersistence = new IndexeddbPersistence(databaseName, restoredDoc)
    await restoredPersistence.whenSynced
    expect(getLineIds(restoredDoc)).toContain(lineId)

    const restoredSocket = await connectCanvasSocket(runtime.socketBaseUrl)
    sockets.add(restoredSocket)
    const restoredAttached = await attachCanvas(restoredSocket, room.id, category.id, restoredDoc)
    applyServerUpdate(restoredDoc, restoredAttached, restoredSocket)
    expect(restoredAttached.durableAckSupported).toBe(true)

    const missingUpdate = createMissingYjsUpdate(restoredDoc, new Uint8Array(restoredAttached.serverStateVector))
    expect(missingUpdate).not.toBeNull()

    const updateId = crypto.randomUUID()
    const payload = {
      canvasId: category.id,
      updateId,
      update: Array.from(missingUpdate!),
    }
    await restoredPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([payload]))

    const persistedAck = waitForSocketEvent<YjsUpdateAck>(restoredSocket, 'y:update:ack')
    restoredSocket.emit('y:update', payload)
    await expect(persistedAck).resolves.toEqual({ canvasId: category.id, updateId, status: 'persisted' })

    // ack를 잃었다고 가정해 outbox에서는 제거하지 않고 브라우저를 다시 실행한다.
    restoredSocket.disconnect()
    sockets.delete(restoredSocket)
    await restoredPersistence.destroy()
    restoredDoc.destroy()

    const retryDoc = new Y.Doc()
    const retryPersistence = new IndexeddbPersistence(databaseName, retryDoc)
    await retryPersistence.whenSynced
    const restoredOutbox = JSON.parse((await retryPersistence.get(OUTBOX_METADATA_KEY)) as string) as Array<typeof payload>
    expect(restoredOutbox).toEqual([payload])

    const retrySocket = await connectCanvasSocket(runtime.socketBaseUrl)
    sockets.add(retrySocket)
    const retryAttached = await attachCanvas(retrySocket, room.id, category.id, retryDoc)
    applyServerUpdate(retryDoc, retryAttached, retrySocket)

    // 서버 state vector에 이미 포함된 변경은 재접속 reconcile에서 제거된다.
    const retryDiff = createMissingYjsUpdate(retryDoc, new Uint8Array(retryAttached.serverStateVector))
    expect(retryDiff).toBeNull()
    await retryPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([]))
    expect(JSON.parse((await retryPersistence.get(OUTBOX_METADATA_KEY)) as string)).toEqual([])

    const receipt = await runtime.prisma.categoryUpdateReceipt.findUnique({
      where: { categoryId_updateId: { categoryId: category.id, updateId } },
    })
    expect(receipt).not.toBeNull()
    expect(await runtime.prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(1)

    retrySocket.disconnect()
    sockets.delete(retrySocket)

    // 서버 메모리를 제거한 뒤 PostgreSQL만으로 새 Y.Doc을 복원한다.
    await runtime.app.close()
    register.clear()
    runtime = await startTestRuntime()

    const verifierDoc = new Y.Doc()
    const verifierSocket = await connectCanvasSocket(runtime.socketBaseUrl)
    sockets.add(verifierSocket)
    const verifierAttached = await attachCanvas(verifierSocket, room.id, category.id, verifierDoc)
    applyServerUpdate(verifierDoc, verifierAttached, verifierSocket)
    expect(getLineIds(verifierDoc)).toContain(lineId)

    // 서버 재시작 후 동일 updateId를 다시 보내도 DB receipt가 중복 저장을 막아야 한다.
    const duplicateAck = waitForSocketEvent<YjsUpdateAck>(verifierSocket, 'y:update:ack')
    verifierSocket.emit('y:update', payload)
    await expect(duplicateAck).resolves.toEqual({ canvasId: category.id, updateId, status: 'duplicate' })
    expect(await runtime.prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(1)

    verifierSocket.disconnect()
    sockets.delete(verifierSocket)
    await retryPersistence.clearData()
    retryDoc.destroy()
    verifierDoc.destroy()
  })
})
