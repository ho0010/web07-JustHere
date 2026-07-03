-- 기존 state_vector는 문서 보유 범위만 나타내며 Y.Doc을 복원할 수 없다.
-- 현재 구현에서 사용하지 않던 데이터이므로 update log를 원본으로 남기고
-- 복원 불가능한 snapshot metadata만 제거한다.
DELETE FROM "category_snapshots";

ALTER TABLE "category_snapshots"
RENAME COLUMN "state_vector" TO "snapshot_data";

ALTER TABLE "category_snapshots"
ADD COLUMN "last_log_id" BIGINT NOT NULL;
