# 오프라인 편집부터 서버 재시작 복원까지 하나의 E2E로 검증하기

앞선 작업들은 state vector 재연결 수렴, snapshot compaction, durable ack, IndexedDB 복구를 각각 단위 테스트로 검증했다. 하지만 각 기능이 개별적으로 맞는 것과 실제 장애 흐름 전체가 이어지는 것은 다른 문제다.

이번 작업에서는 클라이언트 로컬 저장소부터 Socket.IO gateway와 PostgreSQL까지 연결한 복구 E2E 시나리오를 추가했다.

## 1. 검증 범위

테스트는 다음 과정을 한 번에 실행한다.

```text
빈 canvas 최초 attach
→ Socket 연결 종료
→ 오프라인에서 Y.Doc에 선 추가
→ IndexedDB 저장
→ 브라우저 세션 종료 및 재생성
→ IndexedDB에서 선 복원
→ 서버 state vector 기준 누락 diff 계산
→ durable outbox 저장
→ y:update 전송
→ PostgreSQL commit 이후 persisted ack
→ ack 유실을 가정하고 outbox를 제거하지 않음
→ 브라우저 세션 다시 재생성
→ 서버 state vector 기준 이미 저장된 pending 제거
→ 백엔드 애플리케이션 완전 종료 및 재생성
→ PostgreSQL update log만으로 서버 Y.Doc 복원
→ 같은 updateId 재전송
→ receipt 기준 duplicate ack
```

이 흐름으로 단순 재연결뿐 아니라 브라우저와 서버 프로세스의 메모리가 모두 사라진 상황을 검증한다.

## 2. 실제 인프라와 대체한 경계를 구분했다

E2E에서 실제로 사용하는 구성은 다음과 같다.

- 실제 NestJS `AppModule`
- 실제 Canvas Socket.IO gateway
- 실제 WebSocket 연결
- 실제 Yjs update와 state vector
- 실제 PostgreSQL transaction, update log, receipt
- 실제 `y-indexeddb` provider

브라우저 IndexedDB 구현만 Node 테스트 환경에서 `fake-indexeddb`로 대체한다. 저장 API와 `y-indexeddb` 동작은 같지만 Chrome 렌더링과 마우스 드로잉 이벤트까지 검증하는 UI E2E는 아니다.

제품의 Yjs local persistence, outbox, state vector 계산은 프론트엔드 단위 테스트에서 검증하고, 이번 테스트는 이 규약이 실제 서버 및 DB와 끝까지 연결되는지를 담당한다.

## 3. durable ack를 DB commit 증거로 사용했다

클라이언트가 `y:update`를 보낸 직후 서버 메모리만 확인하지 않는다. `y:update:ack`의 `persisted` 상태를 기다린 뒤 PostgreSQL을 직접 조회한다.

```text
CategoryUpdateReceipt: 해당 updateId 존재
CategoryUpdateLog: 1개
```

ack를 받았지만 클라이언트 outbox에서 제거하지 않아 ack 유실 상황을 만든다. 다음 접속에서는 서버 state vector에 변경이 이미 포함되어 있으므로 client diff가 비어 있고, 오래된 pending outbox를 제거한다.

## 4. 서버 재시작을 새 AppModule로 재현했다

첫 번째 Nest 애플리케이션을 완전히 종료한 뒤 새로운 AppModule과 CanvasService를 생성한다. 메모리 Y.Doc과 최근 receipt cache는 모두 사라진다.

빈 검증용 Y.Doc으로 다시 attach했을 때 PostgreSQL update log에서 선이 복원되는지 확인한다. 이어서 서버 재시작 전과 같은 updateId를 보내고 DB receipt가 `duplicate`로 처리하는지 확인한다.

따라서 테스트 성공은 다음 두 사실을 함께 의미한다.

- 문서 내용이 서버 메모리가 아니라 PostgreSQL에서 복원됨
- 멱등 처리 근거가 서버의 최근 메모리 cache가 아니라 PostgreSQL receipt에도 남아 있음

## 5. 테스트 격리

각 실행마다 UUID 기반 room, category, line, update ID를 생성한다. 완료 후 room을 삭제하면 relation의 cascade 규칙으로 category, update log, receipt, snapshot도 함께 정리된다.

IndexedDB도 테스트 완료 후 `clearData`로 삭제한다. 테스트 fixture는 기존 로컬 방과 category를 수정하지 않는다.

## 6. 실행 방법

로컬 PostgreSQL을 실행하고 migration을 적용한다.

```bash
docker compose -f docker-compose.local.yml up -d postgres
pnpm --filter backend exec prisma migrate deploy
pnpm --filter backend test:e2e:recovery
```

CI pull request job에도 PostgreSQL 15 service와 같은 실행 단계를 추가했다. 단위 테스트와 빌드가 성공하더라도 복구 E2E가 실패하면 CI가 통과하지 않는다.

## 7. 테스트이 목적

이번 테스트의 목적은 **브라우저 로컬 복구 규약, Socket 재연결 규약, durable ack, PostgreSQL 복원이 하나의 장애 흐름에서 끊기지 않는지 PR마다 자동으로 검증하는 것**이다.
