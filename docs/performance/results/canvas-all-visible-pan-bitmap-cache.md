# 모든 객체가 보이는 저배율 pan을 bitmap cache로 최적화하기

앞선 viewport culling 작업에서는 화면 밖 객체를 React-Konva tree에서 제외해 Main Layer draw 비용을 줄였다. 전체 593개 중 화면 근처에 있는 객체가 약 50~90개인 일반적인 확대 상태에서는 이 방식으로 pan과 원격 객체 이동을 안정화할 수 있었다.

하지만 전체 객체를 한 화면에 넣는 저배율 상태에서는 `가시/후보/렌더`가 모두 593개가 된다. 제외할 객체가 없기 때문에 viewport culling만으로는 처음 데모에서 확인했던 전체 화면 pan의 끊김을 해결할 수 없었다.

이 글은 scene draw와 hit draw를 분리해 병목을 다시 확인하고, 효과가 없던 RAF 배치 가설은 폐기한 뒤, pan 중 Main 객체 그룹을 bitmap으로 바꾸어 19FPS를 60FPS로 개선한 과정이다.

## 요약

- PostIt 250개, PlaceCard 100개, Line 193개, TextBox 50개로 총 593개 객체를 사용했다.
- Line에는 총 20,882쌍의 좌표가 포함돼 있었다.
- 전체 객체가 보이는 pan에서 FPS 중앙값은 19, frame p95 중앙값은 66.7ms였다.
- Main Layer의 scene draw와 hit draw를 분리한 결과 hit draw 평균은 0.016ms로 병목이 아니었다.
- Stage 좌표 반영을 RAF 단위로 배치했지만 FPS 중앙값은 `19 → 19.34`로 거의 변하지 않아 변경을 폐기했다.
- pan 시작 시 Main 객체 Group을 현재 배율의 bitmap으로 cache하고 종료 시 원래 노드로 복원했다.
- bitmap cache 활성 구간의 FPS 중앙값은 60, frame p95 중앙값은 16.8ms였다.
- Main scene draw 평균은 `6.10ms → 0.044ms`로 약 99.3% 감소했다.
- cache 생성은 9.8ms였으며 cache 활성 구간에는 long task가 발생하지 않았다.
- pan 종료 시 PlaceCard cache 복구에서 96ms long task가 한 번 관찰됐다. 이를 분산하려는 추가 실험은 실제 조작 체감을 악화시켜 유지하지 않았다.

## 1. viewport culling의 경계에서 시작했다

viewport culling은 전체 객체 수 `N`이 아니라 화면 근처 객체 수 `V`에 비례해 렌더링하도록 만든다.

```text
일반 확대 상태
전체 593개 / 후보 약 90개
→ 약 90개만 렌더

전체 표시 저배율 상태
전체 593개 / 후보 593개
→ 593개 모두 렌더
```

이번 테스트에서는 일부 객체만 보이는 상황과 섞이지 않도록 측정 내내 다음 조건을 유지했다.

```text
가시/후보/렌더: 593/593/593
가상 사용자: 0명
Yjs 원격 update: 0회
Hand 도구로 작은 범위를 연속 왕복 pan
```

부분 화면에서는 기존 viewport culling이 동작하고, 전체 화면에서는 이번 bitmap cache가 동작하도록 서로 다른 렌더링 전략을 적용하는 것이 목표였다.

## 2. 전체 표시 pan 기준선

기준선에서는 49개의 pan 활성 표본을 수집했다.

| 지표                       |   Before |
| -------------------------- | -------: |
| 전체 객체                  |    593개 |
| Line 좌표                  | 20,882쌍 |
| pan 활성 표본              |     49초 |
| Stage drag move            |  2,835회 |
| FPS 평균                   |    20.66 |
| FPS 중앙값                 |    19.00 |
| FPS 최저                   |    18.69 |
| frame p95 중앙값           |   66.7ms |
| 20ms 초과 frame 평균       |   94.27% |
| Main scene draw 평균       |   6.10ms |
| Main scene draw p95 중앙값 |    7.0ms |
| Main hit draw 평균         |  0.016ms |

화면은 거의 모든 구간에서 20FPS 아래로 떨어졌고, frame p95는 66.7ms에 고정됐다. 실제 데모에서 전체 화면을 이동할 때 느꼈던 끊김을 로컬에서도 재현한 기준선이다.

> **여기에 사진 1 넣기 — bitmap cache 적용 전 전체 표시 pan(필수)**  
> `가시/후보/렌더: 593/593/593`, FPS 약 19, frame p95 약 66.7ms, scene draw 약 6~7ms가 함께 보이는 사진을 사용한다.

