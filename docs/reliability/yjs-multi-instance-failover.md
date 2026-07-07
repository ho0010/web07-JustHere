# 서버 강제 종료 후 Yjs 변경을 다른 인스턴스에서 복구하기

## 배경

이전 작업에서 Socket.IO room 이벤트를 여러 NestJS 인스턴스로 전달하고, PostgreSQL을 공유 기준점으로 정상 운영 중인 Yjs 상태를 수렴시켰다. 마지막으로 확인해야 할 경계는 update를 처리하던 서버가 갑자기 종료되는 상황이다.

```text
Client
  ↓ stable endpoint
Backend A ── SIGKILL
  ↓ failover
Backend B
  ↓
PostgreSQL + Redis
```

정상 종료에서는 `onModuleDestroy()`가 buffer를 drain하지만 `SIGKILL`은 lifecycle hook을 실행하지 않는다. 따라서 클라이언트는 ack를 받지 못한 변경이 DB에 저장됐는지 알 수 없다.

이번 작업에서는 Backend A와 Backend B를 별도 Node 프로세스로 실행하고 Backend A만 실제 `SIGKILL`로 종료한다. 하나의 TCP proxy 주소가 장애 후 Backend B를 가리키게 하여 클라이언트가 동일한 외부 endpoint를 통해 다른 인스턴스로 연결되는 상황을 재현한다.

## 복구 기준

클라이언트는 IndexedDB에 두 종류의 정보를 보관한다.

- 현재 Y.Doc 상태
- durable ack를 받지 못한 update outbox

재접속 직후 outbox payload를 바로 재전송하지 않는다. 먼저 `canvas:attach`에서 자신의 state vector를 보내고 서버 state vector를 받은 뒤, `Y.encodeStateAsUpdate(clientDoc, serverStateVector)`로 서버에 없는 변경만 계산한다.

이 방식은 장애 시점에 따라 서로 다른 결과를 만든다.

## 시나리오 1: DB 저장 전 서버 종료

Backend A의 flush 주기를 테스트에서 길게 설정하고, update가 메모리 buffer에 들어간 직후 프로세스를 강제 종료한다.

```text
Client local update
  → IndexedDB outbox 저장
  → Backend A memory buffer
  → SIGKILL (DB commit 전)
  → Backend B attach
  → state vector 비교
  → 누락 diff 재구성
  → Backend B DB commit
  → persisted ack
```

Backend A는 lifecycle hook을 실행하지 못하므로 원래 update ID의 receipt와 update log는 생성되지 않는다. Backend B에 재접속하면 서버 state vector가 해당 변경을 포함하지 않으므로 클라이언트는 누락 diff를 새 update ID로 만들고 outbox를 교체한다.

Backend B가 이 diff를 저장하고 `persisted` ack를 보내면 outbox를 비운다. 최종 검증 클라이언트는 PostgreSQL에서 복원한 Y.Doc에서 장애 전 로컬 변경을 확인한다.

## 시나리오 2: DB 저장 후 ack 전 서버 종료

테스트 전용 broadcaster는 Backend A의 DB commit과 room broadcast가 끝난 직후, Gateway가 ack를 보내기 전에 송신 연결을 끊는다. 이어서 Backend A 프로세스를 강제 종료한다.

```text
Client local update
  → IndexedDB outbox 저장
  → Backend A DB commit
  → 연결 종료 (ack 유실)
  → Backend A SIGKILL
  → Backend B attach
  → server state vector에 변경 포함
  → 누락 diff 없음
  → outbox 제거
```

클라이언트는 ack를 받지 못했지만 Backend B가 PostgreSQL에서 구성한 server state vector에는 이미 변경이 들어 있다. 따라서 누락 diff가 생성되지 않고 outbox를 비우며, 같은 변경을 다시 저장하지 않는다.

이 경로에서도 receipt와 update log는 각각 하나만 남고 신규 검증 클라이언트가 같은 Y.Doc 상태를 복원한다.

## 왜 기존 update ID를 무조건 재전송하지 않는가

durable receipt는 같은 update ID의 재전송도 안전하게 처리한다. 하지만 재접속 시점에는 서버 state vector로 실제 누락 여부를 먼저 확인할 수 있다.

```text
서버에 변경 없음 → client-only diff를 새 durable update로 저장
서버에 변경 있음 → 전송 없이 outbox 제거
```

이를 통해 ack 유실 상황에서 불필요한 transaction과 duplicate ack를 줄인다. 동일 update ID가 두 인스턴스에 동시에 도착하는 경합 자체는 이전 분산 정합성 E2E에서 별도로 검증한다.

## E2E 구성

테스트는 다음 요소를 한 프로세스에 모킹하지 않고 독립적으로 실행한다.

- Backend A child process
- Backend B child process
- 두 서버가 공유하는 PostgreSQL과 Redis
- 장애 후 target을 Backend B로 변경하는 stable TCP proxy
- fake IndexedDB에 저장되는 Y.Doc과 outbox
- Backend A에 전달하는 실제 `SIGKILL`

실행 명령은 다음과 같다.

```bash
DATABASE_URL='postgresql://myuser:mypassword@localhost:55432/mydb?schema=public' \
REDIS_URL='redis://localhost:56379' \
pnpm --filter backend test:e2e:failover
```

2026-07-07 기준으로 다음 검증을 통과했다.

- DB commit 전 Backend A 강제 종료 후 Backend B에서 누락 diff 저장
- DB commit 후 ack 유실과 Backend A 강제 종료 후 state vector 기반 outbox 정리
- 각 시나리오에서 receipt와 update log가 논리적으로 한 번만 생성
- 장애 후 신규 접속 클라이언트가 PostgreSQL에서 최종 Y.Doc 복원
- 동일한 proxy URL을 통해 Backend A에서 Backend B로 연결 대상 전환

## 보장 범위

이번 E2E는 애플리케이션 인스턴스 하나의 프로세스 장애와 클라이언트 복구 프로토콜을 검증한다. TCP proxy는 Nginx의 stable endpoint와 upstream 재선택 역할을 테스트 안에서 결정적으로 재현한다.

다음 항목은 별도 인프라 검증 범위다.

- Nginx 프로세스 자체 장애
- PostgreSQL 또는 Redis 장애와 복제·복구
- 여러 가용 영역 사이의 네트워크 단절
- 운영 환경의 reconnect backoff와 timeout 튜닝
