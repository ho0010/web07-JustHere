# 캔버스 부하 기준선 측정

## 목적

실제 데모에서 관찰한 "캔버스 요소와 동시 사용자가 늘수록 조작이 느려지는 현상"을 로컬에서 반복 재현하고, 최적화 전후를 같은 조건으로 비교한다.

이 단계에서는 Prometheus 수치만으로 브라우저 병목을 추정하지 않는다. 브라우저에서 아래 구간을 직접 나누어 측정한다.

1. Socket.IO로 받은 Yjs update 적용 시간
2. Yjs shared type 전체를 React state로 투영하는 시간
3. 해당 commit을 위해 React가 렌더링한 시간
4. Konva 메인 Layer와 Cursor Layer draw 시간
5. awareness 수신과 Cursor store 반영 횟수
6. frame 간격, long task, 수신 update 수와 binary 크기

## 주의사항

- 부하 도구가 생성한 fixture와 드로잉은 서버를 거쳐 DB에 저장된다.
- 운영 데이터에는 실행하지 말고, 반드시 성능 측정 전용 방과 카테고리를 사용한다.
- 같은 `seed + profile` fixture는 중복 생성하지 않지만 `draw`, `move` 시나리오 결과는 누적된다.
- 반복 측정이 끝나면 전용 카테고리를 삭제하거나 로컬 DB를 초기화한다.

## 1. 로컬 환경 준비

루트 디렉터리에서 PostgreSQL을 실행하고 마이그레이션을 적용한다.

```bash
docker compose -f docker-compose.local.yml up -d postgres
pnpm --filter backend exec prisma migrate dev
pnpm --filter backend dev
```

앱에서 성능 측정 전용 방과 카테고리를 하나 만든 뒤 `roomId`, `canvasId`를 확인한다. 여기서 `canvasId`는 백엔드가 category ID로 사용하는 값이다.

## 2. 측정용 프론트엔드 실행

빠른 기능 확인은 개발 서버로 할 수 있다.

```bash
VITE_ENABLE_CANVAS_PERF=true pnpm --filter frontend dev
```

최종 기준선은 개발 도구의 영향을 줄이기 위해 production build로 측정한다. 성능 오버레이 환경 변수는 build 시점에 포함해야 한다.

```bash
VITE_ENABLE_CANVAS_PERF=true pnpm --filter frontend build
pnpm --filter frontend preview
```

캔버스 오른쪽 위 `Canvas Perf` 패널에서 1초 단위 수치를 확인할 수 있다. `JSON`을 누르면 현재 세션의 최대 300개 표본을 내보낸다.

## 3. 고정 fixture 생성

브라우저를 열기 전에 fixture를 한 번 생성한다.

```bash
pnpm --filter frontend perf:canvas:load -- \
  --room-id <ROOM_ID> \
  --canvas-id <CANVAS_ID> \
  --scenario seed \
  --profile medium \
  --seed 20260630
```

profile별 객체 수는 다음과 같다.

| profile | 포스트잇 | 장소 카드 | 라인 | 텍스트 | 라인당 좌표 쌍 |
| ------- | -------: | --------: | ---: | -----: | -------------: |
| small   |       50 |        20 |   30 |     10 |             40 |
| medium  |      250 |       100 |  100 |     50 |            120 |
| large   |      600 |       200 |  200 |    100 |            240 |

fixture 생성 후 캔버스에 접속하거나 새로고침한다. 이때 `yjsInitialApply` 표본으로 초기 문서 적용 비용도 기록된다.

## 4. 동시 사용자 부하 재현

브라우저로 같은 캔버스를 열어 둔 상태에서 별도 터미널로 실행한다.

```bash
pnpm --filter frontend perf:canvas:load -- \
  --room-id <ROOM_ID> \
  --canvas-id <CANVAS_ID> \
  --scenario mixed \
  --profile medium \
  --clients 30 \
  --duration 60 \
  --cursor-hz 10 \
  --update-hz 5 \
  --seed 20260630
```

시나리오 의미는 다음과 같다.

| scenario | 발생시키는 부하                                           |
| -------- | --------------------------------------------------------- |
| `seed`   | 고정 객체만 생성하고 종료                                 |
| `cursor` | 사용자별 awareness 커서 전송                              |
| `move`   | 포스트잇·장소 카드·텍스트 위치 변경                       |
| `draw`   | 현재 클라이언트처럼 커지는 `points` 배열 전체를 반복 교체 |
| `mixed`  | cursor + move + draw 동시 실행                            |

실행 종료 시 터미널에는 Yjs binary 크기와 `number[]` JSON 직렬화 크기가 함께 출력된다. 두 값의 차이는 현재 전송 형식의 직렬화 오버헤드를 판단하는 근거다.

## 5. 측정 순서

아래 순서를 `small → medium → large` 각각 3회 반복한다.

1. Chrome 확장 프로그램과 DevTools를 닫고 viewport, zoom, 전원 상태를 고정한다.
2. 전용 캔버스를 새로고침하고 10초 동안 초기 로딩과 warm-up을 기다린다.
3. 오버레이의 `초기화`를 누른다.
4. 같은 옵션으로 60초 부하를 실행한다.
5. 드래그, 줌, 펜 입력을 정해진 순서로 각각 10초 수행한다.
6. 오버레이 JSON과 터미널 결과를 보관한다.
7. 3회의 중앙값을 기준선으로 사용한다.

아래 환경도 결과와 함께 기록한다.

- Git commit SHA
- OS, CPU, RAM
- Chrome 버전
- viewport와 device pixel ratio
- profile, client 수, cursor/update 빈도
- production build 여부

## 6. 결과 기록 양식

| 조건          | FPS | frame p95 | 20ms 초과율 | long task | awareness/s | store/s | Yjs apply p95 | 상태 투영 p95 | Main draw p95 | Cursor draw p95 |
| ------------- | --: | --------: | ----------: | --------: | ----------: | ------: | ------------: | ------------: | ------------: | --------------: |
| small / 10명  |     |           |             |           |             |         |               |               |               |                 |
| medium / 30명 |     |           |             |           |             |         |               |               |               |                 |
| large / 50명  |     |           |             |           |             |         |               |               |               |                 |

## 7. 수치에 따른 다음 작업 선택

- `project*`가 커지면: Yjs 객체 하나 변경 때 배열 전체를 React state로 복사하는 구조를 증분 projection으로 변경한다.
- `reactRender`가 커지면: 객체 단위 구독, props 안정화, 렌더 범위 분리를 우선한다.
- `mainLayerDraw`가 커지면: viewport culling, 정적/동적 Layer 분리, hit graph 범위 축소를 비교한다.
- `yjsUpdateApply`와 수신량이 커지면: 라인의 `points` 전체 교체와 `number[]` 전송을 chunk/binary update 관점에서 개선한다.
- cursor-only에서 `awareness/s`와 `store/s`가 함께 높으면: awareness를 frame 단위로 배치한다.
- `cursorLayerDraw`가 높으면: 커서별 animation loop를 Layer 단위로 통합하고 `Html` 렌더링 비용을 분석한다.

최적화 PR에서는 위 항목 중 기준선에서 가장 큰 병목 하나만 선택하고, 동일한 seed와 시나리오로 전후 수치를 비교한다.
