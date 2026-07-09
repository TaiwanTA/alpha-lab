// Postgres 操作
//   用 Bun.sql 內建 client,所有 query 都用 tagged template 防 SQL injection
//   insertItems 用 ON CONFLICT DO NOTHING,idempotent

import { sql } from "bun";
import type { RawItem, FetchState, NewSignal, Signal, SignalStatus } from "./types.ts";

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

// signals 表的 helpers
//   注意:Bun.sql 不會自動把 JS array 轉成 Postgres array,
//   ${sql.array(...)} 在 PG TEXT[] column 上會把元素 JSON.stringify 帶雙引號(不對),
//   所以 array column 直接 inline ARRAY[...]::text[] 構造器
//   listSignals 的 tags filter 也用同樣 inline 構造器 — 跟 haveItems 的模式一致,
//   values 來自程式內部(已通過 NewSignal type 檢查),sql.unsafe 安全

function inlineTextArray(arr: string[]): string {
  if (arr.length === 0) return "ARRAY[]::text[]";
  const quoted = arr.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
  return `ARRAY[${quoted}]::text[]`;
}

export async function insertSignal(signal: NewSignal): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO signals (id, slug, title, description, importance, status, tags, source_items)
    VALUES (
      COALESCE(${signal.id ?? null}, gen_random_uuid()),
      ${signal.slug ?? null},
      ${signal.title},
      ${signal.description},
      ${signal.importance},
      ${signal.status ?? "discovered"},
      ${sql.unsafe(inlineTextArray(signal.tags ?? []))}::text[],
      ${sql.unsafe(inlineTextArray(signal.source_items ?? []))}::text[]
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function insertSignals(signals: NewSignal[]): Promise<number> {
  if (signals.length === 0) return 0;

  // bulk multi-row VALUES:
  //   * 6 個非 array column bind 為 $1..$6N(id/slug/title/desc/importance/status)
  //     id 沒帶時 → COALESCE(NULL, gen_random_uuid()) 補上 UUID
  //   * 2 個 array column inline ARRAY[...]::text[]
  const valueRows = signals
    .map((s, i) => {
      const off = i * 6 + 1;
      return `(COALESCE($${off}, gen_random_uuid()), $${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, ${inlineTextArray(s.tags ?? [])}, ${inlineTextArray(s.source_items ?? [])})`;
    })
    .join(",");
  const params: unknown[] = [];
  for (const s of signals) {
    params.push(
      s.id ?? null,
      s.slug ?? null,
      s.title,
      s.description,
      s.importance,
      s.status ?? "discovered",
    );
  }

  const result = await sql.unsafe<{ id: string }[]>(
    `INSERT INTO signals (id, slug, title, description, importance, status, tags, source_items)
     VALUES ${valueRows}
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    params,
  );
  return result.length;
}

export async function getSignal(id: string): Promise<Signal | null> {
  const rows = await sql<Signal[]>`
    SELECT * FROM signals WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

export async function getSignalBySlug(slug: string): Promise<Signal | null> {
  const rows = await sql<Signal[]>`
    SELECT * FROM signals WHERE slug = ${slug}
  `;
  return rows[0] ?? null;
}

export interface ListSignalsFilter {
  status?: SignalStatus | SignalStatus[];
  minImportance?: number;
  tags?: string[];
  limit?: number;
}

export async function listSignals(filter: ListSignalsFilter = {}): Promise<Signal[]> {
  // 動態組 WHERE — 每個條件片段的值都先 escape 過再拼,sql.unsafe 包整段
  const conditions: string[] = [];

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const quoted = statuses.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    conditions.push(`status IN (${quoted})`);
  }

  if (filter.minImportance !== undefined) {
    // 強制 Number 防止 SQL injection(只有數字能通過)
    conditions.push(`importance >= ${Number(filter.minImportance)}`);
  }

  if (filter.tags && filter.tags.length > 0) {
    // tags 用 `&&` (any-of):任一給的 tag 出現在 signal.tags 就命中
    // 若要改成 all-of,把 `&&` 換成 `@>`
    const quoted = filter.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
    conditions.push(`tags && ARRAY[${quoted}]::text[]`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;

  const rows = await sql<Signal[]>`
    SELECT * FROM signals
    ${sql.unsafe(where)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function updateSignalStatus(
  id: string,
  status: SignalStatus,
): Promise<void> {
  await sql`
    UPDATE signals
    SET status = ${status}, updated_at = now()
    WHERE id = ${id}
  `;
}
