CREATE TABLE "category_update_receipts" (
    "category_id" UUID NOT NULL,
    "update_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_update_receipts_pkey" PRIMARY KEY ("category_id", "update_id")
);

CREATE INDEX "category_update_receipts_category_id_created_at_idx"
ON "category_update_receipts"("category_id", "created_at");

ALTER TABLE "category_update_receipts"
ADD CONSTRAINT "category_update_receipts_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "categories"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
