# 전체 객체를 그리던 캔버스를 viewport 기준으로 줄이기

앞선 작업에서는 가상 사용자 30명의 실시간 커서 부하를 재현하고, awareness 상태 배치와 공유 Animation Scheduler를 적용해 cursor-only 안정 구간을 약 40FPS에서 60FPS로 개선했다.

커서 병목을 제거한 뒤에는 처음 데모에서 함께 관찰했던 또 다른 문제를 보기로 했다. 캔버스에 객체가 많을 때 Hand 도구로 화면을 이동하거나, 다른 사용자가 여러 객체를 움직이면 Main Layer가 화면 밖 객체까지 모두 다시 그리는 구조였다.

이 글은 전체 593개 객체 가운데 실제 화면 근처에 있는 객체 수를 계측하고, viewport culling을 적용해 Main Layer draw 비용을 줄인 과정이다.

## 요약

먼저 결론부터 적으면 다음과 같다.

- 기존에는 화면에 실제로 보이는 객체가 훨씬 적은 개수(24~64개)여도 전부(593개)를 모두 React-Konva tree에 유지했다.
- Stage transform과 객체 bounding box를 이용해 `가시/후보/렌더` 수를 따로 계측했다.
- viewport 바깥에 300px overscan을 두고, 이 영역과 교차하는 객체만 렌더링했다.
- pan 테스트에서 렌더 객체 평균을 `593 → 51.48개`로 91.3% 줄였다.
- pan 중 Main Layer draw 평균을 `3.712ms → 0.519ms`로 86.0% 줄였다.
- 원격 객체 move 부하에서 Main Layer draw 누적 시간을 `9,598.2ms → 1,855.1ms`로 80.7% 줄였다.
- move 부하의 최저 FPS는 `44 → 59.06`, 느린 frame 비율은 `1.37% → 0.03%`로 개선됐다.
- pan은 Before에서도 이미 60FPS였지만, 같은 사용자 경험을 훨씬 작은 draw 비용으로 유지해 객체 증가와 저사양 기기에 사용할 frame 여유를 확보했다.

다만 모든 객체가 한 화면 안에 들어오는 저배율 상태에서는 culling할 객체가 없으므로 이 최적화의 효과도 줄어든다. 이 경우는 별도의 렌더링 전략이 필요하다.

## 1. 왜 viewport culling을 다음 작업으로 골랐나

기존 mixed 탐색 측정에서는 Main Layer draw가 평균 5.18ms였고, 60초 동안 누적 5,978.3ms를 사용했다. 당시에는 커서, Yjs update, 긴 라인 생성이 모두 섞여 있어 Main Layer만의 문제라고 확정할 수 없었다.

커서 파이프라인을 먼저 최적화한 뒤 렌더 코드를 다시 보니 Main Layer는 다음처럼 `zIndexOrder` 전체를 순회하고 있었다.

```text
zIndexOrder 전체
→ Line, PostIt, PlaceCard, TextBox 조회
→ 모든 객체의 React-Konva node 생성
→ Main Layer scene canvas와 hit canvas draw
```

Stage가 이동하거나 확대되어 화면에 일부 객체만 보이더라도 이 목록은 줄어들지 않았다.

예를 들어 전체 객체가 593개이고 현재 화면에 54개만 보이는 상황에서도 실제 Konva tree에는 593개가 모두 남아 있었다. 데이터는 전체를 가지고 있어야 하지만, 화면 밖 객체까지 매 draw에서 그릴 필요는 없다고 판단했다.

## 2. 바로 필터링하지 않고 가시 범위부터 계측했다

처음부터 객체를 제외하면 Before와 After에서 계측 코드 자체가 달라질 수 있다. 그래서 먼저 viewport 계산과 객체 수 계측만 추가하고, 실제 렌더링은 여전히 593개를 유지한 상태로 기준선을 만들었다.

오버레이에는 다음 세 값을 추가했다.

```text
가시: 실제 viewport와 bounding box가 겹치는 객체
후보: viewport + 300px overscan과 겹치는 객체
렌더: 현재 React-Konva tree에 실제로 존재하는 객체
```

culling 전에는 다음처럼 보였다.

```text
가시/후보/렌더: 54/89/593
```

