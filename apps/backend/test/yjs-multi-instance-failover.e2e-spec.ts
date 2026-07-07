import 'fake-indexeddb/auto'
import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createConnection, createServer, type Server as NetServer, type Socket as NetSocket } from 'node:net'
import { io, type Socket } from 'socket.io-client'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { PrismaService } from '@/lib/prisma/prisma.service'

interface ServerRuntime {
  child: ChildProcess
  port: number
  output: string[]
}

interface ChildMessage {
  type: 'ready' | 'update-buffered' | 'after-persist' | 'error'
  port?: number
  updateId?: string
  message?: string
}

interface CanvasAttachedPayload {
  update?: number[]
  serverStateVector: number[]
  durableAckSupported: boolean
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

const TEST_TIMEOUT_MS = 60_000
const EVENT_TIMEOUT_MS = 10_000
const OUTBOX_METADATA_KEY = 'durable-outbox:v1'
const SERVER_FIXTURE_PATH = join(__dirname, 'fixtures/yjs-failover-server.ts')

class FailoverTcpProxy {
  private readonly server: NetServer
  private readonly sockets = new Set<NetSocket>()
  private targetPort: number

  constructor(initialTargetPort: number) {
    this.targetPort = initialTargetPort
    this.server = createServer(client => {
      this.trackSocket(client)
      const upstream = createConnection({ port: this.targetPort, host: '127.0.0.1' })
      this.trackSocket(upstream)

      upstream.once('connect', () => {
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    })
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address() as { port: number }
    return `http://127.0.0.1:${address.port}`
  }

  routeTo(port: number) {
    this.targetPort = port
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private trackSocket(socket: NetSocket) {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }
}

const waitForChildMessage = (runtime: Pick<ServerRuntime, 'child' | 'output'>, type: ChildMessage['type'], updateId?: string) =>
  new Promise<ChildMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`${type} child message timeout\n${runtime.output.join('')}`))
    }, EVENT_TIMEOUT_MS)
    const handleMessage = (message: ChildMessage) => {
      if (message.type !== type || (updateId && message.updateId !== updateId)) return
      cleanup()
      resolve(message)
    }
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`server child exited before ${type}: code=${code}, signal=${signal}\n${runtime.output.join('')}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      runtime.child.off('message', handleMessage)
      runtime.child.off('exit', handleExit)
    }
    runtime.child.on('message', handleMessage)
    runtime.child.once('exit', handleExit)
  })

const startServer = async (options?: { failureMode?: 'none' | 'disconnect-after-persist'; flushIntervalMs?: number }) => {
  const output: string[] = []
  const child = fork(SERVER_FIXTURE_PATH, [], {
    cwd: join(__dirname, '..'),
    execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
    env: {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: 'true',
      YJS_FAILOVER_FAILURE_MODE: options?.failureMode ?? 'none',
      YJS_FLUSH_INTERVAL_MS: String(options?.flushIntervalMs ?? 100),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', chunk => output.push(String(chunk)))
  child.stderr?.on('data', chunk => output.push(String(chunk)))

  const startingRuntime = { child, output }
  const ready = await waitForChildMessage(startingRuntime, 'ready')
  if (!ready.port) throw new Error(`server child did not provide a port\n${output.join('')}`)
  return { child, output, port: ready.port } satisfies ServerRuntime
}

const stopServer = async (runtime: ServerRuntime | undefined, signal: NodeJS.Signals = 'SIGTERM') => {
  if (!runtime || runtime.child.exitCode !== null || runtime.child.signalCode !== null) return

  let didExit = false
  const exited = new Promise<void>(resolve =>
    runtime.child.once('exit', () => {
      didExit = true
      resolve()
    }),
  )
  runtime.child.kill(signal)
  if (signal === 'SIGKILL') {
    await exited
    return
  }

  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 5000))])
  if (!didExit) {
    runtime.child.kill('SIGKILL')
    await exited
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

const connectCanvasSocket = async (baseUrl: string): Promise<Socket> => {
  const socket = io(`${baseUrl}/canvas`, {
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
  if (response.update?.length) Y.applyUpdate(doc, new Uint8Array(response.update), socket)
  return response
}

const hasUpdateContent = (update: Uint8Array) => {
  const decoded = Y.decodeUpdate(update)
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0
}

const loadOutbox = async (persistence: IndexeddbPersistence): Promise<YjsUpdatePayload[]> => {
  const stored: unknown = await persistence.get(OUTBOX_METADATA_KEY)
  return typeof stored === 'string' ? (JSON.parse(stored) as YjsUpdatePayload[]) : []
}

const describeWithDependencies = process.env.REDIS_URL && process.env.DATABASE_URL ? describe : describe.skip

describeWithDependencies('Yjs multi-instance failover (e2e)', () => {
  jest.setTimeout(TEST_TIMEOUT_MS)

  const prisma = new PrismaService()
  const sockets = new Set<Socket>()
  const runtimes = new Set<ServerRuntime>()
  const proxies = new Set<FailoverTcpProxy>()
  let roomId: string

  beforeAll(async () => {
    await prisma.onModuleInit()
    const room = await prisma.room.create({
      data: {
        slug: `failover-${crypto.randomUUID()}`,
        x: 127.027621,
        y: 37.497952,
        place_name: 'Yjs multi-instance failover e2e',
      },
    })
    roomId = room.id
  })

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect()
    sockets.clear()
    await Promise.all([...proxies].map(proxy => proxy.close()))
    proxies.clear()
    await Promise.all([...runtimes].map(runtime => stopServer(runtime)))
    runtimes.clear()
  })

  afterAll(async () => {
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } })
    await prisma.onModuleDestroy()
  })

  const createCategory = (title: string) =>
    prisma.category.create({
      data: { roomId, title, orderIndex: 0 },
    })

  const startFailoverPair = async (options?: { failureMode?: 'none' | 'disconnect-after-persist'; flushIntervalMs?: number }) => {
    const backendA = await startServer(options)
    const backendB = await startServer()
    runtimes.add(backendA)
    runtimes.add(backendB)
    const proxy = new FailoverTcpProxy(backendA.port)
    proxies.add(proxy)
    const proxyUrl = await proxy.listen()
    return { backendA, backendB, proxy, proxyUrl }
  }

  it('DB 저장 전 Backend A가 강제 종료되면 Backend B에 누락 diff를 저장해야 한다', async () => {
    const category = await createCategory('저장 전 장애')
    const { backendA, backendB, proxy, proxyUrl } = await startFailoverPair({ flushIntervalMs: 60_000 })
    const databaseName = `justhere:yjs:failover:${category.id}:before-persist`

    const firstDoc = new Y.Doc()
    const firstPersistence = new IndexeddbPersistence(databaseName, firstDoc)
    await firstPersistence.whenSynced
    const firstSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(firstSocket)
    const attached = await attachCanvas(firstSocket, roomId, category.id, firstDoc)
    expect(attached.durableAckSupported).toBe(true)

    firstDoc.getMap('fixture').set('recovered-by', 'backend-b')
    const originalUpdateId = crypto.randomUUID()
    const originalPayload: YjsUpdatePayload = {
      canvasId: category.id,
      updateId: originalUpdateId,
      update: Array.from(Y.encodeStateAsUpdate(firstDoc, new Uint8Array(attached.serverStateVector))),
    }
    await firstPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([originalPayload]))

    const buffered = waitForChildMessage(backendA, 'update-buffered', originalUpdateId)
    firstSocket.emit('y:update', originalPayload)
    await buffered

    const disconnected = waitForSocketEvent(firstSocket, 'disconnect')
    proxy.routeTo(backendB.port)
    await stopServer(backendA, 'SIGKILL')
    runtimes.delete(backendA)
    await disconnected
    sockets.delete(firstSocket)

    expect(
      await prisma.categoryUpdateReceipt.findUnique({
        where: { categoryId_updateId: { categoryId: category.id, updateId: originalUpdateId } },
      }),
    ).toBeNull()

    await firstPersistence.destroy()
    firstDoc.destroy()

    const restoredDoc = new Y.Doc()
    const restoredPersistence = new IndexeddbPersistence(databaseName, restoredDoc)
    await restoredPersistence.whenSynced
    expect(await loadOutbox(restoredPersistence)).toEqual([originalPayload])

    const restoredSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(restoredSocket)
    const restoredAttached = await attachCanvas(restoredSocket, roomId, category.id, restoredDoc)
    const missingUpdate = Y.encodeStateAsUpdate(restoredDoc, new Uint8Array(restoredAttached.serverStateVector))
    expect(hasUpdateContent(missingUpdate)).toBe(true)

    // 실제 클라이언트 reconcile과 같이 이전 outbox를 누락 diff 하나로 교체한다.
    const retryPayload: YjsUpdatePayload = {
      canvasId: category.id,
      updateId: crypto.randomUUID(),
      update: Array.from(missingUpdate),
    }
    await restoredPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([retryPayload]))
    const ack = waitForSocketEvent<YjsUpdateAck>(restoredSocket, 'y:update:ack')
    restoredSocket.emit('y:update', retryPayload)
    await expect(ack).resolves.toEqual({ canvasId: category.id, updateId: retryPayload.updateId, status: 'persisted' })
    await restoredPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([]))

    expect(await loadOutbox(restoredPersistence)).toEqual([])
    expect(await prisma.categoryUpdateReceipt.count({ where: { categoryId: category.id } })).toBe(1)
    expect(
      await prisma.categoryUpdateReceipt.findUnique({
        where: { categoryId_updateId: { categoryId: category.id, updateId: retryPayload.updateId } },
      }),
    ).not.toBeNull()

    const verifierDoc = new Y.Doc()
    const verifierSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(verifierSocket)
    await attachCanvas(verifierSocket, roomId, category.id, verifierDoc)
    expect(verifierDoc.getMap('fixture').get('recovered-by')).toBe('backend-b')

    await restoredPersistence.clearData()
    await restoredPersistence.destroy()
    restoredDoc.destroy()
    verifierDoc.destroy()
  })

  it('DB 저장 후 ack 전에 Backend A가 종료되면 Backend B의 state vector로 outbox를 정리해야 한다', async () => {
    const category = await createCategory('ACK 유실 복구')
    const { backendA, backendB, proxy, proxyUrl } = await startFailoverPair({ failureMode: 'disconnect-after-persist' })
    const databaseName = `justhere:yjs:failover:${category.id}:after-persist`

    const firstDoc = new Y.Doc()
    const firstPersistence = new IndexeddbPersistence(databaseName, firstDoc)
    await firstPersistence.whenSynced
    const firstSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(firstSocket)
    const attached = await attachCanvas(firstSocket, roomId, category.id, firstDoc)

    firstDoc.getMap('fixture').set('persisted-by', 'backend-a')
    const updateId = crypto.randomUUID()
    const payload: YjsUpdatePayload = {
      canvasId: category.id,
      updateId,
      update: Array.from(Y.encodeStateAsUpdate(firstDoc, new Uint8Array(attached.serverStateVector))),
    }
    await firstPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([payload]))

    const afterPersist = waitForChildMessage(backendA, 'after-persist', updateId)
    const disconnected = waitForSocketEvent(firstSocket, 'disconnect')
    firstSocket.emit('y:update', payload)
    await afterPersist
    proxy.routeTo(backendB.port)
    await stopServer(backendA, 'SIGKILL')
    runtimes.delete(backendA)
    await disconnected
    sockets.delete(firstSocket)

    expect(
      await prisma.categoryUpdateReceipt.findUnique({
        where: { categoryId_updateId: { categoryId: category.id, updateId } },
      }),
    ).not.toBeNull()
    expect(await prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(1)

    await firstPersistence.destroy()
    firstDoc.destroy()

    const restoredDoc = new Y.Doc()
    const restoredPersistence = new IndexeddbPersistence(databaseName, restoredDoc)
    await restoredPersistence.whenSynced
    expect(await loadOutbox(restoredPersistence)).toEqual([payload])

    const restoredSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(restoredSocket)
    const restoredAttached = await attachCanvas(restoredSocket, roomId, category.id, restoredDoc)
    const missingUpdate = Y.encodeStateAsUpdate(restoredDoc, new Uint8Array(restoredAttached.serverStateVector))

    // 서버 DB에 이미 반영됐으므로 실제 reconcile은 outbox를 비우고 재전송하지 않는다.
    expect(hasUpdateContent(missingUpdate)).toBe(false)
    await restoredPersistence.set(OUTBOX_METADATA_KEY, JSON.stringify([]))
    expect(await loadOutbox(restoredPersistence)).toEqual([])
    expect(await prisma.categoryUpdateReceipt.count({ where: { categoryId: category.id } })).toBe(1)
    expect(await prisma.categoryUpdateLog.count({ where: { categoryId: category.id } })).toBe(1)

    const verifierDoc = new Y.Doc()
    const verifierSocket = await connectCanvasSocket(proxyUrl)
    sockets.add(verifierSocket)
    await attachCanvas(verifierSocket, roomId, category.id, verifierDoc)
    expect(verifierDoc.getMap('fixture').get('persisted-by')).toBe('backend-a')

    await restoredPersistence.clearData()
    await restoredPersistence.destroy()
    restoredDoc.destroy()
    verifierDoc.destroy()
  })
})
