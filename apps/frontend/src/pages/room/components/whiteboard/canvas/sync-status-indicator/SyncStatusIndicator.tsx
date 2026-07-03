import { cn } from '@/shared/utils'
import type { YjsSyncStatus } from '@/pages/room/hooks/socket/yjs'

interface SyncStatusIndicatorProps {
  status: YjsSyncStatus
  pendingUpdateCount: number
}

const STATUS_CONFIG: Record<YjsSyncStatus, { label: string; description: string; dotClassName: string }> = {
  restoring: {
    label: '로컬 변경 복원 중',
    description: '이 브라우저에 저장된 캔버스 변경을 불러오고 있습니다.',
    dotClassName: 'bg-amber-400 animate-pulse',
  },
  connecting: {
    label: '서버 연결 중',
    description: '실시간 협업 서버에 연결하고 있습니다.',
    dotClassName: 'bg-amber-400 animate-pulse',
  },
  reconnecting: {
    label: '재연결 중 · 로컬 저장',
    description: '변경은 브라우저에 보관되며 연결이 복구되면 서버로 전송됩니다.',
    dotClassName: 'bg-amber-400 animate-pulse',
  },
  offline: {
    label: '오프라인 · 로컬 저장',
    description: '변경은 브라우저에 보관되며 서버 연결 후 동기화됩니다.',
    dotClassName: 'bg-slate-400',
  },
  syncing: {
    label: '서버에 저장 중',
    description: '서버 데이터베이스 저장 완료를 기다리고 있습니다.',
    dotClassName: 'bg-blue-500 animate-pulse',
  },
  saved: {
    label: '내 변경 저장됨',
    description: '내가 전송한 변경이 서버 데이터베이스에 저장되었습니다.',
    dotClassName: 'bg-emerald-500',
  },
  error: {
    label: '로컬 복구 저장 오류',
    description: '브라우저 저장소를 사용할 수 없습니다. 탭을 닫기 전에 연결 상태를 확인해 주세요.',
    dotClassName: 'bg-red-500',
  },
}

export const SyncStatusIndicator = ({ status, pendingUpdateCount }: SyncStatusIndicatorProps) => {
  const config = STATUS_CONFIG[status]
  const label = status === 'syncing' && pendingUpdateCount > 0 ? `${pendingUpdateCount}개 변경 저장 중` : config.label

  return (
    <div
      className="pointer-events-none absolute bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-700 shadow-md backdrop-blur"
      role="status"
      aria-live="polite"
      aria-label={`${label}. ${config.description}`}
      title={config.description}
    >
      <span className={cn('size-2 shrink-0 rounded-full', config.dotClassName)} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
