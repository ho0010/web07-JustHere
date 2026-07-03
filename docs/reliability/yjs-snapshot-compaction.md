# 누적되는 Yjs update log를 snapshot으로 안전하게 압축하기

앞선 작업에서는 재접속한 클라이언트와 서버가 state vector를 교환해 서로의 누락 변경을 보완하도록 만들었다. 이번에는 서버가 재시작될 때 문서를 복원하는 DB 경로를 살펴봤다.

기존 서버는 5초 동안 모은 Yjs update를 하나로 병합해 `category_update_logs`에 추가했다. 실행 중에는 메모리의 Y.Doc을 사용하므로 문제가 드러나지 않지만, 서버가 재시작되면 해당 카테고리의 모든 로그를 조회하고 다시 병합해야 했다. 서비스가 오래 실행될수록 로그 행과 초기 복원 비용이 계속 증가하는 구조였다.

이번 작업에서는 일정 개수의 update log를 복원 가능한 전체 상태 update로 압축하고, snapshot에 실제로 포함한 로그만 트랜잭션 안에서 삭제하도록 변경했다.

## 1. state vector는 snapshot이 아니다

기존 `CategorySnapshot`에는 `stateVector` 필드만 있었다. 하지만 state vector는 Y.Doc의 내용을 담고 있지 않다. 각 Yjs client가 만든 struct를 상대방이 어디까지 알고 있는지 표현하는 비교용 메타데이터다.

따라서 state vector만 DB에 저장해서는 포스트잇, 선, 텍스트 등의 문서 내용을 복원할 수 없다. 이번 마이그레이션에서는 사용되지 않던 기존 snapshot metadata를 제거하고 다음 구조로 바꿨다.

```text
CategorySnapshot
├─ categoryId
├─ snapshotData  // Y.Doc을 복원할 수 있는 전체 Yjs update
├─ lastLogId     // 마지막으로 snapshot에 포함한 로그 ID
└─ updatedAt
```

여기서 snapshot은 Yjs API의 특정 시점 조회 기능인 `Y.Snapshot`이 아니라, 서버 복원을 위한 **전체 상태 update**를 의미한다.

## 2. 복원 경로를 snapshot + 잔여 로그로 변경했다

기존 복원 경로는 모든 update log를 읽었다.

```text
update 1 + update 2 + ... + update N
→ Y.mergeUpdates
→ Y.Doc 복원
```

변경 후에는 snapshot을 먼저 적용하고 아직 압축되지 않은 로그만 함께 병합한다.

```text
snapshot + remaining update logs
→ Y.mergeUpdates
→ Y.Doc 복원
```

snapshot이 아직 없는 카테고리는 기존처럼 update log만 사용하므로 점진적으로 전환할 수 있다.

snapshot과 로그를 서로 다른 시점에서 조회하면 compaction이 두 조회 사이에 완료될 때 이전 snapshot과 이미 삭제된 로그 조합을 받을 수 있다. 복원 조회는 `REPEATABLE READ` transaction으로 묶어 두 데이터가 같은 DB 시점을 보도록 했다.

## 3. 100개의 DB 로그마다 compaction을 시도한다

서버는 5초 flush가 성공한 뒤 해당 카테고리에 100개 이상의 DB 로그가 쌓였는지 확인한다. 이 로그 하나는 개별 사용자 이벤트 하나가 아니라, 한 번의 flush에서 여러 update를 합친 결과다.

임계값보다 적으면 아무 작업도 하지 않는다. 임계값에 도달하면 기존 snapshot과 조회한 로그를 다시 하나의 Yjs update로 병합한다.

```ts
const snapshotData = Y.mergeUpdates([previousSnapshot, ...capturedLogs])
```

매 update마다 snapshot을 다시 만드는 비용을 피하면서, 복원 시 읽어야 하는 로그 행 수를 제한하기 위한 기준이다.

## 4. 단순 범위 삭제 대신 포함한 로그 ID만 삭제한다

compaction이 로그를 읽은 뒤에도 실시간 편집은 계속될 수 있다. 새 로그가 snapshot 계산 이후 DB에 저장됐다면 그 로그는 삭제하면 안 된다.

처음에는 마지막으로 조회한 ID를 cutoff로 두고 `id <= cutoff`를 삭제하는 방법을 고려했다. 하지만 PostgreSQL sequence ID의 발급 순서와 트랜잭션 commit 순서는 항상 같지 않다.

