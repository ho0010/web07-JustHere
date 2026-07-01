# Yjs 전체 배열 변환을 변경 객체 증분 projection으로 바꾸기

앞선 작업에서는 viewport culling과 bitmap cache를 적용해 객체가 많은 캔버스의 렌더링 비용을 줄였다. 화면에 그리는 객체 수와 rasterization 비용은 줄었지만, 원격 사용자가 객체 하나를 움직일 때 Yjs 데이터를 React state로 옮기는 경로는 여전히 컬렉션 전체를 다시 변환하고 있었다.

화면에서 FPS 저하가 바로 나타나는 문제는 아니었다. 하지만 가상 사용자 30명이 객체를 움직이는 동안 초당 약 146건의 Yjs update가 들어왔고, 이 update가 초당 약 19,622개의 객체 변환으로 증폭됐다.

이 글은 `observeDeep` 이벤트에서 실제로 변경된 `Y.Map`을 식별하고, 변경 객체만 다시 projection하도록 구조를 바꾼 과정이다.

## 요약

- PostIt 250개, PlaceCard 100개, Line 193개, TextBox 50개로 총 593개 객체를 사용했다.
- 가상 사용자 30명이 사용자당 5Hz로 PostIt, PlaceCard, TextBox의 위치를 변경했다.
- 기존에는 객체 하나의 필드가 바뀌어도 해당 타입의 `Y.Array` 전체를 `toArray().map()`으로 변환했다.
- Before에서 8,906건의 Yjs update가 1,196,950개의 객체 projection으로 증폭됐다.
- 변경된 `Y.Map`만 다시 변환하고 기존 배열의 해당 index만 교체하도록 바꿨다.
- 전체 배열 순회는 `8,906회 → 0회`, 업데이트당 변환 객체는 `134.4개 → 1개`로 감소했다.
- projection 누적 시간은 `792.4ms → 100.5ms`로 87.3% 감소했다.
- Yjs update apply 누적 시간은 `1,487.6ms → 888.5ms`로 40.3% 감소했다.
- FPS 중앙값은 Before와 After 모두 60이었다. 이번 작업은 현재 FPS를 높이기보다 객체와 동시 사용자가 늘어날 때 사용할 CPU 여유를 확보한 개선이다.
- mixed 회귀 테스트에서는 새 Line 20개가 추가될 때만 전체 rebuild 20회가 발생했고, 나머지 2,973건은 증분 patch로 처리됐다.

## 1. 객체 하나를 바꾸는데 컬렉션 전체를 변환하고 있었다

캔버스의 PostIt, PlaceCard, Line, TextBox는 각각 `Y.Array<Y.Map>`으로 관리한다. 기존 `useYjsDoc`의 `observeDeep` callback은 변경 이벤트의 대상과 관계없이 다음 과정을 실행했다.

```text
Yjs update 수신
→ observeDeep callback 실행
→ Y.Array 전체를 toArray()
→ 모든 Y.Map을 React 객체로 변환
→ React state 교체
```

예를 들어 PostIt 하나의 `x`, `y`만 변경돼도 PostIt 250개를 모두 다시 변환했다. 변경 내용은 작지만 projection 비용은 컬렉션 크기에 비례하는 구조였다.

이번 move 부하 테스트는 매 update마다 다음 세 컬렉션 중 하나를 균등하게 고른다.

| 컬렉션    | 객체 수 |
| --------- | ------: |
| PostIt    |   250개 |
| PlaceCard |   100개 |
| TextBox   |    50개 |

따라서 update 한 건에서 변환할 것으로 예상되는 객체 수는 다음과 같다.

```text
(250 + 100 + 50) / 3 = 약 133.3개
```

실제 Before에서는 update당 평균 134.4개가 측정됐다. 부하 스크립트의 선택 방식과 거의 같은 값이므로 계측이 기존 전체 변환 경로를 제대로 포착했다고 판단했다.

## 2. projection 작업량을 먼저 계측했다

최적화 전에 JSON report schema를 version 6으로 올리고 다음 값을 추가했다.

```text
fullCollectionScans: Y.Array 전체를 변환한 횟수
incrementalPatches: 변경 객체만 변환한 횟수
projectedItems: 실제 project 함수가 처리한 객체 수
```

오버레이에는 초당 작업량이 보이도록 다음 줄을 추가했다.

```text
Projection: full 151/s · patch 0/s · items 19600/s
```

단순히 함수 실행 시간이 줄었다고 판단하지 않고, 같은 Yjs update 양에서 실제 변환 객체 수가 줄었는지를 함께 확인하기 위한 계측이다.

> **여기에 사진 1 넣기 — 증분 projection 적용 전 move 부하(필수)**  
> `Yjs 수신 약 150/s`, `Projection full 약 150/s`, `patch 0/s`, `items 약 19,600/s`가 함께 보이는 사진을 사용한다.

<!-- ![Yjs projection Before](사진-업로드-후-URL) -->

## 3. 비교 조건을 고정했다

Before와 After는 다음 조건을 동일하게 유지했다.