<!-- ![전체 표시 pan Before](사진-업로드-후-URL) -->

## 3. hit graph가 병목이라는 가설을 먼저 확인했다

기존 `mainLayerDraw` 계측은 Konva의 `beforeDraw`와 `draw` 이벤트 사이를 측정했다. Konva Layer 구현을 확인하니 이 이벤트는 scene canvas draw를 감싸고 있었고 hit canvas 비용은 포함하지 않았다.

그래서 `Layer.drawHit`을 별도로 계측하고 오버레이를 다음과 같이 분리했다.

```text
Konva draw p95
scene: 실제 화면 픽셀을 그리는 비용
hit: 객체 클릭 판정용 색상 canvas를 그리는 비용
```

측정 결과 hit draw 평균은 0.016ms였다. Konva는 기본적으로 Stage drag 중 hit graph의 하위 객체 순회를 건너뛰고 있었기 때문에 `listening(false)`만 추가하는 방식으로는 의미 있는 개선을 기대하기 어려웠다.

처음 예상했던 hit graph 최적화는 구현하지 않고 다음 가설로 넘어갔다.

## 4. 효과가 없던 RAF 좌표 배치 실험

기준선에서는 초당 약 58회의 drag move가 들어오지만 Main Layer의 실제 draw는 초당 약 19회였다. 같은 frame 사이에 Stage 위치를 여러 번 변경하면서 하위 노드의 transform cache를 반복해서 무효화한다고 가정했다.

한 frame 안에 들어온 좌표 중 마지막 좌표만 Stage에 반영하는 RAF scheduler를 구현했다.

```text
mousemove 1 ─┐
mousemove 2 ─┼─→ RAF 1회 → 마지막 좌표만 Stage에 반영
mousemove 3 ─┘
```

배치 자체는 정상적으로 동작했다.

| 지표               |    Before |  RAF 배치 |
| ------------------ | --------: | --------: |
| Stage move/초      | 약 57.9회 | 약 57.2회 |
| Stage 좌표 반영/초 | 직접 반영 | 약 18.5회 |
| FPS 평균           |     20.66 |     21.12 |
| FPS 중앙값         |     19.00 |     19.34 |
| frame p95 중앙값   |    66.7ms |    66.7ms |
| 느린 frame 평균    |    94.27% |    93.88% |

입력 반영 횟수는 줄었지만 사용자 경험과 frame 지표는 거의 바뀌지 않았다. 복잡성과 입력 지연 가능성만 추가되므로 이 변경은 커밋하지 않고 되돌렸다.

이 결과를 통해 병목은 좌표 변경 횟수보다, 한 번의 화면 갱신에서 593개의 상세 노드를 다시 rasterize하는 경로에 더 가깝다고 판단했다.

## 5. rasterization 결과를 재사용하기로 했다

PostIt 하나도 Konva 내부에서는 하나의 이미지가 아니다.

```text
PostIt Group
├─ 배경 Rect
├─ Shadow
└─ Text
```

PlaceCard에는 Rect, Image, 여러 Text와 상세보기 Group이 있고, Line 193개에는 총 20,882쌍의 points가 있다. Stage가 이동할 때 객체 데이터는 변하지 않지만 이런 도형과 글자를 canvas 픽셀로 변환하는 rasterization은 반복된다.

pan 중에는 객체의 내용보다 전체 화면의 위치만 바뀐다는 점을 이용했다.

```text
기존 pan
593개 객체와 하위 Shape 순회
→ Line, Text, Rect, Shadow rasterize
→ Main scene canvas draw

bitmap cache pan
593개 객체를 drag 시작 시 한 번 rasterize
→ offscreen bitmap에 저장
→ pan 중 bitmap 한 장만 draw
```

React와 Yjs 데이터는 그대로 유지한다. 렌더링 결과만 짧은 pan 구간 동안 bitmap으로 대체한다.

## 6. Main 객체를 하나의 cache 단위로 묶었다

Main Layer의 객체들을 `mainContentGroup`으로 감쌌다.

```text
Stage
└─ Main Layer
   ├─ Main Content Group
   │  ├─ Line
   │  ├─ PostIt
   │  ├─ PlaceCard
   │  └─ TextBox
   ├─ Current Drawing Line
   └─ Transformer
```

Stage의 `dragstart`에서 조건을 확인한 다음 Group을 cache한다.

```ts
group.listening(false)
group.cache(cacheConfig)
```

선택된 객체가 있으면 Transformer와 상호작용이 끊길 수 있으므로 cache를 적용하지 않는다. 일부 객체만 보이는 상황도 viewport 밖에서 새 객체가 들어올 수 있으므로 적용 대상에서 제외했다.

