# Socket.IO room을 Redis로 공유해 다중 NestJS 인스턴스로 확장하기

## 목표

기존 Socket.IO broadcaster는 각 NestJS 프로세스의 `Server`만 사용했다. 같은 room 이름을 사용하더라도 클라이언트가 서로 다른 백엔드 인스턴스에 연결되면 이벤트가 다른 인스턴스로 전달되지 않았다.

이번 작업에서는 Redis Adapter를 NestJS의 전역 WebSocket adapter로 연결하고, Nginx 뒤에 두 백엔드 인스턴스를 실행할 수 있는 로컬 환경을 추가한다.

```text
Client
  ↓
Nginx
  ├─ Backend A ─┐
  └─ Backend B ─┴─ Redis
          ↓
      PostgreSQL
```

이번 단계의 범위는 **Socket.IO room의 인스턴스 간 전달**이다. 각 프로세스의 `CanvasService`가 보유한 Y.Doc과 update buffer의 정합성은 다음 `feat/yjs-distributed-consistency` 작업에서 다룬다. Redis Adapter가 이벤트를 전달한다고 서버 메모리의 Y.Doc까지 자동으로 동기화되는 것은 아니다.

## 구현

- `REDIS_URL`이 있으면 publisher/subscriber Redis 연결을 만들고 모든 Socket.IO namespace에 Redis Adapter를 적용한다.
- `REDIS_URL`이 없으면 기존 in-memory adapter를 사용해 단일 서버 개발과 단위 테스트를 유지한다.
- `REDIS_URL`이 설정됐지만 연결할 수 없으면 서버 시작을 실패시킨다. Redis 없이 여러 인스턴스를 실행해 일부 room 이벤트를 조용히 누락시키는 것보다 명시적으로 실패하는 편을 선택했다.
- 애플리케이션 종료 시 publisher/subscriber 연결을 함께 닫는다.

## 로컬 실행

PostgreSQL migration을 먼저 적용한다.

```bash
docker compose -f docker-compose.multi-instance.yml up -d postgres redis
DATABASE_URL='postgresql://myuser:mypassword@localhost:55432/mydb?schema=public' \
  pnpm --filter backend exec prisma migrate deploy
docker compose -f docker-compose.multi-instance.yml up --build
```

접속 주소는 다음과 같다.

| 대상                | 주소                      |
| ------------------- | ------------------------- |
| Nginx               | `http://localhost:3100`   |
| Backend A 직접 연결 | `http://localhost:3101`   |
| Backend B 직접 연결 | `http://localhost:3102`   |
| Grafana             | `http://localhost:3300`   |
| Prometheus          | `http://localhost:39090`  |
| Redis               | `redis://localhost:56379` |

Backend A/B의 포트에 테스트 클라이언트를 직접 연결하면 두 클라이언트가 서로 다른 인스턴스에 배치됐음을 확실하게 통제할 수 있다.

## 교차 인스턴스 E2E

테스트는 동일 프로세스에서 서로 다른 포트의 Nest 애플리케이션 두 개를 실행한다. 각 애플리케이션은 같은 Redis를 사용하는 독립적인 Socket.IO Server를 가진다.

```text
Client A → Backend A → room join
Client B → Backend B → 같은 room join
Client A → publish
Redis Adapter → Backend B의 Client B에게 broadcast
```

실행 명령은 다음과 같다.

```bash
REDIS_URL=redis://localhost:56379 pnpm --filter backend test:e2e:multi-instance
```

CI에서는 Redis service를 함께 실행해 PR마다 교차 인스턴스 room 전달을 검증한다.

## 검증 결과

2026-07-06 기준으로 다음 검증을 통과했다.

- 서로 다른 임의 포트에서 실행한 NestJS 인스턴스 2개가 같은 Redis에 연결
- 각 인스턴스에 WebSocket 전용 Socket.IO 클라이언트를 하나씩 직접 연결
- 두 클라이언트가 같은 room에 참여한 뒤 Backend A의 이벤트를 Backend B의 클라이언트가 수신
- Redis 연결 생성·실패·종료 단위 테스트 3개 통과
- backend 단위 테스트 34개 suite, 349개 테스트 통과
- backend TypeScript build와 ESLint 통과
- `docker compose config`를 이용한 다중 인스턴스 Compose 구성 검증

교차 인스턴스 E2E는 테스트 전용 Gateway로 Redis Adapter의 room 전달 경계를 검증한다. 실제 Canvas Y.Doc과 PostgreSQL 정합성은 이번 테스트가 보장하지 않으며 다음 분산 정합성 작업에서 별도 E2E로 다룬다.

## 보장 범위

이번 작업으로 보장하는 것은 서로 다른 NestJS 인스턴스에 연결된 Socket.IO 클라이언트가 같은 room 이벤트를 수신하는 것이다.

아직 보장하지 않는 항목은 다음과 같다.

- Backend A/B의 in-memory Y.Doc 상태 일치
- 두 인스턴스가 같은 update ID를 동시에 저장할 때의 transaction retry
- snapshot compaction의 인스턴스 간 실행 조정
- 한 백엔드가 강제 종료됐을 때 다른 인스턴스로 재접속하는 전체 복구 흐름

이 항목들은 각각 분산 정합성 작업과 최종 failover E2E에서 검증한다.
