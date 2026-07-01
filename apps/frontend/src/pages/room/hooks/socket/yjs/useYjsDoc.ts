import { useEffect, useRef, useState } from 'react'
import { Doc as YDoc, Map as YMap } from 'yjs'
import type { Line, PlaceCard, PostIt, TextBox } from '@/shared/types'
import { CANVAS_ITEM_TYPE, YJS_TYPE } from '@/shared/types'
import { PLACE_CARD_HEIGHT, PLACE_CARD_WIDTH } from '@/pages/room/constants'
import { measureCanvasPerformance, recordCanvasPerformanceProjection } from '@/pages/room/perf'
import { resolveZIndexState } from '@/pages/room/utils'
import type { YjsItemType, YjsRank, YjsSharedTypes } from '@/pages/room/types'
import { YArrayProjection, type ProjectionResult } from './yArrayProjection'

interface UseYjsDocProps {
  roomId: string
  canvasId: string
}

const projectPostIt = (yMap: YMap<unknown>): PostIt => ({
  id: yMap.get('id') as string,
  x: yMap.get('x') as number,
  y: yMap.get('y') as number,
  width: yMap.get('width') as number,
  height: yMap.get('height') as number,
  scale: yMap.get('scale') as number,
  fill: yMap.get('fill') as string,
  text: yMap.get('text') as string,
  authorName: yMap.get('authorName') as string,
})

const projectPlaceCard = (yMap: YMap<unknown>): PlaceCard => ({
  id: yMap.get('id') as string,
  placeId: yMap.get('placeId') as string,
  name: yMap.get('name') as string,
  address: yMap.get('address') as string,
  x: yMap.get('x') as number,
  y: yMap.get('y') as number,
  width: (yMap.get('width') as number | undefined) ?? PLACE_CARD_WIDTH,
  height: (yMap.get('height') as number | undefined) ?? PLACE_CARD_HEIGHT,
  scale: yMap.get('scale') as number,
  createdAt: yMap.get('createdAt') as string,
  image: (yMap.get('image') as string | null | undefined) ?? null,
  category: (yMap.get('category') as string | undefined) ?? '',
  rating: yMap.get('rating') as number | undefined,
  userRatingCount: yMap.get('userRatingCount') as number | undefined,
})

const projectLine = (yMap: YMap<unknown>): Line => ({
  id: yMap.get('id') as string,
  points: (yMap.get('points') as number[]) || [],
  stroke: yMap.get('stroke') as string,
  strokeWidth: yMap.get('strokeWidth') as number,
  tension: yMap.get('tension') as number,
  lineCap: yMap.get('lineCap') as 'round' | 'butt' | 'square',
  lineJoin: yMap.get('lineJoin') as 'round' | 'bevel' | 'miter',
  tool: yMap.get('tool') as 'pen',
})

const projectTextBox = (yMap: YMap<unknown>): TextBox => ({
  id: yMap.get('id') as string,
  x: yMap.get('x') as number,
  y: yMap.get('y') as number,
  width: yMap.get('width') as number,
  height: yMap.get('height') as number,
  scale: yMap.get('scale') as number,
  text: yMap.get('text') as string,
  authorName: yMap.get('authorName') as string,
})

const recordProjectionResult = (result: ProjectionResult) => {
  if (result.mode !== 'noop') {
    recordCanvasPerformanceProjection(result.mode, result.itemCount)
  }
}

