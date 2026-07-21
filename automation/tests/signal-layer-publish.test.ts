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

const CLASSIFY_DAG = readFileSync(join(HERE, "..", "dags", "signal-classify.yaml"), "utf8");
const MANAGE_DAG = readFileSync(join(HERE, "..", "dags", "signal-manage.yaml"), "utf8");
const RESEARCH_DAG = readFileSync(join(HERE, "..", "dags", "research-signals.yaml"), "utf8");

describe("signal layer DAGs", () => {
  test("signal-classify DAG has correct schedule + env", () => {
    expect(CLASSIFY_DAG).toMatch(/schedule:/);
    expect(CLASSIFY_DAG).toMatch(/signal-classify\.ts/);
    expect(CLASSIFY_DAG).toMatch(/DATABASE_URL/);
    expect(CLASSIFY_DAG).toMatch(/MINIMAX_API_KEY/);
  });

  test("signal-manage DAG runs at 06:00 UTC", () => {
    expect(MANAGE_DAG).toMatch(/schedule:.*0 6/);
    expect(MANAGE_DAG).toMatch(/signal-manage\.ts/);
  });

  test("research-signals DAG replaces research-next-event", () => {
    expect(RESEARCH_DAG).toMatch(/research-signals\.ts/);
    expect(RESEARCH_DAG).toMatch(/--priority/);
  });

  test("research-next-event.yaml no longer exists", () => {
    expect(() => readFileSync(join(HERE, "..", "dags", "research-next-event.yaml"), "utf8")).toThrow();
  });
});