```text
scenario: move
profile: medium
clients: 30명
duration: 60초
update frequency: 사용자당 5Hz
seed: 20260630
전체 객체: 593개
화면 조작: 없음
```

`mixed`는 실행할 때마다 새 Line을 추가해 데이터셋 크기가 달라진다. 그래서 정량 비교에는 기존 객체의 좌표만 바꾸는 `move`를 사용하고, `mixed`는 마지막 구조 변경 회귀 테스트로 분리했다.

## 4. 변경된 Y.Map만 다시 projection했다

공통 증분 처리 로직을 `YArrayProjection`으로 분리했다. 이 객체는 현재 React 객체 배열과 `id → index` Map을 함께 관리한다.

```text
items: 현재 projection 결과 배열
indexById: 변경 객체를 배열 위치로 찾기 위한 Map
```

`observeDeep`에서 받은 event의 target을 확인해 두 경로 중 하나를 선택한다.

```text
event.target이 Y.Array
→ 객체 추가·삭제 같은 구조 변경
→ 전체 rebuild

event.target이 Y.Map
→ 필드 변경
→ 변경된 Map만 project
→ id로 기존 index 검색
→ 해당 배열 원소만 교체
```

핵심 흐름은 다음과 같다.

```ts
const changedMaps = new Set<YMap<unknown>>()

events.forEach(event => {
  if (event.target instanceof YMap) {
    changedMaps.add(event.target)
  }
})

const nextItems = [...items]

for (const changedMap of changedMaps) {
  const index = indexById.get(changedMap.get('id'))
  nextItems[index] = project(changedMap)
}

commit(nextItems)
```

`x`와 `y`를 같은 transaction에서 바꾸면 `observeDeep`에는 같은 `Y.Map`을 가리키는 여러 변경 정보가 들어올 수 있다. `Set`으로 중복 제거하기 때문에 이 경우에도 객체 하나만 변환하고 state commit도 한 번만 실행한다.

변경되지 않은 객체는 기존 객체 참조를 그대로 유지한다. 이를 통해 projection 이후 참조 비교를 사용하는 코드가 불필요하게 모든 객체를 새 객체로 인식하는 것도 막았다.

## 5. 구조 변경은 전체 rebuild로 안전하게 처리했다

증분 처리만 고집하면 객체 추가·삭제에서 index가 어긋날 수 있다. 다음 상황에서는 전체 배열을 다시 만든다.

- `Y.Array` 자체에 add 또는 delete가 발생한 경우
- 변경된 Map의 `id`를 기존 index에서 찾지 못한 경우
- 최초 Yjs state를 React state에 반영하는 경우

```text
필드 변경의 일반 경로
→ 증분 patch

추가·삭제 또는 불확실한 상태
→ 전체 rebuild
```

일반적인 드래그와 텍스트 수정은 증분 처리하면서, 상대적으로 빈도가 낮은 구조 변경에는 단순하고 안전한 경로를 유지하는 선택이다.

PostIt, PlaceCard, Line, TextBox의 변환 코드는 각각 순수한 `project` 함수로 분리했다. 공통 증분 로직이 객체 타입별 세부 필드를 알 필요 없이 같은 방식으로 동작하도록 했다.

## 6. 테스트로 증분 처리와 fallback을 고정했다

`YArrayProjection` 단위 테스트에서는 다음 동작을 확인했다.

1. 같은 Map의 여러 필드를 한 transaction에서 변경해도 하나의 객체만 projection하는가
2. 한 transaction에서 서로 다른 Map 두 개를 변경하면 두 객체만 projection하고 한 번만 commit하는가
3. 배열에 객체를 추가하거나 삭제하면 전체 rebuild하는가
4. 변경되지 않은 객체의 참조를 유지하는가

전체 frontend 검증 결과는 다음과 같다.

```text
Vitest: 7개 파일, 19개 테스트 통과
TypeScript: 통과
ESLint: 통과
production build: 통과
```

## 7. move Before와 After 비교

Yjs update가 실제로 들어온 61개의 1초 표본만 사용했다. 두 실행의 update 수는 8,906건과 8,901건으로 0.06% 차이여서 같은 부하로 비교할 수 있었다.

| 지표                     |      Before |   After |                변화 |
| ------------------------ | ----------: | ------: | ------------------: |
| Yjs update               |     8,906회 | 8,901회 |           동일 수준 |
| Yjs update/초            |      146.00 |  145.92 |           동일 수준 |
| 전체 배열 순회           |     8,906회 |     0회 |               -100% |
| 증분 patch               |         0회 | 8,901회 | 일반 변경 전체 전환 |
| projection 객체          | 1,196,950개 | 8,901개 |              -99.3% |
| update당 projection 객체 |     134.4개 |     1개 |              -99.3% |
| projection 누적 시간     |     792.4ms | 100.5ms |              -87.3% |
| Yjs apply 누적 시간      |   1,487.6ms | 888.5ms |              -40.3% |
| FPS 중앙값               |          60 |      60 |                유지 |
| FPS 최저                 |       59.95 |   59.94 |                유지 |
| frame p95 중앙값         |      17.2ms |  17.3ms |           동일 수준 |
| 최대 느린 frame 비율     |          0% |      0% |                유지 |