export const useYjsDoc = ({ roomId, canvasId }: UseYjsDocProps) => {
  const docRef = useRef<YDoc | null>(null)
  const localOriginRef = useRef(Symbol('canvas-local'))
  const localMaxTimestampRef = useRef(0)
  const [sharedTypes, setSharedTypes] = useState<YjsSharedTypes | null>(null)

  const [postits, setPostits] = useState<PostIt[]>([])
  const [placeCards, setPlaceCards] = useState<PlaceCard[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([])
  const [zIndexOrder, setZIndexOrder] = useState<Array<YjsItemType>>([])

  useEffect(() => {
    const doc = new YDoc()
    docRef.current = doc
    localMaxTimestampRef.current = 0

    const yPostits = doc.getArray<YMap<unknown>>(YJS_TYPE[CANVAS_ITEM_TYPE.POST_IT])
    const yPlaceCards = doc.getArray<YMap<unknown>>(YJS_TYPE[CANVAS_ITEM_TYPE.PLACE_CARD])
    const yLines = doc.getArray<YMap<unknown>>(YJS_TYPE[CANVAS_ITEM_TYPE.LINE])
    const yTextBoxes = doc.getArray<YMap<unknown>>(YJS_TYPE[CANVAS_ITEM_TYPE.TEXT_BOX])
    const yZRankByKey = doc.getMap<YjsRank>(YJS_TYPE.Z_RANK_BY_KEY)

    const nextSharedTypes: YjsSharedTypes = {
      yPostits,
      yPlaceCards,
      yLines,
      yTextBoxes,
      yZRankByKey,
    }
    setSharedTypes(nextSharedTypes)

    const postitProjection = new YArrayProjection({ source: yPostits, project: projectPostIt, commit: setPostits })
    const placeCardProjection = new YArrayProjection({ source: yPlaceCards, project: projectPlaceCard, commit: setPlaceCards })
    const lineProjection = new YArrayProjection({ source: yLines, project: projectLine, commit: setLines })
    const textBoxProjection = new YArrayProjection({ source: yTextBoxes, project: projectTextBox, commit: setTextBoxes })

    const syncPostitsToState = (events?: ReadonlyArray<{ target: unknown }>) => {
      measureCanvasPerformance('projectPostits', () => {
        recordProjectionResult(events ? postitProjection.applyEvents(events) : postitProjection.rebuild())
      })
    }

    const syncPlaceCardsToState = (events?: ReadonlyArray<{ target: unknown }>) => {
      measureCanvasPerformance('projectPlaceCards', () => {
        recordProjectionResult(events ? placeCardProjection.applyEvents(events) : placeCardProjection.rebuild())
      })
    }

    const syncLinesToState = (events?: ReadonlyArray<{ target: unknown }>) => {
      measureCanvasPerformance('projectLines', () => {
        recordProjectionResult(events ? lineProjection.applyEvents(events) : lineProjection.rebuild())
      })
    }

    const syncTextBoxesToState = (events?: ReadonlyArray<{ target: unknown }>) => {
      measureCanvasPerformance('projectTextBoxes', () => {
        recordProjectionResult(events ? textBoxProjection.applyEvents(events) : textBoxProjection.rebuild())
      })
    }

    const syncZIndexOrderToState = () => {
      measureCanvasPerformance('projectZIndex', () => {
        const { items, maxTimestamp } = resolveZIndexState(yZRankByKey, localMaxTimestampRef.current)
        localMaxTimestampRef.current = maxTimestamp
        setZIndexOrder(items)
      })
    }

    yPostits.observeDeep(syncPostitsToState)
    yPlaceCards.observeDeep(syncPlaceCardsToState)
    yLines.observeDeep(syncLinesToState)
    yTextBoxes.observeDeep(syncTextBoxesToState)
    yZRankByKey.observe(syncZIndexOrderToState)

    syncPostitsToState()
    syncPlaceCardsToState()
    syncLinesToState()
    syncTextBoxesToState()
    syncZIndexOrderToState()

    return () => {
      yPostits.unobserveDeep(syncPostitsToState)
      yPlaceCards.unobserveDeep(syncPlaceCardsToState)
      yLines.unobserveDeep(syncLinesToState)
      yTextBoxes.unobserveDeep(syncTextBoxesToState)
      yZRankByKey.unobserve(syncZIndexOrderToState)
      setSharedTypes(null)
      localMaxTimestampRef.current = 0
      doc.destroy()
      docRef.current = null
    }
  }, [roomId, canvasId])

  return {
    docRef,
    localOriginRef,
    localMaxTimestampRef,
    sharedTypes,
    postits,
    placeCards,
    lines,
    textBoxes,
    zIndexOrder,
  }
}
