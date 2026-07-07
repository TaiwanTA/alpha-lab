-- 001_init.sql
-- 初始 schema:
--   items        統一儲存所有來源的單一資料項
--   fetch_state  追蹤每個 source 上次抓到哪
--
-- 設計原則:
--   * context 是 adapter 渲染過、LLM 可讀的文字
--   * 原始 response 走磁碟 JSONL(在 raw/),不在 DB
--   * source_type / source_label 是 free-form TEXT,加新來源不需改 schema

CREATE TABLE IF NOT EXISTS items (
  source_type      TEXT NOT NULL,         -- 'x_user_timeline' | 'reddit_subreddit' | 'sec_13f' | ...
  source_label     TEXT NOT NULL,         -- @username / r/x / "Pershing Square"
  external_id      TEXT NOT NULL,         -- upstream 的 item id
  external_parent  TEXT,                  -- reply / thread 父層的 external_id,null 表示沒有
  created_at       TIMESTAMPTZ NOT NULL,  -- item 原始建立時間
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  context          TEXT NOT NULL,         -- adapter 渲染過的 LLM 可讀文字
  PRIMARY KEY (source_type, external_id)
);

CREATE INDEX IF NOT EXISTS items_label_time ON items (source_label, created_at DESC);
CREATE INDEX IF NOT EXISTS items_type_time ON items (source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS items_parent ON items (external_parent) WHERE external_parent IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_context_tsv ON items USING GIN (to_tsvector('simple', context));

CREATE TABLE IF NOT EXISTS fetch_state (
  source_type       TEXT NOT NULL,
  source_key        TEXT NOT NULL,        -- upstream stable id(例如 X 的 numeric user id)
  source_label      TEXT NOT NULL,        -- human-readable,可能會變
  last_external_id  TEXT,                 -- 最後一次成功抓到的 item id,給下次 boundary 用
  last_run_at       TIMESTAMPTZ,
  last_status       TEXT,                 -- 'ok' | 'failed' | 'partial'
  PRIMARY KEY (source_type, source_key)
);