projection 객체 수는 약 134분의 1이 됐다. projection 시간이 객체 수와 같은 비율로 줄지 않은 이유는 observer callback, 배열 shallow copy, index 조회, 계측 자체처럼 객체 변환 외의 고정 비용이 남아 있기 때문이다.

Yjs apply 전체 시간도 약 40% 감소했다. 현재 medium fixture에서는 Before도 60FPS였기 때문에 FPS 상승은 없었다. 대신 같은 실시간 update를 더 작은 CPU 비용으로 처리하면서 객체 수와 동시 사용자 수가 늘어날 때 사용할 여유를 만들었다.

> **여기에 사진 2 넣기 — 증분 projection 적용 후 move 부하(필수)**  
> 실행 중 `Yjs 수신 약 146/s`, `full 0/s`, `patch 약 146/s`, `items 약 146/s`, FPS 60이 함께 보이는 사진을 사용한다. 부하 종료 후 모든 값이 0인 사진은 사용하지 않는다.

<!-- ![Yjs incremental projection After](사진-업로드-후-URL) -->

## 8. mixed 시나리오로 구조 변경을 확인했다

정량 비교가 끝난 뒤 가상 사용자 10명으로 30초간 cursor, move, draw가 함께 실행되는 mixed 테스트를 진행했다.

```text
clients: 10명
duration: 30초
Yjs update: 2,993회
Line: 225개 → 245개
새 Line 추가: 20개
```

| 처리 경로      |    결과 |
| -------------- | ------: |
| 전체 rebuild   |    20회 |
| 증분 patch     | 2,973회 |
| FPS 중앙값     |      60 |
| FPS 최저       |      59 |
| frame p95 최대 |  17.7ms |
| long task      |     0회 |

새 Line 20개가 추가될 때 전체 rebuild가 정확히 20회 발생했다. 나머지 객체 위치와 Line points 변경 2,973건은 증분 patch로 처리됐다.

```text
구조 변경 20건 → full 20회
일반 필드 변경 2,973건 → patch 2,973회
```

즉 증분 처리와 안전한 fallback이 같은 실시간 세션에서 의도한 조건에 따라 나뉘어 동작했다. 객체와 Line 좌표가 증가하는 동안에도 FPS 중앙값 60을 유지했고 long task는 발생하지 않았다.

> **여기에 사진 3 넣기 — mixed 회귀 테스트(선택)**  
> 가상 커서 10개와 새 Line이 보이고, 일반 변경 구간에서 `patch 약 100/s`, `items 약 100/s`, FPS 60이 함께 보이는 사진을 사용한다. Line 추가 순간에는 full 값이 나타날 수 있다.

<!-- ![Yjs projection mixed regression](사진-업로드-후-URL) -->

## 9. 이번 수치가 의미하는 범위

`134.4개 → 1개`는 캔버스의 모든 작업이 134분의 1이 됐다는 의미가 아니다. 이번 계측의 범위는 Yjs Map을 React 객체로 직렬화하는 `project` 호출 수다.

현재 구현에도 다음 비용은 남아 있다.

- React state에 전달하기 위한 배열 shallow copy는 여전히 O(N)이다.
- 배열 참조가 바뀌므로 해당 배열을 dependency로 사용하는 파생 계산은 다시 실행될 수 있다.
- 객체 추가·삭제에서는 타입 컬렉션 전체를 rebuild한다.
- Yjs update decoding과 React-Konva draw 비용은 별개의 파이프라인이다.

따라서 이번 결과는 전체 렌더링 성능을 134배 개선했다고 표현하지 않는다. **일반적인 원격 필드 update의 projection 작업량을 컬렉션 크기 O(N)에서 변경 객체 수 O(K)에 비례하도록 바꿨다**고 설명하는 것이 정확하다.

## 10. 정리

이번 작업에서는 FPS가 떨어진 뒤 코드를 줄이는 대신, 실시간 동기화 경로에서 객체 수에 따라 커지는 불필요한 작업을 먼저 계측했다.

```text
Before
객체 하나 변경
→ 해당 Y.Array 전체 변환
→ 평균 134.4개 projection

After
객체 하나 변경
→ observeDeep event에서 변경 Y.Map 식별
→ index로 해당 객체만 교체
→ 1개 projection
```

동일한 update 부하에서 projection 시간을 87.3%, Yjs apply 시간을 40.3% 줄이면서 기존 60FPS를 유지했다. 또한 구조 변경은 전체 rebuild로 처리하는 fallback을 남기고 mixed 테스트로 실제 추가·변경이 함께 동작하는 것도 확인했다.

이 작업의 핵심은 단순히 `map()` 호출을 줄인 것이 아니라, **Yjs transaction의 변경 범위를 React state projection의 변경 범위로 전달하도록 동기화 경계를 다시 설계한 것**이다.
