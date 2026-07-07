# PostgreSQL을 공유 기준점으로 Yjs 다중 인스턴스 정합성 보장하기

## 배경

Socket.IO Redis Adapter를 적용하면 서로 다른 NestJS 인스턴스에 연결된 클라이언트도 같은 room 이벤트를 받을 수 있다. 하지만 Redis Adapter가 동기화하는 대상은 Socket.IO 이벤트이며, 각 프로세스의 `CanvasService`가 가진 Y.Doc과 update buffer는 그대로 독립적이다.

```text
Client A → Backend A ─┐
                      ├─ Redis: room 이벤트 전달
Client B → Backend B ─┘

Backend A Y.Doc ≠ Backend B Y.Doc
```

기존 구조에서는 다음 순서로 정합성 간극이 발생할 수 있었다.

1. Backend A가 Yjs update를 메모리에 적용하고 즉시 Redis로 방송한다.
2. DB 저장은 5초 주기 buffer flush까지 기다린다.
3. Backend B는 이벤트를 클라이언트에 전달하지만 자신의 Y.Doc에는 적용하지 않는다.
4. 이 사이 Backend B로 새 클라이언트가 접속하면 오래된 메모리 Y.Doc을 초기 상태로 받을 수 있다.

이번 작업의 목표는 서버가 둘 다 살아 있는 정상 운영 상황에서 저장, 실시간 전달, 신규 접속이 같은 Yjs 상태로 수렴하도록 만드는 것이다.

## 설계 선택

### 1. 저장 완료 후 방송

Yjs update를 수신한 서버는 먼저 PostgreSQL transaction을 완료하고, `persisted` 결과를 받은 update만 room에 방송한다.

```text
Client A local apply
  → Backend A micro-batch
  → PostgreSQL commit
  → Redis room broadcast
  → Backend B의 Client B
  → durable ack
```

송신 클라이언트는 Y.Doc에 로컬 변경을 이미 적용하므로 DB 저장을 기다리는 동안 화면이 멈추지 않는다. 원격 클라이언트 전파는 micro-batch 구간과 DB transaction 시간만큼 늦어지지만, 방송된 변경은 신규 접속이 조회하는 DB에도 반드시 존재한다.

기존 5초 flush 주기는 기본 100ms micro-batch로 줄였다. `YJS_FLUSH_INTERVAL_MS` 환경 변수로 조정할 수 있으며 10ms 미만의 값은 사용하지 않는다.

### 2. 접속 시 DB 변경 재병합

서버 메모리에 Y.Doc이 이미 있어도 `canvas:attach`마다 PostgreSQL snapshot과 update log를 다시 읽어 병합한다. PostgreSQL을 인스턴스 간 reconciliation point로 사용하므로 Backend A가 저장한 변경을 Backend B의 신규 접속도 얻는다.

attach 처리에서는 먼저 Socket.IO room에 참여한다. DB 조회 도중 새로운 update가 commit되면 DB 조회에 포함되거나, commit 후 방송되는 room 이벤트로 수신하므로 경계 시점의 변경도 놓치지 않는다.

### 3. 동일 update ID 동시 저장 재시도

durable update는 `(category_id, update_id)` 복합 기본 키를 가진 receipt로 멱등성을 보장한다. 두 인스턴스가 같은 update ID를 동시에 저장하면 Serializable transaction 충돌(`P2034`) 또는 receipt unique 충돌(`P2002`)이 발생할 수 있다.

저장 transaction은 지수 backoff와 함께 최대 4회 재시도한다. 먼저 commit한 인스턴스는 `persisted`, 재시도 후 receipt를 확인한 인스턴스는 `duplicate`를 반환한다. `duplicate` update는 다시 방송하지 않는다.

### 4. 카테고리 단위 compaction 직렬화

두 인스턴스가 같은 카테고리의 snapshot compaction을 동시에 수행하면 서로 같은 log 집합을 기준으로 snapshot을 덮어쓸 수 있다.

compaction transaction은 category ID를 64비트 키로 변환한 PostgreSQL transaction advisory lock을 획득한다. 같은 카테고리의 compaction만 직렬화하고 일반 update 저장은 잠금에 참여시키지 않는다. `ReadCommitted`에서 선행 compaction이 만든 snapshot과 log 삭제 결과를 읽은 뒤 다음 작업을 수행한다.

새 update 저장은 잠그지 않는다. compaction이 조회한 log ID만 삭제하기 때문에 도중에 추가된 update log는 다음 snapshot에 안전하게 남는다.

### 5. graceful shutdown drain

기존 `onModuleDestroy()`는 마지막 flush를 실행만 하고 기다리지 않았다. 이제 종료 시 다음 순서를 보장한다.

1. 새 update 수신을 중단한다.
2. 주기 timer를 제거한다.
3. 이미 진행 중인 flush 뒤에 종료 flush를 직렬화한다.
4. 일시 실패로 buffer가 복구되면 최대 3회까지 drain을 재시도한다.
5. 종료 hook은 저장 Promise가 끝날 때까지 기다린다.

이는 정상 종료에 대한 보장이다. 프로세스 강제 종료 시 복구는 다음 failover E2E 범위에서 검증한다.

## 다중 인스턴스 E2E

테스트는 같은 PostgreSQL과 Redis를 사용하는 독립 NestJS 애플리케이션 두 개를 서로 다른 포트에 실행한다.

```bash
DATABASE_URL='postgresql://myuser:mypassword@localhost:55432/mydb?schema=public' \
REDIS_URL='redis://localhost:56379' \
pnpm --filter backend test:e2e:distributed-consistency
```

2026-07-07 기준으로 다음 시나리오를 검증했다.

- Backend A의 update가 DB에 저장된 뒤 Backend B room으로 전달된다.
- 이미 오래된 Y.Doc을 가진 Backend B로 신규 접속해도 DB refresh를 통해 최신 상태를 받는다.
- 동일 update ID를 두 인스턴스에 동시에 보내도 receipt와 update log가 한 번만 생성된다.
- 두 인스턴스가 같은 카테고리를 동시에 compaction해도 최종 snapshot에 모든 변경이 남는다.
- backend 단위 테스트 34개 suite, 353개 테스트가 통과한다.
- 기존 오프라인 복구 E2E와 Socket.IO Redis 교차 인스턴스 E2E가 함께 통과한다.

## 보장 범위

이번 작업이 보장하는 범위는 두 백엔드가 정상 동작 중일 때의 Yjs 공유 상태 수렴과 DB 동시성 제어다.

아직 검증하지 않은 항목은 다음과 같다.

- Backend A가 update 처리 중 강제 종료됐을 때 Nginx를 통한 Backend B 재접속
- Redis 또는 PostgreSQL 자체 장애
- 여러 서버에 분산된 awareness 상태 복구
- 운영 환경 네트워크 지연과 처리량을 반영한 100ms micro-batch 튜닝

다음 `test/yjs-multi-instance-failover` 작업에서는 서버 강제 종료, 클라이언트 재접속, IndexedDB outbox 재전송, 최종 DB 상태 수렴을 하나의 E2E로 검증한다.
