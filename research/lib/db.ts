// Postgres 操作
//   用 Bun.sql 內建 client,所有 query 都用 tagged template 防 SQL injection
//   insertItems 用 ON CONFLICT DO NOTHING,idempotent

import { sql } from "bun";
import type {
  RawItem,
  FetchState,
  Signal,
  NewSignal,
  SignalStatus,
  ItemRow,
} from "./types.ts";

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

// --- Signals ---

export async function insertSignal(signal: NewSignal): Promise<Signal> {
  // Bun.sql 的 sql({...}) 不會把 JS array 轉成 Postgres array literal,
  // 用 sql.unsafe 手動拼(參考 haveItems 已有做法)
  const status = signal.status ?? "discovered";
  validateSignalStatus(status);
  const values = [
    signal.slug === undefined ? "NULL" : signal.slug === null
      ? "NULL"
      : `'${escapeSqlString(signal.slug)}'`,
    `'${escapeSqlString(signal.title)}'`,
    `'${escapeSqlString(signal.description)}'`,
    String(signal.importance ?? 3),
    `'${escapeSqlString(status)}'`,
    `'${pgArrayLiteral(signal.tags ?? [])}'::text[]`,
    `'${pgArrayLiteral(signal.source_items ?? [])}'::text[]`,
  ];
  const rows = await sql.unsafe<Signal[]>(
    `INSERT INTO signals (slug, title, description, importance, status, tags, source_items)
     VALUES (${values.join(", ")})
     RETURNING *`,
  );
  return rows[0]!;
}

export async function getSignalById(id: string): Promise<Signal | null> {
  const rows = await sql<Signal[]>`
    SELECT * FROM signals WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

export async function getSignalsByStatus(status: string): Promise<Signal[]> {
  return await sql<Signal[]>`
    SELECT * FROM signals
    WHERE status = ${status}
    ORDER BY importance DESC, created_at DESC
  `;
}

// active = discovered 或 tracking
export async function getActiveSignals(): Promise<Signal[]> {
  return await sql<Signal[]>`
    SELECT * FROM signals
    WHERE status IN ('discovered', 'tracking')
    ORDER BY importance DESC, created_at DESC
  `;
}

export async function updateSignalStatus(
  id: string,
  status: string,
): Promise<void> {
  validateSignalStatus(status);
  await sql`
    UPDATE signals
    SET status = ${status}, updated_at = now()
    WHERE id = ${id}::uuid
  `;
}

// 用 dynamic SET clause:有給的欄位才更新
// tags / source_items 是 TEXT[],Bun.sql 不會自動轉 JS array → Postgres array,
// 要用 array literal 拼進 SQL(參考 haveItems 已有做法)
export async function updateSignal(
  id: string,
  fields: Partial<NewSignal>,
): Promise<void> {
  if (fields.importance !== undefined) {
    const n = Number(fields.importance);
    if (!Number.isFinite(n) || n < 1 || n > 5 || !Number.isInteger(n)) {
      throw new Error(`importance must be integer in [1, 5], got: ${fields.importance}`);
    }
  }
  if (fields.status !== undefined) {
    validateSignalStatus(fields.status);
  }

  const setClauses: string[] = [];

  if (fields.title !== undefined) {
    setClauses.push(`title = '${escapeSqlString(fields.title)}'`);
  }
  if (fields.description !== undefined) {
    setClauses.push(`description = '${escapeSqlString(fields.description)}'`);
  }
  if (fields.importance !== undefined) {
    setClauses.push(`importance = ${Number(fields.importance)}`);
  }
  if (fields.status !== undefined) {
    setClauses.push(`status = '${escapeSqlString(fields.status)}'`);
  }
  if (fields.slug !== undefined) {
    const v = fields.slug === null ? "NULL" : `'${escapeSqlString(fields.slug)}'`;
    setClauses.push(`slug = ${v}`);
  }
  if (fields.tags !== undefined) {
    setClauses.push(`tags = '${pgArrayLiteral(fields.tags)}'::text[]`);
  }
  if (fields.source_items !== undefined) {
    setClauses.push(
      `source_items = '${pgArrayLiteral(fields.source_items)}'::text[]`,
    );
  }

  if (setClauses.length === 0) return;
  setClauses.push("updated_at = now()");

  const safeId = escapeSqlString(id);
  await sql.unsafe(
    `UPDATE signals SET ${setClauses.join(", ")} WHERE id = '${safeId}'::uuid`,
  );
}


function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

// --- Items processing (給 B agent 用) ---

// 拿「未處理」items(任何 source_type),按 created_at DESC 排序,限制 N 條
// 回傳 ItemRow(含 processed_at = null,因為查的就是 NULL 的)
export async function getUnprocessedItems(limit: number = 50): Promise<ItemRow[]> {
  return await sql<ItemRow[]>`
    SELECT source_type, source_label, external_id, external_parent,
           created_at, fetched_at, context, processed_at
    FROM items
    WHERE processed_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

// 標記 items 已處理(在 B agent 處理完後調用,不管有沒有建 signals)
// 用 IN + sql.unsafe pattern(因為 ids 是 string array,見 AGENTS.md 踩雷段)
export async function markItemsProcessed(
  sourceType: string,
  externalIds: string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  const idList = externalIds.map((id) => `'${escapeSqlString(id)}'`).join(",");
  await sql`
    UPDATE items
    SET processed_at = now()
    WHERE source_type = ${sourceType} AND external_id IN (${sql.unsafe(idList)})
  `;
}

// Postgres array literal: {"a","b"} (元素包雙引號)
// 嚴格 escape 順序: 先 backslash → 再雙引號 → 再大括號(這三個是 PG array literal
// 保留字元,若不 escape 會破壞 literal 結構 — Gemini 在 PR #5 review 標 critical)
function pgArrayLiteral(arr: string[]): string {
  return `{${arr
    .map((t) =>
      `"${t
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")}"`,
    )
    .join(",")}}`;
}

const VALID_STATUSES = ["discovered", "tracking", "matured", "faded", "invalid"] as const;

function validateSignalStatus(status: string): asserts status is SignalStatus {
  if (!VALID_STATUSES.includes(status as any)) {
    throw new Error(`Invalid signal status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}
