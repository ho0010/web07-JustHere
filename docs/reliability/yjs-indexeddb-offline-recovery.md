# 탭을 닫아도 로컬 Yjs 변경을 복구하도록 IndexedDB에 저장하기

앞선 작업에서는 클라이언트가 서버의 DB 저장 완료 ack를 받을 때까지 update를 메모리 outbox에 보관했다. 재연결 시에는 서버 state vector를 기준으로 아직 서버에 없는 diff만 다시 만들기 때문에, 연결이 잠시 끊기거나 ack가 유실되어도 두 문서를 수렴시킬 수 있었다.

하지만 Y.Doc과 outbox가 모두 브라우저 메모리에만 있었다. 서버가 내려간 상태에서 편집한 뒤 새로고침하거나 탭을 닫으면, 서버에 전송하지 못한 변경을 복구할 근거가 사라졌다.

이번 작업에서는 `y-indexeddb`로 Y.Doc을 브라우저에 저장하고 durable outbox도 같은 canvas 전용 IndexedDB에 기록했다. 재실행 시에는 로컬 문서를 먼저 복원한 뒤 서버 attach를 시작하도록 수명주기를 변경했다.

## 1. 서버 복구와 브라우저 복구는 서로 다른 문제다

서버의 PostgreSQL snapshot과 update log는 서버에 도착해 commit된 변경을 복구한다. 아직 서버에 도착하지 않은 오프라인 편집까지 복구할 수는 없다.

```text
브라우저 Y.Doc 변경
→ 네트워크 단절
→ 서버에는 해당 변경이 없음
→ 탭 종료
```

이 구간을 보존하려면 클라이언트에도 문서 상태가 남아 있어야 한다. IndexedDB는 서버 DB를 대신하는 저장소가 아니라, 전송 전 변경을 다음 브라우저 세션까지 이어 주는 로컬 복구 계층이다.

## 2. room과 canvas마다 별도 로컬 DB를 사용했다

서로 다른 문서의 update가 섞이지 않도록 다음 이름으로 IndexedDB를 만든다.

```text
justhere:yjs:v1:{roomId}:{canvasId}
```

`v1`은 이후 저장 형식이나 초기화 정책이 바뀔 때 기존 캐시와 분리할 수 있도록 둔 schema namespace다. 현재 room ID와 canvas ID는 UUID이므로 구분자 충돌도 발생하지 않는다.

각 DB에는 두 종류의 데이터가 들어간다.

```text
updates store
└─ y-indexeddb가 자동 기록한 Y.Doc update

custom store
└─ durable-outbox:v1: ack 대기 중인 update payload 배열
```

Y.Doc이 실제 편집 상태의 원본이고 outbox는 전송 상태를 보조하는 메타데이터다. outbox만 남겨서는 현재 문서를 재구성할 수 없기 때문에 둘을 같은 수명주기로 관리했다.

## 3. 네트워크 attach보다 IndexedDB 복원을 먼저 끝낸다

기존에는 Y.Doc을 만든 직후 Socket attach를 시작했다. 이 상태에서 IndexedDB 복원을 비동기로 추가하면 다음 race가 생길 수 있다.

```text
빈 Y.Doc으로 서버 attach
→ 서버와 동기화 완료로 판단
→ 뒤늦게 IndexedDB의 오프라인 변경 적용
```

그래서 `useYjsDoc`이 로컬 provider의 `whenSynced`를 기다리고, outbox 메타데이터까지 읽은 뒤에만 Socket 이벤트 구독과 `canvas:attach`를 활성화한다.

```text
Y.Doc 생성
→ IndexedDB update 적용 완료
→ durable outbox 복원
→ Socket listener 등록
→ client state vector를 포함해 attach
```

Socket 연결 자체가 먼저 열려 있더라도 canvas attach와 Yjs update 전송은 이 준비 상태를 통과하기 전에는 실행되지 않는다.

## 4. 오프라인 변경은 state vector diff로 다시 전송한다

연결이 끊긴 동안 발생한 편집은 Socket outbox에 즉시 들어가지 않더라도 Y.Doc과 IndexedDB에는 기록된다. 다음 실행에서 복원한 Y.Doc의 state vector를 attach 요청에 포함한다.

서버는 자신의 문서와 비교해 클라이언트에 없는 update와 서버 state vector를 반환한다. 클라이언트는 서버 update를 먼저 적용한 뒤, 서버 state vector 기준으로 서버에 없는 로컬 diff를 계산한다.