```text
cache 적용 조건
- 가시 객체 수 = 전체 객체 수
- 렌더 객체 수 = 전체 객체 수
- 선택 객체 없음
- 객체 100개 이상
- 계산된 bitmap 크기가 안전 범위 이내
```

일부 화면에서 `Pan cache: off`로 보이는 것은 정상이다. 그 구간은 viewport culling이 담당한다.

## 7. 현재 배율에 맞는 bitmap만 만들었다

Canvas 좌표상 전체 영역을 원본 해상도로 cache하면 메모리 사용량이 지나치게 커질 수 있다. 현재 화면에 필요한 해상도만 만들도록 다음 값을 사용했다.

```ts
pixelRatio = stageScale * devicePixelRatio
```

예를 들어 Canvas 좌표 너비가 6,000이고 scale이 0.2, DPR이 2라면 cache bitmap의 실제 너비는 약 2,400px이다.

```text
6,000 × 0.2 × 2 = 2,400 physical px
```

다음 안전장치도 추가했다.

- cache pixel ratio를 0.1~1로 제한
- 한 변이 4,096px를 넘으면 적용하지 않음
- 전체 면적이 1,000만 픽셀을 넘으면 적용하지 않음
- pan 중 객체 이벤트가 필요하지 않으므로 Group listening 비활성화
- hit canvas pixel ratio는 0.01로 최소화

cache 조건과 크기 계산은 순수 함수로 분리해 테스트했다.

## 8. pan 종료 시 편집 가능한 노드로 복구했다

`dragend`에서는 bitmap cache를 제거하고 원래 객체 이벤트를 활성화한다.

```text
Group bitmap cache 제거
→ Group listening 복구
→ PlaceCard의 개별 shadow cache 복구
→ Main Layer batchDraw
→ 최종 Stage 위치 저장
```

```ts
group.clearCache()
group.listening(true)
```

상위 Group cache를 제거하면 하위 PlaceCard가 사용하던 개별 cache도 초기화된다. `cacheVersion`을 변경해 PlaceCard의 그림자·이미지 cache를 다시 생성하도록 했다.

## 9. bitmap cache 결과

최종 bitmap 측정 파일에서는 cache 생성 1회, skip 0회를 기록했다. cache 활성 상태의 8개 연속 표본을 기준선과 비교했다.

| 지표                       |  Before | Bitmap cache |    변화 |
| -------------------------- | ------: | -----------: | ------: |
| 가시/렌더 객체             | 593/593 |      593/593 |    동일 |
| FPS 평균                   |   20.66 |        59.75 | +189.2% |
| FPS 중앙값                 |   19.00 |        60.00 | +215.8% |
| FPS 최저                   |   18.69 |        58.00 |  +39.31 |
| frame p95 중앙값           |  66.7ms |       16.8ms |  -74.8% |
| 20ms 초과 frame 평균       |  94.27% |        0.25% |  -99.7% |
| Main scene draw 평균       |  6.10ms |      0.044ms |  -99.3% |
| Main scene draw p95 중앙값 |   7.0ms |        0.1ms |  -98.6% |
| Main hit draw 평균         | 0.016ms |      0.002ms |  -87.5% |

cache 생성에는 9.8ms가 걸렸다. cache 활성 구간에는 long task가 발생하지 않았고, 453회의 drag move 동안 FPS가 58~60으로 유지됐다.

After 표본은 기준선보다 짧지만 8개의 연속 1초 구간에서 같은 수치가 유지됐다. 평균 FPS 한 값만이 아니라 frame p95, 느린 frame 비율, scene draw 비용이 함께 개선됐다는 점으로 효과를 판단했다.

> **여기에 사진 2 넣기 — bitmap cache 활성 pan(필수)**  
> `가시/후보/렌더: 593/593/593`, `Pan cache: on`, FPS 약 60, frame p95 약 17ms가 함께 보이는 사진을 사용한다.

<!-- ![전체 표시 pan Bitmap cache](사진-업로드-후-URL) -->

> **여기에 사진 3 넣기 — pan 종료 후 원본 복구(선택)**  
> `Pan cache: off`, FPS 60, 원본 Text와 PlaceCard가 정상 표시되는 사진을 사용한다.

<!-- ![pan 종료 후 cache 복구](사진-업로드-후-URL) -->

## 10. 추가 최적화를 유지하지 않은 이유

pan 종료 시 PlaceCard의 개별 cache를 한 번에 복구하면서 96ms long task가 한 번 관찰됐다. 해당 1초 표본은 FPS 54였고 다음 표본에서 다시 60으로 회복했다.

