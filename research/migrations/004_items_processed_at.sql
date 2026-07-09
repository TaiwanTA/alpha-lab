-- 004_items_processed_at.sql
-- items 表加 processed_at:NULL = 未被任何 agent 處理過,非 NULL = 已處理過
-- B agent 處理後 SET processed_at = now()
-- 不加 DEFAULT:舊的 items 保持 NULL(下一次 B run 會處理)

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Kilo PR #6 WARNING:CREATE INDEX 拿 AccessExclusive lock 會 block 寫入
-- 理想用 CREATE INDEX CONCURRENTLY(不鎖表),但 CONCURRENTLY 不能在
-- transaction 內,而 migrator 用 sql.unsafe(content) 一次跑整個檔案。
-- Bun.sql 預設 auto-commit 非 transaction,理論上 CONCURRENTLY 應該能跑;
-- 但如果未來 migrator 改成包 transaction 這行會炸,fallback 到普通 CREATE INDEX
-- space-vs-lock tradeoff:items 表預期不大(百萬級以下),一次性 lock < 5s 可接受
CREATE INDEX IF NOT EXISTS items_unprocessed
  ON items (created_at DESC)
  WHERE processed_at IS NULL;
