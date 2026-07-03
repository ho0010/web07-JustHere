export type YjsSyncStatus = 'restoring' | 'connecting' | 'reconnecting' | 'offline' | 'syncing' | 'saved' | 'error'

interface ResolveYjsSyncStatusOptions {
  persistenceReady: boolean
  socketStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  syncReady: boolean
  pendingUpdateCount: number
  hasPersistenceError: boolean
}

export const resolveYjsSyncStatus = ({
  persistenceReady,
  socketStatus,
  syncReady,
  pendingUpdateCount,
  hasPersistenceError,
}: ResolveYjsSyncStatusOptions): YjsSyncStatus => {
  if (hasPersistenceError) return 'error'
  if (!persistenceReady) return 'restoring'
  if (socketStatus === 'reconnecting') return 'reconnecting'
  if (socketStatus === 'connecting') return 'connecting'
  if (socketStatus === 'disconnected') return 'offline'
  if (!syncReady || pendingUpdateCount > 0) return 'syncing'
  return 'saved'
}
