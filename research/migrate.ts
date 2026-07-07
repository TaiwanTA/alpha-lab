// CLI entry:跑所有未執行的 migrations
// 用法:bun run migrate

import { runMigrations } from "./lib/migrator.ts";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

runMigrations(MIGRATIONS_DIR)
  .then(({ applied, skipped }) => {
    console.log(`[migrate] done. ${applied} applied, ${skipped} skipped.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
