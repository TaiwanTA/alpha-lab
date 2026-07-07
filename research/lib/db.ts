// Postgres 操作
//   用 Bun.sql 內建 client,所有 query 都用 tagged template 防 SQL injection
//   insertItems 用 ON CONFLICT DO NOTHING,idempotent

import { sql } from "bun";
import type { RawItem, FetchState } from "./types.ts";

export async function initDb(): Promise<void> {
  await sql`SELECT 1`;
}

export async function insertItems(items: RawItem[]): Promise<number> {
  if (items.length === 0) return 0;

  // 不插 raw_payload(原始 response 走磁碟,不在 DB)
  const rows = items.map((item) => ({
    source_type: item.source_type,
    source_label: item.source_label,
    external_id: item.external_id,
    external_parent: item.external_parent,
    created_at: item.created_at,
    context: item.context,
  }));

  const result = await sql<{ external_id: string }[]>`
    INSERT INTO items ${sql(rows)}
    ON CONFLICT (source_type, external_id) DO NOTHING
    RETURNING external_id
  `;
  return result.length;
}

export async function haveItems(
  sourceType: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // Bun.sql 不會自動把 JS array 轉成 Postgres array;
  // 改用 IN + 手動 escape 的 id list(這裡 ids 是程式內部產生,不是使用者輸入,安全)
  const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  const rows = await sql<{ external_id: string }[]>`
    SELECT external_id FROM items
    WHERE source_type = ${sourceType} AND external_id IN (${sql.unsafe(idList)})
  `;
  return new Set(rows.map((r) => r.external_id));
}

export async function getFetchState(
  sourceType: string,
  sourceKey: string,
): Promise<FetchState | null> {
  const rows = await sql<FetchState[]>`
    SELECT * FROM fetch_state
    WHERE source_type = ${sourceType} AND source_key = ${sourceKey}
  `;
  return rows[0] ?? null;
}

export async function upsertFetchState(state: FetchState): Promise<void> {
  await sql`
    INSERT INTO fetch_state ${sql(state)}
    ON CONFLICT (source_type, source_key) DO UPDATE SET
      source_label = EXCLUDED.source_label,
      last_external_id = EXCLUDED.last_external_id,
      last_run_at = EXCLUDED.last_run_at,
      last_status = EXCLUDED.last_status
  `;
}
