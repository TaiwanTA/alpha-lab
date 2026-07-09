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
//   注意:array columns 在 VALUES 用 sql.array(arr, "TEXT") 帶 type hint
//   (Bun.sql 不帶 hint 會 JSON.stringify 每個元素帶雙引號,不正確)
//   listSignals 的 tags filter 用 inline ARRAY[...]::text[] 字串拼接 —
//   跟 haveItems 的 sql.unsafe + escape 模式一致

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
      ${sql.array(signal.tags ?? [], "TEXT")},
      ${sql.array(signal.source_items ?? [], "TEXT")}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  const row = rows[0];
  if (!row) {
    // ON CONFLICT 觸發 → RETURNING 空。Production 不會撞 id(server-generated UUID),
    // 撞了就 throw 讓 caller 知道(可能是 explicit id 重複給了)
    throw new Error(
      `insertSignal: id already exists (${signal.id ?? "(generated)"})`,
    );
  }
  return row.id;
}

export async function insertSignals(signals: NewSignal[]): Promise<number> {
  if (signals.length === 0) return 0;

  // bulk:用 Bun.sql 原生 ${sql(rows)} + 每 row 的 array column 用 sql.array(arr, "TEXT")
  //   id 沒帶時 JS 端 crypto.randomUUID() 生成 — ${sql(rows)} 不支援 column DEFAULT,
  //   所以 id 必須在 JS 端準備好(ON CONFLICT (id) DO STILL work)
  const rows = signals.map((s) => ({
    id: s.id ?? crypto.randomUUID(),
    slug: s.slug ?? null,
    title: s.title,
    description: s.description,
    importance: s.importance,
    status: s.status ?? "discovered",
    tags: sql.array(s.tags ?? [], "TEXT"),
    source_items: sql.array(s.source_items ?? [], "TEXT"),
  }));

  const result = await sql<{ id: string }[]>`
    INSERT INTO signals ${sql(rows)}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
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
    // Number() 強制轉數字防 SQL injection,NaN/Infinity 守衛避免 Postgres 報錯
    const min = Number(filter.minImportance);
    if (!Number.isFinite(min)) return [];
    conditions.push(`importance >= ${min}`);
  }

  if (filter.tags && filter.tags.length > 0) {
    // tags 用 `&&` (any-of):任一給的 tag 出現在 signal.tags 就命中
    // 若要改成 all-of,把 `&&` 換成 `@>`
    // 用 inline ARRAY[...]::text[] 構造器 — 跟 haveItems 一樣的字串拼接 pattern
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
  const result = await sql`
    UPDATE signals
    SET status = ${status}, updated_at = now()
    WHERE id = ${id}
  `;
  if (result.count === 0) {
    console.warn(`updateSignalStatus: no signal with id ${id}`);
  }
}
