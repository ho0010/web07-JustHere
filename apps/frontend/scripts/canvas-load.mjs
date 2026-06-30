import { io } from 'socket.io-client'
import * as Y from 'yjs'

const EVENTS = {
  attach: 'canvas:attach',
  attached: 'canvas:attached',
  detach: 'canvas:detach',
  update: 'y:update',
  awareness: 'y:awareness',
}

const PROFILES = {
  small: { postits: 50, placeCards: 20, lines: 30, textBoxes: 10, pointsPerLine: 40 },
  medium: { postits: 250, placeCards: 100, lines: 100, textBoxes: 50, pointsPerLine: 120 },
  large: { postits: 600, placeCards: 200, lines: 200, textBoxes: 100, pointsPerLine: 240 },
}

const SCENARIOS = new Set(['seed', 'cursor', 'move', 'draw', 'mixed'])

const HELP = `
캔버스 로컬 부하 재현 도구

사용법:
  pnpm --filter frontend perf:canvas:load -- --room-id <uuid> --canvas-id <uuid> [옵션]

필수 옵션:
  --room-id <uuid>          존재하는 방 ID
  --canvas-id <uuid>        존재하는 카테고리(캔버스) ID

선택 옵션:
  --server-url <url>        백엔드 주소 (기본값: http://localhost:3000)
  --scenario <name>         seed|cursor|move|draw|mixed (기본값: mixed)
  --profile <name>          small|medium|large (기본값: medium)
  --clients <number>        가상 사용자 수 (기본값: 20)
  --duration <seconds>      부하 지속 시간 (기본값: 30)
  --cursor-hz <number>      사용자별 커서 전송 빈도 (기본값: 10)
  --update-hz <number>      사용자별 문서 변경 빈도 (기본값: 5)
  --points-per-line <n>     draw 시 라인 하나의 좌표 쌍 수 (기본값: profile 값)
  --seed <number>           고정 난수 seed (기본값: 20260630)
  --help                    도움말 출력

예시:
  pnpm --filter frontend perf:canvas:load -- --room-id ROOM --canvas-id CANVAS --scenario seed --profile medium
  pnpm --filter frontend perf:canvas:load -- --room-id ROOM --canvas-id CANVAS --scenario mixed --clients 30 --duration 60
`

const DEFAULTS = {
  serverUrl: 'http://localhost:3000',
  scenario: 'mixed',
  profile: 'medium',
  clients: 20,
  duration: 30,
  cursorHz: 10,
  updateHz: 5,
  seed: 20260630,
}

const OPTION_NAMES = {
  '--server-url': 'serverUrl',
  '--room-id': 'roomId',
  '--canvas-id': 'canvasId',
  '--scenario': 'scenario',
  '--profile': 'profile',
  '--clients': 'clients',
  '--duration': 'duration',
  '--cursor-hz': 'cursorHz',
  '--update-hz': 'updateHz',
  '--points-per-line': 'pointsPerLine',
  '--seed': 'seed',
}

const NUMERIC_OPTIONS = new Set(['clients', 'duration', 'cursorHz', 'updateHz', 'pointsPerLine', 'seed'])

function parseArgs(argv) {
  argv = argv.filter(argument => argument !== '--')
  if (argv.includes('--help')) {
    console.log(HELP.trim())
    process.exit(0)
  }

  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 2) {
    const rawName = argv[index]
    const name = OPTION_NAMES[rawName]
    const rawValue = argv[index + 1]
    if (!name || rawValue == null || rawValue.startsWith('--')) {
      throw new Error(`알 수 없거나 값이 빠진 옵션입니다: ${rawName ?? '(없음)'}`)
    }
    options[name] = NUMERIC_OPTIONS.has(name) ? Number(rawValue) : rawValue
  }

  if (!options.roomId || !options.canvasId) throw new Error('--room-id와 --canvas-id는 필수입니다.')
  if (!SCENARIOS.has(options.scenario)) throw new Error(`지원하지 않는 scenario입니다: ${options.scenario}`)
  if (!PROFILES[options.profile]) throw new Error(`지원하지 않는 profile입니다: ${options.profile}`)
  for (const key of NUMERIC_OPTIONS) {
    if (options[key] != null && (!Number.isFinite(options[key]) || options[key] <= 0)) {
      throw new Error(`${key}는 0보다 큰 숫자여야 합니다.`)
    }
  }
  options.serverUrl = options.serverUrl.replace(/\/$/, '')
  options.pointsPerLine ??= PROFILES[options.profile].pointsPerLine
  return options
}

