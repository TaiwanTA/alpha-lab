// Migration runner(自己寫,~50 行)
//   1. 建 schema_migrations 表(若不存在)
//   2. 列出 migrations/ 內所有 .sql 檔(按檔名排序)
//   3. 跳過已執行的,跑剩下的,記錄
//   沒有 down(見 research/AGENTS.md 決策)

import { sql } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.ts";

const MIGRATION_PATTERN = /^(\d+)_(.+)\.sql$/;
const log = createLogger("migrator");

export async function runMigrations(
  migrationsDir: string,
): Promise<{ applied: number; skipped: number }> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set<number>(
    (
      await sql<{ version: number }[]>`SELECT version FROM schema_migrations`
    ).map((r) => r.version),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  let skippedCount = 0;

  for (const f of files) {
    const match = f.match(MIGRATION_PATTERN);
    if (!match) {
      log.withMetadata({ file: f, reason: "naming convention" }).warn("skip migration file");
      continue;
    }
    const version = parseInt(match[1]!, 10);
    const name = match[2]!;

    if (applied.has(version)) {
      skippedCount++;
      continue;
    }

    const content = readFileSync(join(migrationsDir, f), "utf-8");
    log.withMetadata({ version, name }).info("applying migration");
    // 用 unsafe 跑整個 .sql 檔(裡面可能有多個 statement)
    await sql.unsafe(content);
    await sql`INSERT INTO schema_migrations (version, name) VALUES (${version}, ${name})`;
    appliedCount++;
  }

  return { applied: appliedCount, skipped: skippedCount };
}
