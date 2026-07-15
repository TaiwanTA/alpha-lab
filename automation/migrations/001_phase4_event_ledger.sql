-- Phase 4 event ledger schema.
--
-- Immutable ledger for the Phase 4 pipeline:
--   source_checkpoints  — per-source ingest cursor (X newest_post_id, etc.)
--   signal_events       — public_events captured from sources (X timeline, blogs)
--   research_runs       — LLM-driven thesis over a captured event
--   paper_bets          — accepted thesis converted into a paper position
--   bet_outcomes        — final settlement record for a paper bet
--
-- All UUIDs are generated client-side via crypto.randomUUID(); the DB
-- never relies on gen_random_uuid() so repository code can pre-allocate
-- the ID before insert and reference it from sibling rows.
--
-- Status / direction / outcome values are enforced by CHECK constraints
-- rather than enums so the application can add new values without an
-- ALTER TYPE migration. Downstream code MUST keep its TypeScript unions
-- in sync with these CHECK clauses. 'processing' is a transient state
-- owned by a single worker during claim; releaseToActive() restores
-- 'active' if the worker crashes before terminal settlement.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_checkpoints (
  source_key text PRIMARY KEY,
  x_user_id text NOT NULL,
  newest_post_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_events (
  id uuid PRIMARY KEY,
  source_key text NOT NULL,
  investor text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type = 'public_event'),
  source_url text NOT NULL,
  published_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  raw_content text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('active','processing','superseded','rejected')) DEFAULT 'active',
  supersedes_event_id uuid REFERENCES signal_events(id),
  UNIQUE (investor, source_url, published_at, content_hash)
);

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES signal_events(id),
  model text NOT NULL,
  prompt_version text NOT NULL,
  thesis text NOT NULL,
  ticker text,
  direction text CHECK (direction IN ('long','short')),
  confidence numeric(4,3),
  rationale text NOT NULL,
  source_citations jsonb NOT NULL,
  candidate_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('accepted','processing','rejected','needs_review'))
);

CREATE TABLE IF NOT EXISTS paper_bets (
  id uuid PRIMARY KEY,
  research_run_id uuid NOT NULL UNIQUE REFERENCES research_runs(id),
  event_id uuid NOT NULL REFERENCES signal_events(id),
  ticker text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  confidence numeric(4,3) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  entry_session_date date NOT NULL,
  entry_price numeric NOT NULL CHECK (entry_price > 0),
  entry_price_source text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','settled','unresolved','cancelled')) DEFAULT 'open',
  UNIQUE (event_id, ticker)
);

CREATE TABLE IF NOT EXISTS bet_outcomes (
  id uuid PRIMARY KEY,
  paper_bet_id uuid NOT NULL UNIQUE REFERENCES paper_bets(id),
  settled_at timestamptz NOT NULL DEFAULT now(),
  exit_price numeric,
  exit_price_source text,
  return_pct numeric,
  outcome text NOT NULL CHECK (outcome IN ('win','loss','unresolved')),
  reason text
);

CREATE INDEX IF NOT EXISTS signal_events_research_queue
  ON signal_events (captured_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS paper_bets_open
  ON paper_bets (entry_session_date)
  WHERE status = 'open';