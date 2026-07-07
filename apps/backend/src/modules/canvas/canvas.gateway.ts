import { UseFilters } from '@nestjs/common'
import { WebsocketExceptionsFilter } from '@/lib/filter'
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { CanvasService } from './canvas.service'
import { CanvasBroadcaster } from '@/modules/socket/canvas.broadcaster'
import { CanvasAttachPayload, CanvasDetachPayload, YjsUpdatePayload, YjsAwarenessPayload } from './dto/yjs.dto'
import { randomUUID } from 'node:crypto'

@WebSocketGateway({
  namespace: '/canvas',
  cors: { origin: '*' },
})
@UseFilters(new WebsocketExceptionsFilter('canvas'))
export class CanvasGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server

  constructor(
    private readonly canvasService: CanvasService,
    private readonly broadcaster: CanvasBroadcaster,
  ) {}

  afterInit(server: Server) {
    this.broadcaster.setServer(server)
  }

  handleDisconnect(client: Socket) {
    const canvasIds = this.canvasService.disconnectClient(client.id)

    // 참여 중이던 캔버스들에 커서 삭제 브로드캐스트
    for (const canvasId of canvasIds) {
      this.broadcaster.emitToCanvas(canvasId, 'y:awareness', {
        socketId: client.id,
        state: {},
      })
    }
  }

  /**
   * 클라이언트가 캔버스에 참여
   */
  @SubscribeMessage('canvas:attach')
  async onCanvasAttach(@ConnectedSocket() client: Socket, @MessageBody() payload: CanvasAttachPayload) {
    const { roomId, canvasId, clientStateVector } = payload
    const canvasRoom = `canvas:${canvasId}`

    // Snapshot 계산과 room join 사이에 발생한 update를 놓치지 않도록 먼저 room에 참여한다.
    await client.join(canvasRoom)

    try {
      const decodedClientStateVector = clientStateVector && clientStateVector.length > 0 ? new Uint8Array(clientStateVector) : undefined
      const response = await this.canvasService.initializeConnection(roomId, canvasId, client.id, decodedClientStateVector)

      client.emit('canvas:attached', response)
    } catch (error) {
      await client.leave(canvasRoom)
      throw error
    }
  }

  /**
   * 클라이언트가 캔버스에서 나감
   */
  @SubscribeMessage('canvas:detach')
  async onCanvasDetach(@ConnectedSocket() client: Socket, @MessageBody() payload: CanvasDetachPayload) {
    const { canvasId } = payload

    // 다른 클라이언트에게 커서 삭제 브로드캐스트
    this.broadcaster.emitToCanvas(canvasId, 'y:awareness', {
      socketId: client.id,
      state: {},
    })

    await client.leave(`canvas:${canvasId}`)
    this.canvasService.disconnectClient(client.id)

    client.emit('canvas:detached', {})
  }

  /**
   * Yjs 업데이트 수신 및 브로드캐스트
   */
  @SubscribeMessage('y:update')
  async onYjsUpdate(@ConnectedSocket() client: Socket, @MessageBody() payload: YjsUpdatePayload) {
    const { canvasId, update } = payload
    const updateId = payload.updateId ?? randomUUID()

    // number[] -> Uint8Array
    const updateArray = new Uint8Array(update)

    // 송신 클라이언트는 이미 로컬 Y.Doc에 적용했다. 서버는 DB 저장 완료 뒤에만
    // 다른 인스턴스로 방송해 신규 접속의 DB 상태와 실시간 이벤트 순서를 맞춘다.
    const processed = this.canvasService.processUpdate(canvasId, updateId, updateArray)
    const ack = await processed.persisted

    if (processed.shouldBroadcast && ack.status === 'persisted') {
      this.broadcaster.emitToCanvas(canvasId, 'y:update', { ...payload, updateId }, { exceptSocketId: client.id })
    }

    client.emit('y:update:ack', ack)
  }

  /**
   * Awareness 업데이트 (커서, 선택 상태 등)
   */
  @SubscribeMessage('y:awareness')
  onYjsAwareness(@ConnectedSocket() client: Socket, @MessageBody() payload: YjsAwarenessPayload) {
    const { canvasId, state } = payload

    // Awareness는 서버에 저장하지 않고 바로 브로드캐스트
    // TODO 메모리 캐시에 저장하여 뒤늦게 들어온 참여자도 정보를 바로 볼 수 있게해야함
    this.broadcaster.emitToCanvas(canvasId, 'y:awareness', { socketId: client.id, state }, { exceptSocketId: client.id })
  }
}