```text
트랜잭션 A: ID 105 발급, 아직 commit 전
트랜잭션 B: ID 106 발급 및 commit
compaction: ID 106은 조회하지만 105는 아직 조회하지 못함
트랜잭션 A: ID 105 commit
```

이 상태에서 `id <= 106`을 삭제하면 snapshot에 포함하지 못한 ID 105까지 삭제할 수 있다. 그래서 실제로 조회하고 병합한 ID 배열만 삭제한다.

```ts
await transaction.categoryUpdateLog.deleteMany({
  where: {
    categoryId,
    id: { in: compactedLogIds },
  },
})
```

`lastLogId`는 어느 시점까지 압축했는지 기록하는 기준으로 남기지만, 복원 시에는 ID 범위만 믿지 않고 DB에 남아 있는 모든 로그를 snapshot과 병합한다. Yjs update는 중복 적용에 안전하므로 성능보다 데이터 보존을 우선한 선택이다.

## 5. snapshot 저장과 로그 삭제를 원자적으로 묶었다

snapshot 저장과 기존 로그 삭제가 따로 실행되면 다음 실패가 가능하다.

```text
snapshot 저장 실패
→ 기존 로그 삭제 성공
→ 문서를 복원할 원본 유실
```

두 DB 변경을 Prisma transaction으로 묶어 하나라도 실패하면 모두 롤백되도록 했다.

```text
BEGIN
  snapshot upsert
  captured update logs delete
COMMIT
```

update log 저장은 성공했지만 compaction만 실패한 경우에는 이미 저장된 update를 메모리 버퍼에 다시 넣지 않는다. 원본 로그가 그대로 남아 있으므로 데이터 유실이 아니며, 다음 flush에서 compaction을 다시 시도할 수 있다. 버퍼에 복구하면 동일 update를 DB에 중복 저장하게 되므로 저장 실패와 압축 실패를 분리해서 처리했다.

## 6. 검증한 시나리오

- snapshot이 없는 문서를 기존 update log만으로 복원
- 기존 snapshot과 이후 update log를 함께 적용해 최신 문서 복원
- 임계값 미만에서는 compaction을 생략
- 기존 snapshot과 조회한 로그를 새로운 snapshot으로 병합
- snapshot에 포함한 로그 ID만 삭제
- 삭제 정보만 담긴 Yjs delete update 보존
- transaction 실패를 호출자에게 전달
- DB flush 실패 시 메모리 버퍼 복구
- compaction 실패 시 저장 완료된 update를 중복 버퍼링하지 않음

실제 로컬 PostgreSQL에서는 별도 fixture category에 100개의 Yjs update log를 저장한 뒤 compaction을 수행했다. 기존 프로젝트 데이터는 건드리지 않고 fixture는 검증 후 cascade 삭제했다.

```text
compaction 대상 로그: 100개
생성된 snapshot: 1개, 1,935B
snapshot 이후 새 로그: 1개
복원된 map entry: 101개
원본/복원 문서 state vector: 일치
```

이는 합성 fixture의 결과이므로 모든 실제 문서의 snapshot이 1,935B가 된다는 의미는 아니다. 이번 검증에서는 transaction이 실제 PostgreSQL에서 동작하고, snapshot 이후 남은 로그까지 적용했을 때 원본 Y.Doc과 같은 상태로 복원되는지를 확인했다.

## 7. 이번 작업이 보장하는 범위

이번 작업은 DB에 영속 저장된 update log의 행 수와 서버 재시작 시 복원 범위를 제한한다. 실시간 편집과 compaction이 겹쳐도 snapshot에 포함하지 않은 로그를 삭제하지 않도록 설계했다.

다만 다음 문제까지 해결한 것은 아니다.

- 5초 flush 전에 서버 프로세스가 강제 종료되는 경우
- 여러 서버 인스턴스가 같은 카테고리를 동시에 압축하는 경우
- 브라우저를 닫은 뒤 클라이언트의 미전송 update 복구
- Yjs 내부 CRDT history 자체의 완전한 제거

다음 단계에서는 서버가 메모리에 update를 적용한 시점과 DB 영속 저장을 완료한 시점을 구분하고, 클라이언트가 durable ack를 받을 때까지 변경을 보존하는 전달 규약을 다룬다.