function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const intervalMs = hz => Math.max(1, Math.round(1000 / hz))
const fixturePrefix = options => `perf-${options.seed}-${options.profile}`

function createMap(values) {
  const map = new Y.Map()
  for (const [key, value] of Object.entries(values)) map.set(key, value)
  return map
}

function createLinePoints(index, pointPairs) {
  const points = []
  const originX = (index % 20) * 360
  const originY = Math.floor(index / 20) * 220
  for (let point = 0; point < pointPairs; point += 1) {
    points.push(originX + point * 3, originY + Math.sin((point + index) / 6) * 50)
  }
  return points
}

function createFixtureDefinitions(options) {
  const profile = PROFILES[options.profile]
  const prefix = fixturePrefix(options)
  const random = createRandom(options.seed)
  const colors = ['#FEF3C7', '#DBEAFE', '#DCFCE7', '#FCE7F3']
  const definitions = {
    postits: [],
    placeCards: [],
    lines: [],
    textBoxes: [],
  }

  for (let index = 0; index < profile.postits; index += 1) {
    definitions.postits.push({
      type: 'postit',
      values: {
        id: `${prefix}-postit-${index}`,
        x: Math.round(random() * 7000),
        y: Math.round(random() * 4500),
        width: 150,
        height: 150,
        scale: 1,
        fill: colors[index % colors.length],
        text: `성능 fixture 포스트잇 ${index}`,
        authorName: 'canvas-load',
      },
    })
  }

  for (let index = 0; index < profile.placeCards; index += 1) {
    definitions.placeCards.push({
      type: 'placeCard',
      values: {
        id: `${prefix}-place-card-${index}`,
        placeId: `${prefix}-place-${index}`,
        name: `성능 fixture 장소 ${index}`,
        address: `서울시 테스트로 ${index}`,
        x: Math.round(random() * 7000),
        y: Math.round(random() * 4500),
        width: 240,
        height: 220,
        scale: 1,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
        image: null,
        category: 'fixture',
        rating: 4.5,
        userRatingCount: 100 + index,
      },
    })
  }

  for (let index = 0; index < profile.lines; index += 1) {
    definitions.lines.push({
      type: 'line',
      values: {
        id: `${prefix}-line-${index}`,
        points: createLinePoints(index, profile.pointsPerLine),
        stroke: '#0F172A',
        strokeWidth: 2,
        tension: 0.5,
        lineCap: 'round',
        lineJoin: 'round',
        tool: 'pen',
      },
    })
  }

  for (let index = 0; index < profile.textBoxes; index += 1) {
    definitions.textBoxes.push({
      type: 'textBox',
      values: {
        id: `${prefix}-text-box-${index}`,
        x: Math.round(random() * 7000),
        y: Math.round(random() * 4500),
        width: 200,
        height: 50,
        scale: 1,
        text: `성능 fixture 텍스트 ${index}`,
        authorName: 'canvas-load',
      },
    })
  }

  return definitions
}

