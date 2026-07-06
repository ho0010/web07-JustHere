import { Logger } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { Server, ServerOptions } from 'socket.io'

type RedisAdapterConstructor = ReturnType<typeof createAdapter>
interface ManagedRedisClient {
  readonly isOpen: boolean
  quit(): Promise<unknown>
}

const redisReconnectStrategy = (retries: number) => {
  if (retries >= 5) return false
  return Math.min(100 * 2 ** retries, 1000)
}

/**
 * Socket.IO room을 여러 NestJS 인스턴스가 공유하도록 Redis adapter를 연결한다.
 *
 * REDIS_URL이 없으면 기존 in-memory adapter를 유지해 단일 서버 개발과 단위
 * 테스트가 Redis에 의존하지 않도록 한다. 반대로 REDIS_URL이 설정된 환경에서
 * 연결에 실패하면 시작을 중단한다. Redis 없이 여러 서버를 띄우면 room 전달을
 * 보장할 수 없기 때문이다.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name)
  private pubClient?: ManagedRedisClient
  private subClient?: ManagedRedisClient
  private adapterConstructor?: RedisAdapterConstructor
  private disconnectPromise?: Promise<void>
  private readonly serverClosePromises = new WeakMap<Server, Promise<void>>()

  constructor(app: INestApplicationContext) {
    super(app)
  }

  async connectToRedis(redisUrl = process.env.REDIS_URL): Promise<boolean> {
    if (!redisUrl) {
      this.logger.log('REDIS_URL is not configured; using the in-memory Socket.IO adapter')
      return false
    }

    const pubClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: redisReconnectStrategy,
      },
    })
    const subClient = pubClient.duplicate()

    pubClient.on('error', error => this.logger.error('Socket.IO Redis publisher error', error))
    subClient.on('error', error => this.logger.error('Socket.IO Redis subscriber error', error))

    try {
      await Promise.all([pubClient.connect(), subClient.connect()])
    } catch (error) {
      await Promise.allSettled([this.closeClient(pubClient), this.closeClient(subClient)])
      throw error
    }

    this.pubClient = pubClient
    this.subClient = subClient
    this.adapterConstructor = createAdapter(pubClient, subClient)
    this.logger.log('Socket.IO Redis adapter connected')
    return true
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as unknown as Server
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor)
    }
    return server
  }

  close(server: Server): Promise<void> {
    const existing = this.serverClosePromises.get(server)
    if (existing) return existing

    const closePromise = (async () => {
      await super.close(server)
      await this.disconnectFromRedis()
    })()
    this.serverClosePromises.set(server, closePromise)
    return closePromise
  }

  disconnectFromRedis(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise

    const clients = [this.pubClient, this.subClient].filter((client): client is ManagedRedisClient => Boolean(client))
    this.pubClient = undefined
    this.subClient = undefined
    this.adapterConstructor = undefined

    this.disconnectPromise = Promise.allSettled(clients.map(client => this.closeClient(client)))
      .then(() => undefined)
      .finally(() => {
        this.disconnectPromise = undefined
      })
    return this.disconnectPromise
  }

  private async closeClient(client: ManagedRedisClient) {
    if (client.isOpen) {
      await client.quit()
    }
  }
}
