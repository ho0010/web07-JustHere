import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { io, type Socket } from 'socket.io-client'
import * as Y from 'yjs'
import { PrismaService } from '@/lib/prisma/prisma.service'
import { RedisIoAdapter } from '@/lib/socket/redis-io.adapter'
import { CanvasBroadcaster } from '@/modules/socket/canvas.broadcaster'
import { CanvasGateway } from '@/modules/canvas/canvas.gateway'
import { CanvasRepository } from '@/modules/canvas/canvas.repository'
import { CanvasService } from '@/modules/canvas/canvas.service'

interface TestRuntime {
  app: INestApplication
  adapter: RedisIoAdapter
  prisma: PrismaService
  repository: CanvasRepository
  socketBaseUrl: string
}

interface CanvasAttachedPayload {
  update?: number[]
  serverStateVector: number[]
}

interface YjsUpdatePayload {
  canvasId: string
  updateId: string
  update: number[]
}

interface YjsUpdateAck {
  canvasId: string
  updateId: string
  status: 'persisted' | 'duplicate'
}

const TEST_TIMEOUT_MS = 30_000
const EVENT_TIMEOUT_MS = 10_000

const startTestRuntime = async (): Promise<TestRuntime> => {
  const moduleFixture = await Test.createTestingModule({
    providers: [PrismaService, CanvasRepository, CanvasService, CanvasBroadcaster, CanvasGateway],
  }).compile()
  const app = moduleFixture.createNestApplication()
  const adapter = new RedisIoAdapter(app)

  try {
    await adapter.connectToRedis()
    app.useWebSocketAdapter(adapter)
    await app.listen(0, '127.0.0.1')
  } catch (error) {
    await adapter.disconnectFromRedis()
    await app.close()
    throw error
  }

  const address = (app.getHttpServer() as Server).address() as AddressInfo
  return {
    app,
    adapter,
    prisma: app.get(PrismaService),
    repository: app.get(CanvasRepository),
    socketBaseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const waitForSocketEvent = <T>(socket: Socket, event: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handleEvent)
      reject(new Error(`${event} 이벤트를 ${EVENT_TIMEOUT_MS}ms 안에 받지 못했습니다.`))
    }, EVENT_TIMEOUT_MS)
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

  await waitForSocketEvent(socket, 'connect')
  return socket
}

const attachCanvas = async (socket: Socket, roomId: string, canvasId: string, doc: Y.Doc) => {
  const attached = waitForSocketEvent<CanvasAttachedPayload>(socket, 'canvas:attached')
  socket.emit('canvas:attach', {
    roomId,
    canvasId,
    clientStateVector: Array.from(Y.encodeStateVector(doc)),
  })
  const response = await attached
  if (response.update?.length) Y.applyUpdate(doc, new Uint8Array(response.update))
  return response
}

const describeWithDependencies = process.env.REDIS_URL && process.env.DATABASE_URL ? describe : describe.skip

