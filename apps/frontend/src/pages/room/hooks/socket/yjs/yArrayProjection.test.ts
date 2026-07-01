import { describe, expect, it, vi } from 'vitest'
import { Doc as YDoc, Map as YMap } from 'yjs'
import { YArrayProjection, type ProjectionResult } from './yArrayProjection'

interface TestItem {
  id: string
  value: number
}

const createItem = (id: string, value: number) => {
  const item = new YMap<unknown>()
  item.set('id', id)
  item.set('value', value)
  return item
}

const projectItem = (item: YMap<unknown>): TestItem => ({
  id: item.get('id') as string,
  value: item.get('value') as number,
})

const setup = () => {
  const doc = new YDoc()
  const source = doc.getArray<YMap<unknown>>('items')
  const first = createItem('first', 1)
  const second = createItem('second', 2)
  source.push([first, second])
  const commit = vi.fn<(items: TestItem[]) => void>()
  const projection = new YArrayProjection({ source, project: projectItem, commit })
  projection.rebuild()
  commit.mockClear()
  return { doc, source, first, second, commit, projection }
}

describe('YArrayProjection', () => {
  it('한 transaction에서 변경된 객체만 다시 projection하고 나머지 참조를 유지한다', () => {
    const { doc, source, first, commit, projection } = setup()
    const before = projection.rebuild()
    const previousItems = commit.mock.lastCall?.[0]
    commit.mockClear()
    let result: ProjectionResult | null = null
    source.observeDeep(events => {
      result = projection.applyEvents(events)
    })

    doc.transact(() => {
      first.set('value', 10)
      first.set('another', 20)
    })

    const nextItems = commit.mock.lastCall?.[0]
    expect(before).toEqual({ mode: 'full', itemCount: 2 })
    expect(result).toEqual({ mode: 'incremental', itemCount: 1 })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(nextItems?.[0]).toEqual({ id: 'first', value: 10 })
    expect(nextItems?.[1]).toBe(previousItems?.[1])
  })

  it('여러 객체 변경도 transaction당 한 번만 commit한다', () => {
    const { doc, source, first, second, commit, projection } = setup()
    let result: ProjectionResult | null = null
    source.observeDeep(events => {
      result = projection.applyEvents(events)
    })

    doc.transact(() => {
      first.set('value', 10)
      second.set('value', 20)
    })

    expect(result).toEqual({ mode: 'incremental', itemCount: 2 })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.lastCall?.[0]).toEqual([
      { id: 'first', value: 10 },
      { id: 'second', value: 20 },
    ])
  })

  it('배열 추가와 삭제가 발생하면 전체 collection을 rebuild한다', () => {
    const { source, commit, projection } = setup()
    const results: ProjectionResult[] = []
    source.observeDeep(events => {
      results.push(projection.applyEvents(events))
    })

    source.push([createItem('third', 3)])
    source.delete(0, 1)

    expect(results).toEqual([
      { mode: 'full', itemCount: 3 },
      { mode: 'full', itemCount: 2 },
    ])
    expect(commit.mock.lastCall?.[0]).toEqual([
      { id: 'second', value: 2 },
      { id: 'third', value: 3 },
    ])
  })
})
