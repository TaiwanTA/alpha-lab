// CLI entry:跑所有未執行的 migrations
// 用法:bun run migrate

import { runMigrations } from "./lib/migrator.ts";
import { join } from "node:path";
import { createLogger } from "./lib/logger.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const log = createLogger("migrate");

runMigrations(MIGRATIONS_DIR)
  .then(({ applied, skipped }) => {
    log.withMetadata({ applied, skipped }).info("migrate done");
    process.exit(0);
  })
  .catch((err) => {
    log.withError(err).error("migrate failed");
    process.exit(1);
  });