describeWithDependencies('Yjs distributed consistency (e2e)', () => {
  jest.setTimeout(TEST_TIMEOUT_MS)

  const runtimes: TestRuntime[] = []
  const sockets = new Set<Socket>()
  let roomId: string

  beforeAll(async () => {
    runtimes.push(await startTestRuntime())
    runtimes.push(await startTestRuntime())

    const room = await runtimes[0].prisma.room.create({
      data: {
        slug: `distributed-${crypto.randomUUID()}`,
        x: 127.027621,
        y: 37.497952,
        place_name: 'Yjs distributed consistency e2e',
      },
    })
    roomId = room.id
  })

  afterEach(() => {
    for (const socket of sockets) socket.disconnect()
    sockets.clear()
  })

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect()
    if (roomId && runtimes[0]) {
      await runtimes[0].prisma.room.deleteMany({ where: { id: roomId } })
    }
    await Promise.all(runtimes.map(runtime => runtime.app.close()))
    await Promise.all(runtimes.map(runtime => runtime.adapter.disconnectFromRedis()))
  })

  const createCategory = async (title: string) =>
    runtimes[0].prisma.category.create({
      data: {
        roomId,
        title,
        orderIndex: 0,
      },
    })

  it('Backend A에서 저장한 변경을 Backend B의 기존 room과 신규 접속 모두에서 확인해야 한다', async () => {
    const category = await createCategory('인스턴스 동기화')
    const clientA = await connectCanvasSocket(runtimes[0].socketBaseUrl)
    const clientB = await connectCanvasSocket(runtimes[1].socketBaseUrl)
    sockets.add(clientA)
    sockets.add(clientB)

    const docA = new Y.Doc()
    const docB = new Y.Doc()
    await attachCanvas(clientA, roomId, category.id, docA)
    await attachCanvas(clientB, roomId, category.id, docB)

    docA.getMap('fixture').set('from-backend-a', 'persisted-before-broadcast')
    const updateId = crypto.randomUUID()
    const payload: YjsUpdatePayload = {
      canvasId: category.id,
      updateId,
      update: Array.from(Y.encodeStateAsUpdate(docA)),
    }
    const ack = waitForSocketEvent<YjsUpdateAck>(clientA, 'y:update:ack')
    const remoteUpdate = waitForSocketEvent<YjsUpdatePayload>(clientB, 'y:update')
    clientA.emit('y:update', payload)

    await expect(ack).resolves.toEqual({ canvasId: category.id, updateId, status: 'persisted' })
    const broadcast = await remoteUpdate
    Y.applyUpdate(docB, new Uint8Array(broadcast.update))
    expect(docB.getMap('fixture').get('from-backend-a')).toBe('persisted-before-broadcast')

    // Backend B는 Redis broadcast를 클라이언트에 전달했을 뿐 서버 Y.Doc에는
    // 적용하지 않았다. 신규 접속은 DB refresh를 통해 같은 상태를 얻어야 한다.
    const clientC = await connectCanvasSocket(runtimes[1].socketBaseUrl)
    sockets.add(clientC)
    const docC = new Y.Doc()
    await attachCanvas(clientC, roomId, category.id, docC)
    expect(docC.getMap('fixture').get('from-backend-a')).toBe('persisted-before-broadcast')

    docA.destroy()
    docB.destroy()
    docC.destroy()
  })

  it('같은 update ID가 두 인스턴스에 동시에 도착해도 한 번만 저장해야 한다', async () => {
    const category = await createCategory('중복 저장 방지')
    const clientA = await connectCanvasSocket(runtimes[0].socketBaseUrl)
    const clientB = await connectCanvasSocket(runtimes[1].socketBaseUrl)
    sockets.add(clientA)
    sockets.add(clientB)

    await attachCanvas(clientA, roomId, category.id, new Y.Doc())
    await attachCanvas(clientB, roomId, category.id, new Y.Doc())

    const sourceDoc = new Y.Doc()
    sourceDoc.getMap('fixture').set('same-update', true)
    const updateId = crypto.randomUUID()
    const payload: YjsUpdatePayload = {
      canvasId: category.id,
      updateId,
      update: Array.from(Y.encodeStateAsUpdate(sourceDoc)),
    }
    const ackA = waitForSocketEvent<YjsUpdateAck>(clientA, 'y:update:ack')
    const ackB = waitForSocketEvent<YjsUpdateAck>(clientB, 'y:update:ack')
    clientA.emit('y:update', payload)
    clientB.emit('y:update', payload)

    const statuses = (await Promise.all([ackA, ackB])).map(ack => ack.status).sort()
    expect(statuses).toEqual(['duplicate', 'persisted'])
    expect(await runtimes[0].prisma.categoryUpdateReceipt.count({ where: { categoryId: category.id, updateId } })).toBe(1)
    expect(await runtimes[0].prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(1)

    sourceDoc.destroy()
  })

  it('두 인스턴스가 동시에 compaction해도 snapshot에 모든 변경을 보존해야 한다', async () => {
    const category = await createCategory('압축 동시성')
    const docA = new Y.Doc()
    docA.getMap('fixture').set('backend-a', true)
    const docB = new Y.Doc()
    docB.getMap('fixture').set('backend-b', true)

    await runtimes[0].repository.saveDurableUpdates(category.id, [{ updateId: crypto.randomUUID(), update: Y.encodeStateAsUpdate(docA) }])
    await runtimes[1].repository.saveDurableUpdates(category.id, [{ updateId: crypto.randomUUID(), update: Y.encodeStateAsUpdate(docB) }])

    await Promise.all([runtimes[0].repository.compactUpdateLogs(category.id, 1), runtimes[1].repository.compactUpdateLogs(category.id, 1)])

    const restoredDoc = new Y.Doc()
    Y.applyUpdate(restoredDoc, await runtimes[0].repository.getMergedUpdate(category.id))
    expect(restoredDoc.getMap('fixture').toJSON()).toEqual({ 'backend-a': true, 'backend-b': true })
    expect(await runtimes[0].prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(0)

    docA.destroy()
    docB.destroy()
    restoredDoc.destroy()
  })
})
