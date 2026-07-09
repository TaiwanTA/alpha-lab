-- 002_signals.sql
-- 市場訊號 (Signal) 實體
--   B agent 從 items 找出值得追蹤的訊號,建立 signal row
--   C agent 對單一 signal 做研究
--   D agent 從所有 active signals 彙整報告

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE,                     -- url-friendly 名稱,用於 blog post URL
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,                   -- 為什麼這是個訊號、值得追蹤的理由
  importance    SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),  -- 1=低 5=最高
  status        TEXT NOT NULL DEFAULT 'discovered',  -- discovered / tracking / matured / faded / invalid
  tags          TEXT[] DEFAULT '{}',             -- 分類標籤,可多個
  source_items  TEXT[] DEFAULT '{}',             -- 引發此訊號的 items.external_id 列表
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signals_status ON signals (status);
CREATE INDEX IF NOT EXISTS signals_importance ON signals (importance DESC);
CREATE INDEX IF NOT EXISTS signals_tags ON signals USING GIN (tags);