culling 후에는 후보와 렌더 수가 같아지는 것이 목표였다.

```text
가시/후보/렌더: 64/90/90
```

JSON report schema는 이 필드를 추가하면서 version 3으로 변경했다. raw JSON은 이전 작업과 마찬가지로 로컬 `docs/performance/results/raw/`에만 보관하고 Git에는 올리지 않았다.

## 3. Stage transform을 Canvas 좌표계 viewport로 바꿨다

Stage의 `x`, `y`는 화면에서 Canvas가 이동한 거리이고, 객체 좌표는 scale이 적용되기 전 Canvas 좌표계에 있다. 따라서 현재 화면 범위를 객체 좌표와 비교하려면 다음 변환이 필요했다.

```ts
left = -stage.x() / scale
top = -stage.y() / scale
width = viewportWidth / scale
height = viewportHeight / scale
```

scale이 2이고 Stage x가 -200이면 화면의 왼쪽은 Canvas 좌표 100부터 시작한다.

Stage의 실제 표시 영역은 브라우저 전체 크기가 아니라 캔버스 컨테이너 크기를 사용했다. 사이드바가 열려 있어도 보이지 않는 오른쪽 영역까지 viewport로 계산하지 않기 위해서다.

## 4. 객체별 bounding box를 만들었다

각 객체 타입은 다음 기준으로 bounding box를 계산했다.

| 객체 타입 | bounding box 기준                        |
| --------- | ---------------------------------------- |
| PostIt    | `x, y, width, height`                    |
| PlaceCard | `x, y, width, height`                    |
| TextBox   | `x, y, width, height`                    |
| Line      | 전체 points의 min/max 좌표 + stroke 반경 |

객체 데이터가 바뀔 때만 key별 bounding box Map을 다시 만들고, viewport가 바뀔 때는 이 Map과 교차 여부만 검사했다.

```text
Map<type:id, BoundingBox>
```

라인은 기존 선택 영역 계산에서 사용하던 `getLineBoundingBox`를 재사용하고, 두꺼운 선이 경계에서 잘리지 않도록 `strokeWidth / 2`만큼 범위를 넓혔다.

## 5. pan 중 React render가 과도하게 생기지 않도록 했다

Stage의 x, y는 드래그 중 계속 바뀐다. 변화할 때마다 React state를 바꾸고 객체를 다시 필터링하면 culling을 위해 새로운 병목을 만들 수 있다.

그래서 다음 세 가지 완충 장치를 두었다.

### 5.1 RAF 단위 transform 추적

Stage의 `xChange`, `yChange`, `scaleXChange`, `scaleYChange` 이벤트를 받아도 이미 RAF가 예약되어 있으면 추가 예약하지 않는다.

### 5.2 300px overscan

실제 viewport보다 화면 기준 300px 넓은 영역의 객체를 미리 렌더링한다. 드래그할 때 객체가 경계에 도착한 뒤 갑자기 mount되는 현상을 줄이기 위한 공간이다.

overscan은 Canvas 좌표가 아니라 화면 px 기준으로 유지한다.

```ts
overscanInCanvas = 300 / scale
```

### 5.3 100px refresh margin

작은 pan마다 candidate set을 갱신하지 않는다. 현재 viewport와 100px margin이 기존 render bounds 안에 포함되는 동안에는 이전 후보를 그대로 사용한다.

scale은 이전 동기화 값보다 약 10% 이상 달라졌을 때 후보를 다시 계산한다. 60Hz timestamp와 resize도 같은 RAF 경로로 처리했다.

## 6. Before 기준선을 두 가지로 나눴다

viewport culling은 화면 이동과 객체 update에서 서로 다른 방식으로 효과가 나타날 수 있어 두 시나리오를 따로 측정했다.

### 6.1 Pan Before

초기 배율에서 Hand 도구로 오른쪽, 왼쪽, 아래, 위 방향으로 화면을 이동했다. 모든 객체가 보이도록 멀리 줌아웃하지 않고, 실제 사용자가 현재 화면 크기 정도씩 이동하는 조건을 사용했다.

