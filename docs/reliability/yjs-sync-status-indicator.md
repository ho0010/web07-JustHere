# 로컬 저장과 서버 DB 저장을 구분해 동기화 상태 보여주기

앞선 작업에서 Y.Doc과 durable outbox를 IndexedDB에 저장해 탭이 종료된 뒤에도 오프라인 변경을 복구할 수 있게 했다. 하지만 사용자는 현재 변경이 브라우저에만 있는지, 서버로 전송 중인지, PostgreSQL commit까지 끝났는지 알 수 없었다.

기존의 `isConnected`는 Socket 연결 여부만 표현한다. Socket이 연결되어 있어도 Yjs attach handshake가 끝나지 않았거나 durable ack를 기다리는 update가 있을 수 있으므로, 이를 곧바로 “저장 완료”로 표시하면 실제 보장보다 강한 안내가 된다.

이번 작업에서는 로컬 복원, Socket 연결, Yjs 동기화, durable ack를 하나의 상태 모델로 조합하고 캔버스 우측 하단에 현재 상태를 표시했다.

## 1. 연결 상태와 저장 상태를 분리했다

동기화 상태는 다음 입력으로 계산한다.

```text
IndexedDB Y.Doc/outbox 복원 완료 여부
+ Socket 연결 상태
+ Yjs attach handshake 완료 여부
+ durable ack 대기 update 개수
+ 로컬 영속화 오류 여부
```

각 단계는 다음 의미를 가진다.

| 상태           | 표시 문구             | 의미                                         |
| -------------- | --------------------- | -------------------------------------------- |
| `restoring`    | 로컬 변경 복원 중     | IndexedDB의 Y.Doc과 outbox를 읽는 중         |
| `connecting`   | 서버 연결 중          | 최초 Socket 연결을 시도하는 중               |
| `reconnecting` | 재연결 중 · 로컬 저장 | 연결 복구를 시도하며 변경은 IndexedDB에 보관 |
| `offline`      | 오프라인 · 로컬 저장  | 서버 연결은 없지만 로컬 편집을 계속 보존     |
| `syncing`      | 서버에 저장 중        | attach 또는 durable ack 완료를 기다리는 중   |
| `saved`        | 내 변경 저장됨        | handshake가 끝났고 ack 대기 update가 없음    |
| `error`        | 로컬 복구 저장 오류   | IndexedDB 문서 또는 outbox 처리에 실패       |

## 2. `saved` 조건을 durable ack까지 확장했다

Socket의 `connected`만으로는 저장 완료를 판단하지 않는다.

```ts
socketStatus === 'connected' && syncReady && pendingUpdateCount === 0
```

`syncReady`는 서버의 `canvas:attached` 응답을 처리하고 state vector 기반 reconcile까지 수행한 뒤에만 true가 된다. 로컬 update를 전송하면 outbox pending 개수가 증가하고, 서버 DB transaction commit 이후 durable ack를 받아야 다시 0이 된다.

따라서 상태 흐름은 다음과 같다.

```text
내 로컬 편집
→ pending update 증가
→ 서버에 저장 중
→ PostgreSQL commit
→ durable ack 수신
→ pending update 제거
→ 내 변경 저장됨
```

Socket.IO의 재연결 이벤트는 개별 Socket이 아니라 Manager에서 발생한다. `reconnect_attempt`, `reconnect_error`, `reconnect_failed`를 Manager에 구독하고, 최대 재시도 이후에는 상태를 `offline`으로 전환하도록 기존 연결 추적도 함께 수정했다.

## 3. outbox를 반응형 상태로 연결했다

durable outbox는 기존에도 pending Map을 관리했지만 React는 그 변화를 알 수 없었다. outbox의 snapshot 구독을 이용해 enqueue, reconcile, ack 때마다 `pendingUpdateCount`를 갱신한다.

IndexedDB에서 outbox를 복원한 직후에도 복원된 pending 개수를 반영하므로, 재실행 직후 아직 서버 확인이 끝나지 않은 변경을 저장 완료로 잘못 표시하지 않는다.

## 4. 로컬 저장 오류를 별도로 드러냈다

Y.Doc IndexedDB 초기화·복원 오류와 durable outbox 읽기·쓰기 오류를 상태 입력에 포함했다. Socket 연결이 정상이어도 로컬 복구 계층을 사용할 수 없다면 `error`가 다른 상태보다 우선한다.

outbox 저장 오류가 일시적이고 다음 저장이 성공하면 오류 상태를 해제한다. 화면이 이미 전환된 뒤 완료되는 비동기 작업은 상태를 변경하거나 오류를 보고하지 않도록 effect cleanup 여부도 확인한다.

## 5. 검증한 상태 전이

- IndexedDB 복원 전에는 Socket 연결 여부와 관계없이 `restoring`
- 최초 연결과 재연결 상태 구분
- 연결이 완전히 종료되면 `offline`
- Socket 연결 후 handshake 전에는 `syncing`
- durable ack pending이 하나라도 있으면 `syncing`
- handshake 완료와 pending 0을 모두 만족해야 `saved`
- 로컬 영속화 오류가 다른 연결 상태보다 우선

프론트엔드 단위 테스트에서는 전체 39개 테스트가 통과했다.

## 6. 문구가 보장하는 범위

`내 변경 저장됨`은 이 클라이언트가 보낸 update의 durable ack가 모두 도착했다는 의미다. 다른 사용자의 update는 브로드캐스트 시점과 DB commit 시점 사이에 차이가 있고, 수신 클라이언트가 해당 update의 durable ack를 직접 받지는 않는다.

따라서 “캔버스의 모든 변경이 저장됨”이라고 표현하지 않았다. 현재 UI가 보장하는 범위는 **내 클라이언트가 전송한 변경의 서버 저장 완료 여부와, 오프라인 상태에서 로컬 복구가 가능한지 사용자에게 구분해 알리는 것**이다.
