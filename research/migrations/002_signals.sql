-- 002_signals.sql
-- 市場訊號(signals)表 — B/C/D agent 層的實體儲存
--   詳見 docs/ADR-001-pipeline-redesign.md(Step 1 of ABCD build)
--
-- 設計原則:
--   * status 用 TEXT + CHECK 而非 enum — 加狀態免 migration
--   * slug 可空 — 訊號可能尚未命名就被發現
--   * source_items 放 external_ids 跨 items 表(用 TEXT[] 不加 FK,允許 source_items 指向 items
--     尚未同步進來、或來自非 items 表的 source)
--   * gen_random_uuid() 是 PG 13+ core function,不需要 pgcrypto extension

CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE,                -- url-friendly name,nullable
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  importance    SMALLINT NOT NULL,          -- 1..5,5 最重要
  status        TEXT NOT NULL,              -- discovered / tracking / matured / faded / invalid
  tags          TEXT[] NOT NULL DEFAULT '{}',
  source_items  TEXT[] NOT NULL DEFAULT '{}',  -- 對應 items.external_id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signals_importance_range CHECK (importance BETWEEN 1 AND 5),
  CONSTRAINT signals_status_valid CHECK (status IN ('discovered','tracking','matured','faded','invalid'))
);

CREATE INDEX IF NOT EXISTS signals_status ON signals (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS signals_importance ON signals (importance DESC, created_at DESC) WHERE importance >= 4;
CREATE INDEX IF NOT EXISTS signals_tags_gin ON signals USING GIN (tags);