| 지표                 |      결과 |
| -------------------- | --------: |
| 활성 표본            |      29초 |
| 전체 객체            |     593개 |
| 가시 객체 평균       |      24개 |
| 후보 객체 평균       |   46.34개 |
| 실제 렌더 객체       |     593개 |
| FPS 평균             |     59.97 |
| FPS 최저             |     59.00 |
| frame p95 중앙값     |    17.1ms |
| Main Layer draw 횟수 |     488회 |
| Main Layer draw 평균 |   3.712ms |
| Main Layer draw p95  |     5.9ms |
| Main Layer draw 누적 | 1,811.4ms |

FPS는 이미 60에 가까웠다. 따라서 이 테스트에서는 FPS 상승보다 같은 pan을 처리하는 Main Layer draw 비용이 얼마나 줄어드는지를 주요 지표로 정했다.

### 6.2 Move Before

화면을 움직이지 않은 상태에서 가상 사용자 30명이 사용자당 5Hz로 PostIt, PlaceCard, TextBox 위치를 변경했다. 화면을 가만히 둔 이유는 pan 비용을 섞지 않고 원격 document update가 Main Layer를 다시 그리는 상황만 보기 위해서다.

| 지표                 |      결과 |
| -------------------- | --------: |
| 활성 표본            |      60초 |
| Yjs update           |   8,906회 |
| 가시 객체 평균       |      54개 |
| 후보 객체 평균       |   88.77개 |
| 실제 렌더 객체       |     593개 |
| FPS 평균             |     59.23 |
| FPS 최저             |     44.00 |
| frame p95 중앙값     |    17.4ms |
| frame p95 상위 95%   |    33.4ms |
| 20ms 초과 frame 평균 |     1.37% |
| Main Layer draw 횟수 |   2,296회 |
| Main Layer draw 평균 |   4.180ms |
| Main Layer draw p95  |     5.3ms |
| Main Layer draw 누적 | 9,598.2ms |

60초 동안 Main Layer draw에 약 9.6초가 누적됐다. 평균 FPS는 높았지만 순간적으로 44FPS까지 하락했고 일부 1초 구간의 frame p95는 33.4ms였다.

> **여기에 사진 1 넣기 — culling 적용 전 가시/후보/렌더 계측(필수)**  
> `가시/후보/렌더`의 마지막 값이 593이고 Main draw p95가 약 5~6ms인 화면을 사용한다. Pan 또는 Move Before 중 수치가 잘 보이는 사진 한 장이면 된다.

<!-- ![viewport culling Before](사진-업로드-후-URL) -->

## 7. z-index 순서를 유지하면서 후보만 렌더링했다

전체 객체 데이터와 `zIndexOrder`는 그대로 유지했다. 필터는 데이터를 삭제하는 것이 아니라 React-Konva node 생성 대상을 줄이는 역할만 한다.

```text
전체 zIndexOrder
→ viewport + overscan과 교차하는 key Set 생성
→ 기존 순서를 유지한 채 zIndexOrder filter
→ 후보 객체만 React-Konva node로 변환
```

```ts
const renderedZIndexOrder = zIndexOrder.filter(({ type, id }) => renderCandidateItemKeys.has(makeKey(type, id)))
```

화면 밖 객체도 Yjs와 React state에는 계속 존재한다. 다시 viewport 근처로 들어오면 같은 데이터로 mount된다.

## 8. 조작 중인 객체가 사라지지 않게 했다

culling에서 가장 주의한 부분은 단순 교차 판정보다 사용자 조작 상태였다.

선택한 객체를 화면 경계 밖으로 드래그하는 동안 후보에서 제거되면 Konva node와 Transformer가 unmount되어 조작이 중간에 끊긴다. 그래서 현재 선택된 객체 key는 viewport 밖이어도 candidate set에 항상 포함했다.

```text
render candidate
= viewport + overscan 교차 객체
+ 현재 선택된 객체
```

PostIt과 PlaceCard가 culling으로 unmount될 때 `shapeRefs` Map에 파괴된 Konva Group이 남지 않도록 callback ref 정리도 추가했다.

저장된 pan 위치로 캔버스에 다시 들어올 때 첫 frame이 기본 원점 기준으로 계산되면 잠깐 빈 화면이 보일 수 있다. 이를 막기 위해 Stage transform의 첫 동기화가 끝나기 전에는 전체 객체를 유지하고, 실제 viewport를 확인한 다음 culling을 시작한다.

## 9. After 결과

