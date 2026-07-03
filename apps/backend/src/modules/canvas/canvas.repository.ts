import { Injectable } from '@nestjs/common'
import { PrismaService } from '@/lib/prisma/prisma.service'
import { Prisma } from '@prisma/client'
import * as Y from 'yjs'

export interface YjsCompactionResult {
  compacted: boolean
  compactedLogCount: number
  snapshotByteLength?: number
  lastLogId?: bigint
}

export interface DurableYjsUpdate {
  updateId: string
  update: Uint8Array
}

export type DurableYjsUpdateStatus = 'persisted' | 'duplicate'

@Injectable()
export class CanvasRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 초기 데이터 로드 (DB -> Merged Uint8Array)
   */
  async getMergedUpdate(categoryId: string): Promise<Uint8Array> {
    const [snapshot, logs] = await this.prisma.$transaction(
      [
        this.prisma.categorySnapshot.findUnique({
          where: { categoryId },
        }),
        this.prisma.categoryUpdateLog.findMany({
          where: { categoryId },
          orderBy: { id: 'asc' },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )

    const updates: Uint8Array[] = []
    if (snapshot) updates.push(new Uint8Array(snapshot.snapshotData))
    updates.push(...logs.map(log => new Uint8Array(log.updateData)))

    if (updates.length === 0) return new Uint8Array()
    return Y.mergeUpdates(updates)
  }

  /**
   * 여러 Yjs update를 하나의 로그로 병합해 저장하고 각 update ID의 receipt를 남긴다.
   * 이미 receipt가 존재하는 update는 다시 로그에 포함하지 않는다.
   */
  async saveDurableUpdates(categoryId: string, updates: DurableYjsUpdate[]): Promise<Map<string, DurableYjsUpdateStatus>> {
    return this.prisma.$transaction(
      async transaction => {
        const uniqueUpdates = [...new Map(updates.map(update => [update.updateId, update])).values()]
        const existingReceipts = await transaction.categoryUpdateReceipt.findMany({
          where: {
            categoryId,
            updateId: { in: uniqueUpdates.map(update => update.updateId) },
          },
          select: { updateId: true },
        })
        const existingIds = new Set(existingReceipts.map(receipt => receipt.updateId))
        const newUpdates = uniqueUpdates.filter(update => !existingIds.has(update.updateId))

        if (newUpdates.length > 0) {
          const mergedUpdate = Y.mergeUpdates(newUpdates.map(update => update.update))
          await transaction.categoryUpdateLog.create({
            data: {
              categoryId,
              updateData: Buffer.from(mergedUpdate),
            },
          })
          await transaction.categoryUpdateReceipt.createMany({
            data: newUpdates.map(update => ({
              categoryId,
              updateId: update.updateId,
            })),
          })
        }

        return new Map(
          uniqueUpdates.map(update => [update.updateId, existingIds.has(update.updateId) ? ('duplicate' as const) : ('persisted' as const)]),
        )
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }

  /**
   * 일정 개수 이상 누적된 update log를 하나의 복원 가능한 snapshot으로 압축한다.
   *
   * 조회 이후 새 로그가 저장되더라도 유실되지 않도록 조회한 로그 ID만 삭제한다.
   * snapshot upsert와 로그 삭제는 하나의 transaction으로 처리한다.
   */
  async compactUpdateLogs(categoryId: string, threshold: number): Promise<YjsCompactionResult> {
    return this.prisma.$transaction(
      async transaction => {
        const logs = await transaction.categoryUpdateLog.findMany({
          where: { categoryId },
          orderBy: { id: 'asc' },
          take: threshold,
        })

        if (logs.length < threshold) {
          return { compacted: false, compactedLogCount: 0 }
        }

        const snapshot = await transaction.categorySnapshot.findUnique({
          where: { categoryId },
        })
        const updates = [...(snapshot ? [new Uint8Array(snapshot.snapshotData)] : []), ...logs.map(log => new Uint8Array(log.updateData))]
        const snapshotData = Y.mergeUpdates(updates)
        const compactedLogIds = logs.map(log => log.id)
        const lastLogId = logs[logs.length - 1].id

        await transaction.categorySnapshot.upsert({
          where: { categoryId },
          create: {
            categoryId,
            snapshotData: Buffer.from(snapshotData),
            lastLogId,
          },
          update: {
            snapshotData: Buffer.from(snapshotData),
            lastLogId,
          },
        })
        await transaction.categoryUpdateLog.deleteMany({
          where: {
            categoryId,
            id: { in: compactedLogIds },
          },
        })

        return {
          compacted: true,
          compactedLogCount: logs.length,
          snapshotByteLength: snapshotData.byteLength,
          lastLogId,
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
  }
}
