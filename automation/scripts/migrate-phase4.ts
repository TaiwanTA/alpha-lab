#!/usr/bin/env bun
// automation/scripts/migrate-phase4.ts
//
// One-shot CLI entry point for applying the Phase 4 event-ledger schema.
// Dagu will invoke this as a DAG step before any Phase 4 worker starts:
//   bun run scripts/migrate-phase4.ts
//
// Requires DATABASE_URL. Idempotent — the migration itself uses
// CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, and the
// schema_migrations upsert skips already-applied versions.

import { applyMigration, closeDb } from "./phase4/db.ts";

async function main(): Promise<void> {
  try {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(2);
    }
    await applyMigration();
    console.log(JSON.stringify({ ok: true, migration: "001_phase4_event_ledger" }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`migrate-phase4 failed: ${message}`);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  await main();
}