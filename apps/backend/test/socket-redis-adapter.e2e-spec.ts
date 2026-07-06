import { Inject, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import { io, type Socket as ClientSocket } from 'socket.io-client'
import { RedisIoAdapter } from '@/lib/socket/redis-io.adapter'

interface JoinPayload {
  roomId: string
}

interface PublishPayload extends JoinPayload {
  value: string
}

const INSTANCE_ID = Symbol('INSTANCE_ID')

@WebSocketGateway({ namespace: '/redis-test', cors: { origin: '*' } })
class RedisAdapterTestGateway {
  @WebSocketServer()
  server: Server

  constructor(@Inject(INSTANCE_ID) private readonly instanceId: string) {}

  @SubscribeMessage('redis:test:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() payload: JoinPayload) {
    await client.join(`redis-test:${payload.roomId}`)
    client.emit('redis:test:joined', { instanceId: this.instanceId, roomId: payload.roomId })
  }

  @SubscribeMessage('redis:test:publish')
  publish(@MessageBody() payload: PublishPayload) {
    this.server.to(`redis-test:${payload.roomId}`).emit('redis:test:broadcast', {
      instanceId: this.instanceId,
      value: payload.value,
    })
  }
}

interface TestServer {
  app: INestApplication
  adapter: RedisIoAdapter
  url: string
}

const waitForEvent = <T>(socket: ClientSocket, event: string, timeoutMs = 5000) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handleEvent)
      reject(new Error(`Timed out waiting for ${event}`))
    }, timeoutMs)
    const handleEvent = (payload: T) => {
      clearTimeout(timeout)
      resolve(payload)
    }
    socket.once(event, handleEvent)
  })

const connectClient = (url: string) =>
  new Promise<ClientSocket>((resolve, reject) => {
    const socket = io(`${url}/redis-test`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    })
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', (error: Error) => {
      reject(new Error(`Failed to connect to ${url}/redis-test: ${error.message}`))
    })
  })

const describeWithRedis = process.env.REDIS_URL ? describe : describe.skip

describeWithRedis('Socket.IO Redis adapter multi-instance E2E', () => {
  const servers: TestServer[] = []
  const clients: ClientSocket[] = []

  const createServer = async (instanceId: string): Promise<TestServer> => {
    const module = await Test.createTestingModule({
      providers: [
        RedisAdapterTestGateway,
        {
          provide: INSTANCE_ID,
          useValue: instanceId,
        },
      ],
    }).compile()
    const app = module.createNestApplication()
    const adapter = new RedisIoAdapter(app)
    await adapter.connectToRedis()
    app.useWebSocketAdapter(adapter)
    await app.listen(0, '127.0.0.1')

    return { app, adapter, url: await app.getUrl() }
  }

  beforeAll(async () => {
    servers.push(await createServer('backend-a'))
    servers.push(await createServer('backend-b'))
  })

  afterAll(async () => {
    clients.forEach(client => client.disconnect())
    await Promise.all(servers.map(server => server.app.close()))
    await Promise.all(servers.map(server => server.adapter.disconnectFromRedis()))
  })

  it('서로 다른 NestJS 인스턴스의 같은 room으로 이벤트를 전달해야 한다', async () => {
    const clientA = await connectClient(servers[0].url)
    const clientB = await connectClient(servers[1].url)
    clients.push(clientA, clientB)

    const joinedA = waitForEvent<{ instanceId: string }>(clientA, 'redis:test:joined')
    clientA.emit('redis:test:join', { roomId: 'shared-room' })
    await expect(joinedA).resolves.toEqual(expect.objectContaining({ instanceId: 'backend-a' }))

    const joinedB = waitForEvent<{ instanceId: string }>(clientB, 'redis:test:joined')
    clientB.emit('redis:test:join', { roomId: 'shared-room' })
    await expect(joinedB).resolves.toEqual(expect.objectContaining({ instanceId: 'backend-b' }))

    const broadcast = waitForEvent<{ instanceId: string; value: string }>(clientB, 'redis:test:broadcast')
    clientA.emit('redis:test:publish', { roomId: 'shared-room', value: 'cross-instance' })

    await expect(broadcast).resolves.toEqual({
      instanceId: 'backend-a',
      value: 'cross-instance',
    })
  })
})
