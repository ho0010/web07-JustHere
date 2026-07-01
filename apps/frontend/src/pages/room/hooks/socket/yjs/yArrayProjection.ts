import { Array as YArray, Map as YMap } from 'yjs'

interface ProjectedItem {
  id: string
}

interface ProjectionEvent {
  target: unknown
}

export interface ProjectionResult {
  mode: 'full' | 'incremental' | 'noop'
  itemCount: number
}

interface YArrayProjectionOptions<T extends ProjectedItem> {
  source: YArray<YMap<unknown>>
  project: (source: YMap<unknown>) => T
  commit: (items: T[]) => void
}

export class YArrayProjection<T extends ProjectedItem> {
  private readonly source: YArray<YMap<unknown>>
  private readonly project: (source: YMap<unknown>) => T
  private readonly commit: (items: T[]) => void
  private items: T[] = []
  private indexById = new Map<string, number>()

  constructor({ source, project, commit }: YArrayProjectionOptions<T>) {
    this.source = source
    this.project = project
    this.commit = commit
  }

  rebuild(): ProjectionResult {
    const items = this.source.toArray().map(this.project)
    this.replaceItems(items)
    return { mode: 'full', itemCount: items.length }
  }

  applyEvents(events: ReadonlyArray<ProjectionEvent>): ProjectionResult {
    if (events.some(event => event.target === this.source)) {
      return this.rebuild()
    }

    const changedMaps = new Set<YMap<unknown>>()
    events.forEach(event => {
      if (event.target instanceof YMap) {
        changedMaps.add(event.target)
      }
    })

    if (changedMaps.size === 0) {
      return { mode: 'noop', itemCount: 0 }
    }

    const nextItems = [...this.items]
    for (const changedMap of changedMaps) {
      const id = changedMap.get('id') as string | undefined
      const index = id ? this.indexById.get(id) : undefined
      if (index == null) {
        return this.rebuild()
      }
      nextItems[index] = this.project(changedMap)
    }

    this.items = nextItems
    this.commit(nextItems)
    return { mode: 'incremental', itemCount: changedMaps.size }
  }

  private replaceItems(items: T[]) {
    this.items = items
    this.indexById = new Map(items.map((item, index) => [item.id, index]))
    this.commit(items)
  }
}