### 9.1 Pan After

| 지표                 |    Before |   After |   변화 |
| -------------------- | --------: | ------: | -----: |
| 가시 객체 평균       |     24.00 |   28.24 |      - |
| 후보 객체 평균       |     46.34 |   51.48 |      - |
| 실제 렌더 객체 평균  |    593.00 |   51.48 | -91.3% |
| FPS 평균             |     59.97 |   60.00 |   유지 |
| FPS 최저             |     59.00 |   59.98 |   개선 |
| frame p95 중앙값     |    17.1ms |  16.8ms |   유지 |
| Main Layer draw 횟수 |     488회 |   443회 |  -9.2% |
| Main Layer draw 평균 |   3.712ms | 0.519ms | -86.0% |
| Main Layer draw p95  |     5.9ms |   0.9ms | -84.7% |
| Main Layer draw 누적 | 1,811.4ms | 229.7ms | -87.3% |

After에서 가시 객체와 후보 객체가 오히려 조금 더 많았는데도 draw 시간은 크게 감소했다. pan FPS는 전후 모두 60이지만 같은 동작을 기존 draw 비용의 약 13%로 처리했다.

### 9.2 Move After

| 지표                 |    Before |     After |   변화 |
| -------------------- | --------: | --------: | -----: |
| Yjs update           |   8,906회 |   8,872회 |  -0.4% |
| 가시 객체 평균       |     54.00 |     63.45 |      - |
| 후보 객체 평균       |     88.77 |     89.53 |      - |
| 실제 렌더 객체 평균  |    593.00 |     89.53 | -84.9% |
| FPS 평균             |     59.23 |     59.98 |  +1.3% |
| FPS 최저             |     44.00 |     59.06 | +15.06 |
| frame p95 중앙값     |    17.4ms |    17.5ms |   유지 |
| frame p95 상위 95%   |    33.4ms |    17.6ms | -47.3% |
| 20ms 초과 frame 평균 |     1.37% |     0.03% | -97.8% |
| Main Layer draw 횟수 |   2,296회 |   1,860회 | -19.0% |
| Main Layer draw 평균 |   4.180ms |   0.997ms | -76.1% |
| Main Layer draw p95  |     5.3ms |     1.2ms | -77.4% |
| Main Layer draw 누적 | 9,598.2ms | 1,855.1ms | -80.7% |

Before와 After의 Yjs update 수는 약 0.4% 차이로 거의 같았다. After에서 실제 가시 객체 수가 더 많았는데도 Main Layer draw 누적 시간은 약 80.7% 줄었다.

평균 FPS는 처음부터 60에 가까워 차이가 작았지만, 최저 FPS와 느린 frame 비율이 안정됐다. 이번 변경의 사용자 체감 효과는 평균 FPS 상승보다 객체 update 중 발생하던 순간적인 끊김을 줄인 데 있다.

> **여기에 사진 2 넣기 — viewport culling 적용 후 최종 화면(필수)**  
> `가시/후보/렌더`에서 후보와 렌더 수가 같고, Main draw p95가 약 1ms인 사진을 사용한다.

<!-- ![viewport culling After](사진-업로드-후-URL) -->

## 10. 검증한 항목

순수 geometry 테스트에서는 다음 조건을 확인했다.

1. Stage pan과 scale을 Canvas 좌표계 viewport로 변환하는가
2. overscan을 화면 px 기준으로 Canvas 좌표에 반영하는가
3. viewport 경계와 일부만 겹친 객체도 포함하는가
4. refresh margin이 기존 render bounds 안에 포함되는지 판단하는가
5. viewport 밖에 있어도 선택된 객체를 candidate에 포함하는가

전체 검증 결과는 다음과 같다.

- frontend Vitest 13개 통과
- frontend ESLint 통과
- TypeScript 및 Vite production build 통과
- pan·zoom 중 객체 표시 확인
- 선택 객체를 화면 경계로 이동할 때 조작 유지 확인

## 11. 모든 객체가 viewport에 들어오면 어떻게 되나

viewport culling은 전체 객체 수 `N` 대신 화면 근처 객체 수 `V`에 비례하도록 draw 대상을 줄이는 최적화다.

