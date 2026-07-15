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
//
// The script never calls process.exit before closeDb() has run: it
// throws on missing config / migration failure, the unhandled error
// propagates as a non-zero exit, and the `finally` block awaits
// closeDb() so the connection pool is flushed before the process dies.

import { applyMigration, closeDb } from "./phase4/db.ts";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  await applyMigration();
  console.log(
    JSON.stringify({ ok: true, migration: "001_phase4_event_ledger" }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`migrate-phase4 failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}