import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const MIGRATION = readFileSync(
  join(HERE, "..", "migrations", "002_signal_layer.sql"),
  "utf8",
);

describe("002_signal_layer.sql migration", () => {
  test("renames signal_events to items", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE signal_events RENAME TO items/);
  });

  test("creates signals table with required columns", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS signals/);
    expect(MIGRATION).toMatch(/title text NOT NULL/);
    expect(MIGRATION).toMatch(/description text NOT NULL/);
    expect(MIGRATION).toMatch(/priority text NOT NULL CHECK\(priority IN \('high','low'\)\)/);
    expect(MIGRATION).toMatch(/archived_at timestamptz/);
  });

  test("creates signal_items many-to-many table", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS signal_items/);
    expect(MIGRATION).toMatch(/PRIMARY KEY\(signal_id, item_id\)/);
    expect(MIGRATION).toMatch(/relation text CHECK\(relation IN/);
  });

  test("adds classified_at + classification_result to items", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN.*classified_at timestamptz/);
    expect(MIGRATION).toMatch(/ADD COLUMN.*classification_result jsonb/);
  });

  test("drops status column after dropping its dependent index", () => {
    const dropIndexPos = MIGRATION.indexOf("DROP INDEX IF EXISTS signal_events_research_queue");
    const dropColPos = MIGRATION.indexOf("DROP COLUMN IF EXISTS status");
    expect(dropIndexPos).toBeGreaterThan(-1);
    expect(dropColPos).toBeGreaterThan(dropIndexPos);
  });

  test("renames event_id to signal_id in research_runs + paper_bets", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE research_runs RENAME COLUMN event_id TO signal_id/);
    expect(MIGRATION).toMatch(/ALTER TABLE paper_bets RENAME COLUMN event_id TO signal_id/);
  });

  test("rebuilds FK constraints pointing to signals", () => {
    expect(MIGRATION).toMatch(/research_runs_signal_id_fkey/);
    expect(MIGRATION).toMatch(/REFERENCES signals\(id\)/);
  });

  test("adds published_path to research_runs", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN.*published_path text/);
  });

  test("rebuilds unique index on signal_id", () => {
    expect(MIGRATION).toMatch(/DROP INDEX IF EXISTS research_runs_event_active_unique/);
    expect(MIGRATION).toMatch(/research_runs_signal_active_unique/);
  });

  test("creates signal + items utility indexes", () => {
    expect(MIGRATION).toMatch(/CREATE INDEX.*signals_active/);
    expect(MIGRATION).toMatch(/CREATE INDEX.*items_unclassified/);
  });
});
