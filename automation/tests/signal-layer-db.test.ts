import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const DB = readFileSync(join(HERE, "..", "lib", "db.ts"), "utf8");

describe("db.ts signal layer rename + new types", () => {
  test("renames SignalEventRow to ItemRow", () => {
    expect(DB).toMatch(/export type ItemRow =/);
    expect(DB).not.toMatch(/export type SignalEventRow =/);
  });

  test("removes SignalEventStatus type", () => {
    expect(DB).not.toMatch(/export type SignalEventStatus/);
  });

  test("removes status and supersedes_event_id from ItemRow", () => {
    expect(DB).not.toMatch(/status: SignalEventStatus/);
    expect(DB).not.toMatch(/supersedes_event_id/);
  });

  test("adds classified_at and classification_result to ItemRow", () => {
    expect(DB).toMatch(/classified_at:/);
    expect(DB).toMatch(/classification_result:/);
  });

  test("renames EventRecord to ItemRecord", () => {
    expect(DB).toMatch(/export const ItemRecord =/);
    expect(DB).not.toMatch(/export const EventRecord =/);
  });

  test("removes claimNextActive and releaseToActive from ItemRecord", () => {
    // 這些方法引用了已刪除的 status 列
    expect(DB).not.toMatch(/claimNextActive/);
    expect(DB).not.toMatch(/releaseToActive/);
  });

  test("adds SignalRecord with CRUD + management queries", () => {
    expect(DB).toMatch(/export const SignalRecord =/);
    expect(DB).toMatch(/insert/);
    expect(DB).toMatch(/claimNextUnclassifiedItems/);
    expect(DB).toMatch(/linkItem/);
    expect(DB).toMatch(/listActive/);
    expect(DB).toMatch(/changePriority/);
    expect(DB).toMatch(/archive/);
  });

  test("ResearchRunRow uses signal_id not event_id", () => {
    expect(DB).toMatch(/signal_id:/);
    expect(DB).not.toMatch(/event_id:/);
  });

  test("ResearchRunRow has published_path", () => {
    expect(DB).toMatch(/published_path:/);
  });

  test("claimNextUnpublished filters on candidate_markdown non-empty + archive", () => {
    expect(DB).toMatch(/candidate_markdown IS NOT NULL/);
    expect(DB).toMatch(/candidate_markdown != ''/);
    expect(DB).toMatch(/archived_at IS NULL/);
  });

  test("LedgerDb aggregate includes ItemRecord + SignalRecord", () => {
    expect(DB).toMatch(/ItemRecord/);
    expect(DB).toMatch(/SignalRecord/);
  });
});
