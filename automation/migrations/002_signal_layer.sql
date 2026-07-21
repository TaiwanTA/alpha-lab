-- Signal layer: separate raw items from narrative signal entities.
--
-- This migration:
--   1. Renames signal_events → items (raw data, no longer "events")
--   2. Creates signals table (narrative entities with priority/description/archive)
--   3. Creates signal_items (many-to-many: items ↔ signals)
--   4. Adds classified_at + classification_result to items
--   5. Drops items.status column + its dependent partial index
--   6. Renames research_runs.event_id → signal_id, rebuilds FK to signals
--   7. Adds research_runs.published_path
--   8. Renames paper_bets.event_id → signal_id, rebuilds FK to signals
--   9. Rebuilds unique indexes on research_runs
--   10. Adds indexes for signal queries
--
-- A companion TS script (migrate-signal-layer.ts) runs AFTER this SQL
-- to create legacy 1:1 signals for existing items and remap FKs.

-- 1. Rename signal_events → items
--    如果 public.items 已存在(Mastra 擷取表),先 rename 到 mastra_items
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'items'
  ) THEN
    ALTER TABLE items RENAME TO mastra_items;
    ALTER INDEX IF EXISTS items_pkey RENAME TO mastra_items_pkey;
  END IF;
END $$;

-- Now signal_events can safely be renamed to items
ALTER TABLE signal_events RENAME TO items;

-- Rename constraints/indexes to match new table name
ALTER TABLE items RENAME CONSTRAINT signal_events_pkey TO items_pkey;
ALTER INDEX IF EXISTS signal_events_source_key_key RENAME TO items_source_key_key;
ALTER INDEX IF EXISTS signal_events_investor_source_url_published_at_content_hash_key
  RENAME TO items_investor_source_url_published_at_content_hash_key;

-- 2. Create signals table
--    如果已存在(Mastra 等),先 DROP(只在空表時才安全)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'signals'
  ) THEN
    -- 檢查是否有資料;有資料則中止
    IF EXISTS (SELECT 1 FROM signals LIMIT 1) THEN
      RAISE EXCEPTION 'signals table exists and has data; manual migration required';
    END IF;
    DROP TABLE IF EXISTS signal_items;
    DROP TABLE signals CASCADE;
  END IF;
END $$;

CREATE TABLE signals (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL CHECK(priority IN ('high','low')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- 3. Create signal_items (many-to-many)
CREATE TABLE IF NOT EXISTS signal_items (
  signal_id uuid NOT NULL REFERENCES signals(id),
  item_id uuid NOT NULL REFERENCES items(id),
  relation text CHECK(relation IN ('primary','supporting','context')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(signal_id, item_id)
);

-- 4. Add classification tracking to items
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS classification_result jsonb;

-- 5. Drop items.status column + its dependent partial index
--    (DROP INDEX must come before DROP COLUMN)
DROP INDEX IF EXISTS signal_events_research_queue;
ALTER TABLE items DROP COLUMN IF EXISTS status;
ALTER TABLE items DROP COLUMN IF EXISTS supersedes_event_id;

-- 6. research_runs: event_id → signal_id
ALTER TABLE research_runs RENAME COLUMN event_id TO signal_id;
ALTER TABLE research_runs
  DROP CONSTRAINT IF EXISTS research_runs_event_id_fkey;
ALTER TABLE research_runs
  ADD CONSTRAINT research_runs_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(id);

-- 7. research_runs: add published_path
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS published_path text;

-- 8. paper_bets: event_id → signal_id
ALTER TABLE paper_bets RENAME COLUMN event_id TO signal_id;
ALTER TABLE paper_bets
  DROP CONSTRAINT IF EXISTS paper_bets_event_id_fkey;
ALTER TABLE paper_bets
  ADD CONSTRAINT paper_bets_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(id);

-- 9. Rebuild unique index on research_runs (signal_id instead of event_id)
DROP INDEX IF EXISTS research_runs_event_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS research_runs_signal_active_unique
  ON research_runs (signal_id)
  WHERE status IN ('accepted','processing');

-- 10. Indexes for signal queries
CREATE INDEX IF NOT EXISTS signals_active
  ON signals (priority, updated_at)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS items_unclassified
  ON items (captured_at)
  WHERE classified_at IS NULL;