async function seedFixture(doc, options) {
  const markerKey = fixturePrefix(options)
  const markers = doc.getMap('perfFixtureMarkers')
  if (markers.has(markerKey)) return { inserted: 0, skipped: true }

  const definitions = createFixtureDefinitions(options)
  const zRankByKey = doc.getMap('zRankByKey')
  let rank = zRankByKey.size
  let inserted = 0

  for (const [arrayName, items] of Object.entries(definitions)) {
    const array = doc.getArray(arrayName)
    const existingIds = new Set(array.toArray().map(item => item.get('id')))
    const missingItems = items.filter(item => !existingIds.has(item.values.id))

    for (let offset = 0; offset < missingItems.length; offset += 25) {
      const batch = missingItems.slice(offset, offset + 25)
      doc.transact(() => {
        const maps = batch.map(item => {
          rank += 1
          zRankByKey.set(`${item.type}:${item.values.id}`, { timestamp: rank, clientId: 'canvas-load' })
          return createMap(item.values)
        })
        array.push(maps)
      }, 'fixture-seed')
      inserted += batch.length
      await delay(15)
    }
  }

  doc.transact(() => {
    markers.set(markerKey, { inserted, createdAt: new Date().toISOString() })
  }, 'fixture-seed')
  return { inserted, skipped: false }
}

function createStats(options) {
  return {
    scenario: options.scenario,
    profile: options.profile,
    clients: options.scenario === 'seed' ? 1 : options.clients,
    durationSeconds: options.scenario === 'seed' ? 0 : options.duration,
    sent: { updates: 0, binaryBytes: 0, serializedBytes: 0, awareness: 0 },
    received: { updates: 0, binaryBytes: 0, awareness: 0 },
    attach: { totalMs: 0, maxMs: 0, initialBinaryBytes: 0 },
  }
}

async function connectClient(index, options, stats) {
  const socket = io(`${options.serverUrl}/canvas`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 10_000,
  })
  const doc = new Y.Doc()

  doc.on('update', (update, origin) => {
    if (origin === socket) return
    const payload = { canvasId: options.canvasId, update: Array.from(update) }
    stats.sent.updates += 1
    stats.sent.binaryBytes += update.byteLength
    stats.sent.serializedBytes += Buffer.byteLength(JSON.stringify(payload))
    socket.emit(EVENTS.update, payload)
  })

  socket.on(EVENTS.update, payload => {
    const update = new Uint8Array(payload.update)
    stats.received.updates += 1
    stats.received.binaryBytes += update.byteLength
    Y.applyUpdate(doc, update, socket)
  })
  socket.on(EVENTS.awareness, () => {
    stats.received.awareness += 1
  })

  const attachStartedAt = performance.now()
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`가상 사용자 ${index}의 초기 동기화가 10초 안에 끝나지 않았습니다.`)), 10_000)
    const finish = callback => value => {
      clearTimeout(timeout)
      socket.off('connect_error', handleError)
      callback(value)
    }
    const handleError = finish(error => reject(error))

    socket.once('connect_error', handleError)
    socket.once(EVENTS.attached, ({ update }) => {
      const updateArray = new Uint8Array(update ?? [])
      stats.attach.initialBinaryBytes += updateArray.byteLength
      Y.applyUpdate(doc, updateArray, socket)
      finish(resolve)()
    })
    socket.on('connect', () => {
      socket.emit(EVENTS.attach, { roomId: options.roomId, canvasId: options.canvasId })
    })
  })

  const attachMs = performance.now() - attachStartedAt
  stats.attach.totalMs += attachMs
  stats.attach.maxMs = Math.max(stats.attach.maxMs, attachMs)
  return { index, socket, doc, timers: [] }
}

function startCursorScenario(client, options, stats, random) {
  const timer = setInterval(() => {
    client.socket.emit(EVENTS.awareness, {
      canvasId: options.canvasId,
      state: {
        cursor: {
          x: Math.round(random() * 7000),
          y: Math.round(random() * 4500),
          name: `virtual-user-${client.index}`,
          chatActive: false,
          chatMessage: '',
        },
      },
    })
    stats.sent.awareness += 1
  }, intervalMs(options.cursorHz))
  client.timers.push(timer)
}

function startMoveScenario(client, options, random) {
  const collections = ['postits', 'placeCards', 'textBoxes'].map(name => client.doc.getArray(name))
  const timer = setInterval(() => {
    const available = collections.filter(array => array.length > 0)
    if (available.length === 0) return
    const array = available[Math.floor(random() * available.length)]
    const item = array.get(Math.floor(random() * array.length))
    client.doc.transact(() => {
      item.set('x', Number(item.get('x') ?? 0) + Math.round(random() * 12 - 6))
      item.set('y', Number(item.get('y') ?? 0) + Math.round(random() * 12 - 6))
    }, 'load-move')
  }, intervalMs(options.updateHz))
  client.timers.push(timer)
}

