import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const DB = readFileSync(join(HERE, "..", "lib", "db.ts"), "utf8");

describe("publish gate signal layer", () => {
  test("claimNextUnpublished joins signals table", () => {
    expect(DB).toMatch(/JOIN signals/);
  });

  test("claimNextUnpublished filters candidate_markdown non-empty", () => {
    expect(DB).toMatch(/candidate_markdown IS NOT NULL/);
    expect(DB).toMatch(/candidate_markdown != ''/);
  });

  test("claimNextUnpublished filters archived signals", () => {
    expect(DB).toMatch(/archived_at IS NULL/);
  });

  test("claimNextUnpublished still uses SKIP LOCKED", () => {
    expect(DB).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
});