```text
restored client Y.Doc + server update
→ encodeStateAsUpdate(clientDoc, serverStateVector)
→ 서버에 없는 로컬 변경만 aggregate update로 생성
→ 새 updateId를 부여해 durable outbox로 전송
```

과거 outbox payload를 무조건 전부 재전송하지 않는 이유는, 서버에 저장됐지만 ack만 받지 못한 update가 섞여 있을 수 있기 때문이다. 최종 서버 상태를 기준으로 diff를 다시 만들면 이미 반영된 변경은 빠지고 실제 누락분만 남는다.

## 5. durable outbox도 변경 순서대로 영속화했다

outbox는 다음 시점마다 현재 pending snapshot을 구독자에게 전달한다.

- 로컬 update enqueue
- 서버 state vector 기준 reconcile
- durable ack 수신
- 명시적 clear

IndexedDB 쓰기는 Promise queue로 직렬화했다. 예를 들어 enqueue 직후 ack가 도착했을 때 `[pending]` 저장보다 `[]` 저장이 먼저 끝나 오래된 pending이 되살아나는 순서 역전을 막기 위해서다.

```text
save [pending]
→ save []
```

화면 전환 시에는 provider 연결만 `destroy`하고 DB 데이터는 지우지 않는다. `clearData`는 테스트나 명시적인 로컬 데이터 삭제에만 사용한다.

## 6. 저장 데이터는 복원 시 다시 검증한다

브라우저 저장소의 값은 애플리케이션 타입을 신뢰할 수 없는 외부 입력으로 취급했다. JSON 파싱 후 다음 조건을 만족하는 payload만 복원한다.

- `canvasId`, `updateId`가 문자열인지
- update가 배열인지
- 각 값이 `0~255` 범위의 정수인지
- 현재 canvas와 같은지
- update ID가 UUID 형식인지

복원한 배열과 byte 데이터는 복사해 내부 Map에 넣어 외부 참조 변경이 pending 상태를 훼손하지 않도록 했다.

## 7. 검증한 시나리오

`fake-indexeddb`를 이용해 브라우저 재실행에 가까운 흐름을 단위 테스트로 만들었다.

- 첫 Y.Doc의 로컬 편집을 IndexedDB에 자동 저장
- provider와 Y.Doc을 종료한 뒤 같은 DB 이름으로 새 Y.Doc 생성
- 새 Y.Doc에서 이전 편집 상태 복원
- durable outbox payload 복원
- 복원한 문서와 서버 문서의 state vector 비교
- 서버에 없는 오프라인 변경만 diff로 생성
- 해당 diff 적용 후 두 문서 상태 수렴
- 다른 room/canvas가 서로 다른 DB 이름을 사용
- 잘못된 canvas, UUID, byte payload를 outbox 복원에서 제외
- enqueue와 ack 순서대로 영속화할 수 있는 snapshot 발행

프론트엔드 테스트 34개와 TypeScript, ESLint 검사를 통과했다.

## 8. 이번 작업이 보장하는 범위

이번 작업으로 같은 브라우저와 origin에서 탭을 새로 열더라도 IndexedDB가 유지되어 있다면 서버에 보내지 못한 Yjs 변경을 복원하고, 서버 state vector 기준 diff로 다시 전송할 수 있다. durable ack 대기 목록도 브라우저 메모리 수명보다 오래 유지된다.

다만 IndexedDB를 서버 저장소와 같은 내구성으로 보지는 않는다.

- 시크릿 모드, 사용자 사이트 데이터 삭제, 브라우저 저장 공간 회수 시 데이터가 사라질 수 있다.
- 다른 기기나 다른 브라우저 프로필로 로컬 데이터를 전달하지 않는다.
- 장기간 사용하지 않은 canvas DB를 정리하는 TTL 정책은 아직 없다.
- 저장 공간 부족이나 IndexedDB 장애를 사용자에게 별도 UI로 표시하지 않는다.
- 로컬 저장 데이터의 별도 암호화는 적용하지 않았다.

따라서 이번 단계의 목표는 영구 보관을 약속하는 것이 아니라, **네트워크 단절과 탭 종료가 겹쳤을 때 서버에 도착하지 못한 편집을 브라우저 세션 밖에서도 복구할 근거를 만드는 것**이다.
