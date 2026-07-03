// 백엔드 DTO와 동일한 구조로 타입 정의

export interface CanvasAttachPayload {
  roomId: string
  canvasId: string
  clientStateVector: number[]
}

export interface CanvasDetachPayload {
  canvasId: string
}

export interface YjsUpdatePayload {
  canvasId: string
  updateId: string
  update: number[]
}

export interface YjsUpdateAck {
  canvasId: string
  updateId: string
  status: 'persisted' | 'duplicate'
}

export interface CursorInfo {
  x: number
  y: number
  name: string
  chatActive?: boolean
  chatMessage?: string
}

export interface AwarenessState {
  cursor?: CursorInfo
}

export interface YjsAwarenessPayload {
  canvasId: string
  state: AwarenessState
}

// 서버에서 클라이언트로 전송되는 타입들

export interface CanvasAttachedPayload {
  docKey: string
  update?: number[]
  serverStateVector?: number[]
  durableAckSupported?: boolean
}

export interface YjsUpdateBroadcast {
  canvasId: string
  updateId?: string
  update: number[]
}

export interface YjsAwarenessBroadcast {
  socketId: string
  state: AwarenessState
}

export interface CursorInfoWithId extends CursorInfo {
  socketId: string
}
