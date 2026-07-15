#!/usr/bin/env bun
// automation/scripts/ingest-events.ts
//
// Phase 4 Task 2 ingestion CLI. Dagu's `ingest-events` DAG step
// invokes this script on a six-hourly cadence. The CLI loads the
// checked-in `automation/config/investor-sources.yaml` registry,
// resolves each enabled X handle to a numeric user id, walks the
// timeline from `source_checkpoints.newest_post_id` (if any) until
// X's opaque `meta.next_token` is exhausted, and persists every
// tweet into `signal_events` together with the X post URL.
//
// Each source is committed inside its own Postgres transaction:
// every `INSERT INTO signal_events` and the
// `UPDATE source_checkpoints SET newest_post_id = …` happen in
// one statement group, so a crash mid-source can never advance
// the checkpoint past un-inserted rows. Duplicates are absorbed
// by the UNIQUE(investor, source_url, published_at, content_hash)
// constraint — Task 1's EventRecord.insert path silently ignores
// the conflict by relying on the SQL to no-op on a re-run.
//
// Exit discipline mirrors `migrate-phase4.ts`: throw on any
// precondition failure (no DATABASE_URL, missing YAML, malformed
// registry, X HTTP error), set `process.exitCode = 1` in catch,
// and `await closeDb()` in `finally` so the connection pool is
// always flushed before the process dies.

import { SQL } from "bun";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  IngestXClient,
  parseInvestorSources,
  toPostUrl,
  type InvestorSource,
} from "./phase4/x-client.ts";

import { db, closeDb } from "./phase4/db.ts";

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

/** Absolute path to the checked-in Task 2 registry. Dagu runs this
 *  CLI inside `workspace/app/automation`, so we anchor the lookup
 *  against `import.meta.url` rather than `process.cwd()`. */
const REGISTRY_PATH = new URL(
  "../config/investor-sources.yaml",
  import.meta.url,
).pathname;

/** Cast given to every X timeline tweet inserted into the ledger.
 *  Task 1's schema CHECK-constrains signal_events.signal_type to
 *  the single value 'public_event' so there is no other choice. */
const X_SIGNAL_TYPE = "public_event" as const;

// ---------------------------------------------------------------------------
// Lightweight HTTP client that adapts a `fetch`-shaped function to
// the `XApiClient` interface `IngestXClient` expects. We use Bun's
// global `fetch` so this CLI works under both the native and the
// containerized Dagu runtime without an HTTP library.
// ---------------------------------------------------------------------------

const fetchClient: { fetch(url: string, init?: RequestInit): Promise<Response> } = {
  async fetch(url, init) {
    return await fetch(url, init);
  },
};

// ---------------------------------------------------------------------------
// Single-source transaction.
// ---------------------------------------------------------------------------

/** Per-source checkpoint row, exactly the shape of `source_checkpoints`
 *  plus the optional `newest_post_id` cursor. */
type SourceCheckpointRow = {
  source_key: string;
  x_user_id: string;
  newest_post_id: string | null;
};

/** Persist `events` (already filtered to active / dedup-safe rows)
 *  and advance the `source_checkpoints.newest_post_id` cursor in a
 *  single Postgres transaction. Returns the number of *new* rows
 *  inserted (rows that hit the UNIQUE constraint are silently
 *  skipped via ON CONFLICT DO NOTHING).
 *
 *  `tx` is the Bun SQL transaction handle yielded by `db.begin(...)`.
 *  We accept the `SQL` instance from the caller so a future Task
 *  can substitute a test-time `SQL` (e.g. via `LedgerDb.db`). */
