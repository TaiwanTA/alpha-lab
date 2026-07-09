-- 004_items_processed_at.sql
-- items 表加 processed_at:NULL = 未被任何 agent 處理過,非 NULL = 已處理過
-- B agent 處理後 SET processed_at = now()
-- 不加 DEFAULT:舊的 items 保持 NULL(下一次 B run 會處理)

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS items_unprocessed
  ON items (created_at DESC)
  WHERE processed_at IS NULL;