이 비용을 줄이기 위해 PlaceCard cache를 frame당 4개씩 나눠 복구하는 scheduler를 추가로 실험했다. 단일 long task는 나눌 수 있었지만 실제로 여러 번 pan하고 도구를 조작했을 때 지속적인 렌더링과 cache 재생성이 겹치며 체감 렉이 더 커졌다.

수치 하나를 줄이기 위해 전체 사용자 경험을 악화시키는 변경은 유지할 이유가 없다고 판단해 분산 복구 로직을 되돌렸다.

이번 작업의 핵심 문제는 pan 내내 약 19FPS로 움직이던 것이었다. 이를 60FPS로 유지하는 효과는 분명했고, 종료 시 1회의 복구 비용은 알려진 트레이드오프로 남겼다.

## 11. 트레이드오프

### 11.1 pan 중 원격 변경 표시는 지연될 수 있다

cache가 활성화된 동안에도 Yjs와 React 데이터는 계속 갱신된다. 다만 화면은 drag 시작 시 만든 bitmap을 사용하므로 원격 객체 변경이 pan 종료 후 표시될 수 있다.

### 11.2 큰 bitmap은 만들지 않는다

cache 크기가 안전 범위를 넘으면 기존 렌더링을 유지한다. 성능을 위해 브라우저 메모리 안정성을 포기하지 않도록 했다.

### 11.3 저배율 pan에 한정된 전략이다

일부 객체만 보이는 일반 확대 상태에서는 viewport culling이 더 적합하다. bitmap cache는 모든 객체가 보여 culling 효과가 사라지는 구간을 보완한다.

### 11.4 cache 중에는 객체를 직접 편집하지 않는다

Hand pan 중에는 Group listening을 끄고 bitmap으로 렌더링한다. drag 종료와 동시에 원본 노드와 이벤트를 복구한다.

## 12. 검증

- 전체 객체 표시 상태에서 cache on/off 전환 확인
- pan 종료 후 Text, Image, Shadow 복구 확인
- 여러 번 pan 후 위치가 튀거나 객체가 사라지지 않는지 확인
- 일부 객체만 보일 때 viewport culling이 유지되는지 확인
- cache 크기 및 최소 객체 수 조건 테스트 3개 추가
- frontend Vitest 16개 통과
- frontend ESLint 통과
- TypeScript 및 Vite production build 통과

## 13. 관련 작업

```text
branch: perf/canvas-all-visible-pan
code commit: perf: 전체 객체 pan 중 bitmap cache 적용
docs commit: docs: 전체 객체 pan 최적화 결과 정리
PR: 전체 객체 표시 상태의 캔버스 pan 최적화
```

## 14. Wiki에 올릴 사진

| 우선순위 | 사진                  | 사용 위치 | 캡션 핵심                                   |
| -------: | --------------------- | --------- | ------------------------------------------- |
|     필수 | 전체 표시 pan Before  | 기준선    | FPS 약 19, frame p95 66.7ms, scene 약 6~7ms |
|     필수 | bitmap cache 활성 pan | 최종 결과 | cache on, FPS 약 60, frame p95 약 17ms      |
|     선택 | pan 종료 후 복구      | 동작 검증 | cache off, 원본 객체와 이벤트 복구          |
|     선택 | 5~10초 영상           | 전환 과정 | off → pan 중 on → 종료 후 off               |

Before와 After는 `가시/후보/렌더: 593/593/593`이 동일하게 보이도록 배치한다. JSON 전체 화면보다 핵심 수치 표와 오버레이 사진을 사용한다.

## 15. 마무리

이번 작업에서는 처음부터 bitmap cache를 정답으로 정하지 않았다.

```text
전체 표시 pan 재현
→ scene/hit 비용 분리
→ hit graph 가설 폐기
→ RAF 좌표 배치 구현 및 수치 검증
→ 효과가 없어 롤백
→ rasterization 반복을 병목으로 재정의
→ interaction 중 bitmap cache 적용
→ FPS 19에서 60으로 개선
→ 추가 미세 최적화는 실제 체감이 나빠 롤백
```

결과적으로 부분 화면은 viewport culling, 전체 화면은 bitmap cache가 담당하는 렌더링 전략을 만들었다. 성능 수치뿐 아니라 효과가 없거나 사용자 경험을 악화시킨 변경을 제거한 판단까지 이번 작업의 결과로 남긴다.

다음에는 cursor, viewport culling, 전체 표시 bitmap cache가 모두 적용된 상태에서 mixed 부하를 다시 측정하고 Yjs projection과 Line update 가운데 다음 병목을 선택한다.