async function commitSourceBatch(
  tx: SQL,
  source: InvestorSource,
  xUserId: string,
  checkpointRow: SourceCheckpointRow | null,
  events: ReadonlyArray<{
    id: string;
    text: string;
    createdAt: Date;
  }>,
): Promise<{ inserted: number; cursor: string | null }> {
  if (events.length === 0) {
    // Even with zero rows we still upsert the (x_user_id, handle)
    // pair so the checkpoint row exists for future runs.
    await tx`
      INSERT INTO source_checkpoints ${tx({
        source_key: source.key,
        x_user_id: xUserId,
        newest_post_id: checkpointRow?.newest_post_id ?? null,
      })}
      ON CONFLICT (source_key) DO UPDATE
        SET x_user_id = EXCLUDED.x_user_id,
            updated_at = now()
    `;
    return { inserted: 0, cursor: checkpointRow?.newest_post_id ?? null };
  }

  // Newest first: events arrive in reverse chronological order from
  // X, so the first row holds the newest id we have ever captured.
  // We persist that as the new cursor; on a re-run the next
  // `since_id` is strictly greater than every row already in the
  // ledger, so the UNIQUE constraint will silently absorb any
  // duplicates the upstream API returns.
  const newestId = events[0]?.id ?? null;

  for (const tweet of events) {
    const contentHash = await sha256Utf8(tweet.text);
    await tx`
      INSERT INTO signal_events ${tx({
        id: crypto.randomUUID(),
        source_key: source.key,
        investor: source.investor,
        signal_type: X_SIGNAL_TYPE,
        source_url: toPostUrl(source.handle, tweet.id),
        published_at: tweet.createdAt,
        content_hash: contentHash,
        raw_content: tweet.text,
        payload: { tweet_id: tweet.id, x_user_id: xUserId },
      })}
      ON CONFLICT (investor, source_url, published_at, content_hash) DO NOTHING
    `;
  }

  await tx`
    INSERT INTO source_checkpoints ${tx({
      source_key: source.key,
      x_user_id: xUserId,
      newest_post_id: newestId,
    })}
    ON CONFLICT (source_key) DO UPDATE
      SET x_user_id = EXCLUDED.x_user_id,
          newest_post_id = EXCLUDED.newest_post_id,
          updated_at = now()
  `;

  return { inserted: events.length, cursor: newestId };
}

/** SHA-256 over the UTF-8 bytes of `text`, returned as lowercase
 *  hex. We expose this as a tiny helper because Bun's Web Crypto
 *  `crypto.subtle.digest` is async; a wrapper documents intent. */
async function sha256Utf8(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read the source's existing `source_checkpoints` row, or null
 *  if this is the first ingestion run for the source. */
async function loadCheckpoint(
  sourceKey: string,
): Promise<SourceCheckpointRow | null> {
  const rows = await db<SourceCheckpointRow[]>`
    SELECT source_key, x_user_id, newest_post_id
    FROM source_checkpoints
    WHERE source_key = ${sourceKey}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Per-source pipeline.
// ---------------------------------------------------------------------------

type SourceRunResult = {
  key: string;
  handle: string;
  inserted: number;
  cursor: string | null;
};

/** Walk a single enabled source: lookup the numeric X user id
 *  (or trust the cached value from a prior run), then walk the
 *  timeline. Everything happens in one transaction per source so
 *  a failure mid-source leaves the checkpoint cursor untouched. */
async function ingestSource(
  client: IngestXClient,
  source: InvestorSource,
): Promise<SourceRunResult> {
  const checkpoint = await loadCheckpoint(source.key);
  const xUserId = checkpoint?.x_user_id ?? (await client.lookupUserId(source.handle));
  const sinceId = checkpoint?.newest_post_id ?? undefined;

  const tweets: Array<{ id: string; text: string; createdAt: Date }> = [];
  for await (const tweet of client.fetchTimeline(xUserId, sinceId)) {
    tweets.push(tweet);
  }

  return await db.begin(async (tx) => {
    const { inserted, cursor } = await commitSourceBatch(
      tx as unknown as SQL,
      source,
      xUserId,
      checkpoint,
      tweets,
    );
    return { key: source.key, handle: source.handle, inserted, cursor };
  });
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

export type IngestSummary = {
  ok: true;
  registryPath: string;
  sources: ReadonlyArray<SourceRunResult>;
};

async function main(): Promise<IngestSummary> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (!process.env.X_BEARER_TOKEN) {
    throw new Error("X_BEARER_TOKEN is required");
  }

  const yamlPath = resolve(REGISTRY_PATH);
  const yamlText = await readFile(yamlPath, "utf8");
  const registry = parseInvestorSources(yamlText);

  const client = new IngestXClient(fetchClient);
  const results: SourceRunResult[] = [];
  for (const source of registry.sources) {
    const result = await ingestSource(client, source);
    results.push(result);
  }

  const summary: IngestSummary = {
    ok: true,
    registryPath: yamlPath,
    sources: results,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ingest-events failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
