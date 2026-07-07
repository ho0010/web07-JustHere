import { Injectable, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'socket.io'
import { PrismaService } from '@/lib/prisma/prisma.service'
import { RedisIoAdapter } from '@/lib/socket/redis-io.adapter'
import { CanvasGateway } from '@/modules/canvas/canvas.gateway'
import { CanvasRepository } from '@/modules/canvas/canvas.repository'
import { CanvasService } from '@/modules/canvas/canvas.service'
import { CanvasBroadcaster } from '@/modules/socket/canvas.broadcaster'

type FailureMode = 'none' | 'disconnect-after-persist'

interface ChildMessage {
  type: 'ready' | 'update-buffered' | 'after-persist' | 'error'
  port?: number
  updateId?: string
  message?: string
}

const sendToParent = (message: ChildMessage) => {
  if (process.send) process.send(message)
}

@Injectable()
class ObservableCanvasService extends CanvasService {
  constructor(canvasRepository: CanvasRepository) {
    super(canvasRepository)
  }

  override processUpdate(categoryId: string, updateId: string, update: Uint8Array) {
    const processed = super.processUpdate(categoryId, updateId, update)
    sendToParent({ type: 'update-buffered', updateId })
    return processed
  }
}

@Injectable()
class FailpointCanvasBroadcaster {
  private server: Server | null = null
  private failureTriggered = false
  private readonly failureMode = (process.env.YJS_FAILOVER_FAILURE_MODE ?? 'none') as FailureMode

  setServer(server: Server) {
    this.server = server
  }

  emitToCanvas<T>(canvasId: string, event: string, payload: T, options?: { exceptSocketId?: string }) {
    if (!this.server) return

    const room = this.server.to(`canvas:${canvasId}`)
    if (options?.exceptSocketId) {
      room.except(options.exceptSocketId).emit(event, payload)
    } else {
      room.emit(event, payload)
    }

    if (this.failureMode !== 'disconnect-after-persist' || this.failureTriggered || event !== 'y:update' || !options?.exceptSocketId) return

    this.failureTriggered = true
    const updateId = this.getUpdateId(payload)
    sendToParent({ type: 'after-persist', updateId })

    // Gateway가 durable ack를 보내기 직전에 연결을 끊어 ack 유실을 재현한다.
    const sender = this.server.sockets.sockets.get(options.exceptSocketId)
    sender?.disconnect(true)
  }

  private getUpdateId(payload: unknown) {
    if (!payload || typeof payload !== 'object' || !('updateId' in payload)) return undefined
    const updateId = (payload as { updateId?: unknown }).updateId
    return typeof updateId === 'string' ? updateId : undefined
  }
}

let app: INestApplication | undefined
let adapter: RedisIoAdapter | undefined
let shuttingDown = false

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await app?.close()
  await adapter?.disconnectFromRedis()
  process.exit(0)
}

const bootstrap = async () => {
  const moduleFixture = await Test.createTestingModule({
    providers: [
      PrismaService,
      CanvasRepository,
      { provide: CanvasService, useClass: ObservableCanvasService },
      { provide: CanvasBroadcaster, useClass: FailpointCanvasBroadcaster },
      CanvasGateway,
    ],
  }).compile()

  app = moduleFixture.createNestApplication()
  adapter = new RedisIoAdapter(app)
  await adapter.connectToRedis()
  app.useWebSocketAdapter(adapter)
  await app.listen(0, '127.0.0.1')

  const httpServer = app.getHttpServer() as HttpServer
  const address = httpServer.address() as AddressInfo
  sendToParent({ type: 'ready', port: address.port })
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())

void bootstrap().catch(error => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  sendToParent({ type: 'error', message })
  process.exit(1)
})