function startDrawScenario(client, options) {
  const lines = client.doc.getArray('lines')
  const zRankByKey = client.doc.getMap('zRankByKey')
  const runId = Date.now().toString(36)
  let lineSequence = 0
  let pointSequence = 0
  let activeLine = null

  const timer = setInterval(() => {
    if (!activeLine || pointSequence >= options.pointsPerLine) {
      pointSequence = 0
      const id = `perf-live-${options.seed}-${runId}-${client.index}-${lineSequence}`
      lineSequence += 1
      activeLine = createMap({
        id,
        points: [],
        stroke: '#DC2626',
        strokeWidth: 2,
        tension: 0.5,
        lineCap: 'round',
        lineJoin: 'round',
        tool: 'pen',
      })
      client.doc.transact(() => {
        lines.push([activeLine])
        zRankByKey.set(`line:${id}`, { timestamp: Date.now() + lineSequence, clientId: `load-${client.index}` })
      }, 'load-draw')
    }

    const points = activeLine.get('points') ?? []
    activeLine.set('points', [...points, pointSequence * 4, client.index * 80 + Math.sin(pointSequence / 5) * 40])
    pointSequence += 1
  }, intervalMs(options.updateHz))
  client.timers.push(timer)
}

function startScenario(clients, options, stats) {
  clients.forEach(client => {
    const random = createRandom(options.seed + client.index + 1)
    if (options.scenario === 'cursor' || options.scenario === 'mixed') startCursorScenario(client, options, stats, random)
    if (options.scenario === 'move' || options.scenario === 'mixed') startMoveScenario(client, options, random)
    if (options.scenario === 'draw' || options.scenario === 'mixed') startDrawScenario(client, options)
  })
}

async function closeClients(clients, options) {
  for (const client of clients) {
    client.timers.forEach(timer => clearInterval(timer))
    if (client.socket.connected) {
      client.socket.emit(EVENTS.awareness, { canvasId: options.canvasId, state: {} })
      client.socket.emit(EVENTS.detach, { canvasId: options.canvasId })
    }
  }
  await delay(100)
  clients.forEach(client => {
    client.socket.disconnect()
    client.doc.destroy()
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const stats = createStats(options)
  const clients = []
  const startedAt = new Date().toISOString()

  console.log(`[canvas-load] ${options.serverUrl}/canvas에 연결합니다.`)
  console.log(`[canvas-load] scenario=${options.scenario}, profile=${options.profile}, seed=${options.seed}`)

  try {
    const seedClient = await connectClient(0, options, stats)
    clients.push(seedClient)
    const fixture = await seedFixture(seedClient.doc, options)
    console.log(`[canvas-load] fixture ${fixture.skipped ? '재사용' : '생성'}: ${fixture.inserted}개 추가`)

    if (options.scenario !== 'seed') {
      await delay(300)
      const rest = await Promise.all(Array.from({ length: options.clients - 1 }, (_, index) => connectClient(index + 1, options, stats)))
      clients.push(...rest)
      console.log(`[canvas-load] 가상 사용자 ${clients.length}명 연결 완료`)
      startScenario(clients, options, stats)
      await delay(options.duration * 1000)
    }
  } finally {
    await closeClients(clients, options)
  }

  const finishedAt = new Date().toISOString()
  const result = {
    startedAt,
    finishedAt,
    ...stats,
    attach: {
      ...stats.attach,
      averageMs: stats.clients > 0 ? Number((stats.attach.totalMs / stats.clients).toFixed(2)) : 0,
      totalMs: Number(stats.attach.totalMs.toFixed(2)),
      maxMs: Number(stats.attach.maxMs.toFixed(2)),
    },
  }
  console.log('[canvas-load] 결과')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error(`[canvas-load] 실패: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