```text
일반적인 확대 상태
전체 593개, 후보 90개
→ 약 90개 렌더

모든 객체가 보이는 저배율 상태
전체 593개, 후보 593개
→ 593개 렌더
```

따라서 모든 객체가 viewport와 overscan 안에 들어오면 이 최적화만으로는 draw 비용을 줄일 수 없다. 이는 구현 실패가 아니라 culling 방식의 경계다.

그 상황까지 최적화하려면 다음과 같은 별도 전략을 검토해야 한다.

1. Hand 도구로 pan하는 동안 Main Layer의 hit graph를 비활성화한다.
2. 저배율에서는 텍스트, 그림자, 상세 이미지 등을 단순한 도형으로 바꾸는 LOD를 적용한다.
3. 긴 라인의 points를 화면 scale에 맞춰 단순화한다.
4. pan 중 정적인 Main Layer를 bitmap cache로 그린 뒤 drag 종료 시 vector node로 복원한다.
5. 정적 객체와 편집 중인 동적 객체를 Layer로 분리한다.

이 항목들은 각각 품질과 상호작용 방식에 다른 트레이드오프가 있으므로 이번 PR에는 섞지 않았다. 모든 객체가 보이는 저배율 pan을 별도 기준선으로 만든 뒤 비용이 가장 큰 구간부터 선택할 예정이다.

## 12. 트레이드오프와 남은 문제

### 12.1 데이터와 projection 비용은 그대로다

화면 밖 객체도 Yjs 문서와 React state에는 남아 있다. 따라서 메모리, 네트워크 수신량, Yjs shared type을 React 배열로 변환하는 projection 비용은 줄지 않는다.

이번 작업은 React-Konva node 수와 Main Layer draw·hit 대상만 줄인다.

### 12.2 객체 mount와 unmount 비용이 생긴다

viewport를 크게 이동하면 후보 집합이 바뀌면서 객체가 mount·unmount된다. overscan과 refresh margin으로 빈도를 줄였지만, 매우 빠른 이동이나 이미지가 많은 장면에서는 이 비용도 별도로 관찰할 필요가 있다.

### 12.3 bounding box가 큰 라인은 계속 포함될 수 있다

라인의 실제 stroke가 viewport를 지나지 않더라도 bounding box가 viewport와 겹치면 후보로 남는다. 정확한 선분 교차 판정보다 계산 비용이 작고 안전한 bounding box 방식을 먼저 선택했다.

## 13. 관련 커밋

| Commit    | 내용                                               |
| --------- | -------------------------------------------------- |
| `f490fed` | viewport 좌표 변환, 가시·후보·렌더 계측 추가       |
| `207d3af` | viewport 밖 객체 렌더링 제외 및 ref lifecycle 보완 |

```text
branch: perf/canvas-viewport-culling
PR: viewport 기반 캔버스 객체 렌더링 최적화
```

## 14. Wiki에 올릴 사진 정리

| 우선순위 | 사진                  | 사용 위치 | 캡션 핵심                                                |
| -------: | --------------------- | --------- | -------------------------------------------------------- |
|     필수 | culling Before        | 기준선    | 가시·후보보다 렌더 수가 훨씬 많고 Main draw p95 약 5~6ms |
|     필수 | culling After         | 최종 결과 | 후보와 렌더 수가 같고 Main draw p95 약 1ms               |
|     선택 | 빠른 pan 또는 줌 화면 | 동작 검증 | overscan으로 객체 pop-in 없이 표시됨                     |

Before와 After 사진은 비슷한 viewport와 객체 밀도에서 오버레이가 잘 보이도록 나란히 배치한다. raw JSON과 전체 터미널 출력은 사진으로 올리지 않고 표로 정리한다.

## 15. 다음 작업

이 브랜치의 목표였던 viewport 밖 객체의 불필요한 Main Layer draw 제거는 여기서 마무리한다.

다음에는 최적화된 cursor와 viewport culling이 모두 적용된 상태에서 mixed 부하를 다시 측정한다. 이 결과에 따라 다음 작업을 선택한다.

```text
Yjs projection이 크다
→ 변경된 객체만 React state에 반영하는 증분 projection

라인 update와 전송량이 크다
→ points update 구조와 binary 전송 개선

모든 객체가 보이는 pan이 느리다
→ hit graph, LOD, bitmap cache 비교
```
