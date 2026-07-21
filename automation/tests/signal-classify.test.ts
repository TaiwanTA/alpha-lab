import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSignalConfig, type SignalConfig } from "../lib/signal-config.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

describe("parseSignalConfig", () => {
  test("parses valid config with both priorities", () => {
    const yaml = `
version: 1
priorities:
  high:
    soft_limit: 5
    research_schedule: "0 7 * * *"
    research_model: "MiniMax-M3"
    research_per_signal: true
  low:
    soft_limit: 20
    research_schedule: "0 8 * * */2"
    research_model: "MiniMax-M3"
    research_per_signal: false
description:
  max_chars: 500
`;
    const config = parseSignalConfig(yaml);
    expect(config.priorities.high.soft_limit).toBe(5);
    expect(config.priorities.high.research_per_signal).toBe(true);
    expect(config.priorities.low.soft_limit).toBe(20);
    expect(config.priorities.low.research_per_signal).toBe(false);
    expect(config.description.max_chars).toBe(500);
  });

  test("rejects missing version", () => {
    expect(() => parseSignalConfig("priorities:\n  high:\n    soft_limit: 5\n")).toThrow();
  });

  test("rejects missing priority level", () => {
    expect(() =>
      parseSignalConfig("version: 1\npriorities:\n  high:\n    soft_limit: 5\n"),
    ).toThrow(/low/);
  });

  test("rejects invalid priority value", () => {
    const yaml = `
version: 1
priorities:
  medium:
    soft_limit: 5
    research_schedule: "0 7 * * *"
    research_model: "MiniMax-M3"
    research_per_signal: true
  low:
    soft_limit: 20
    research_schedule: "0 8 * * */2"
    research_model: "MiniMax-M3"
    research_per_signal: false
description:
  max_chars: 500
`;
    expect(() => parseSignalConfig(yaml)).toThrow(/high/);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseSignalConfig(":\n  : -")).toThrow();
  });

  test("parses the shipped signal-config.yaml file", () => {
    const text = readFileSync(
      join(HERE, "..", "config", "signal-config.yaml"),
      "utf8",
    );
    const config = parseSignalConfig(text);
    expect(config.version).toBe(1);
    expect(config.priorities.high.soft_limit).toBe(5);
    expect(config.priorities.low.soft_limit).toBe(20);
    expect(config.description.max_chars).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// signal-classify.ts CLI — source-file string-match tests
// (same pattern as phase4-publication.test.ts).
// These do NOT execute the LLM; they verify the file content contains
// the expected SQL calls, SignalRecord methods, and exit discipline.
// ---------------------------------------------------------------------------

const INGEST = readFileSync(
  join(HERE, "..", "commands", "signal-classify.ts"),
  "utf8",
);

describe("signal-classify.ts CLI", () => {
  test("queries unclassified items via classified_at IS NULL", () => {
    expect(INGEST).toMatch(/classified_at IS NULL/);
  });

  test("queries active signals for LLM context", () => {
    expect(INGEST).toMatch(/listActive|archived_at IS NULL/);
  });

  test("writes new signals with LLM-decided priority", () => {
    expect(INGEST).toMatch(/INSERT INTO signals|SignalRecord\.insert/);
  });

  test("links items to signals via signal_items", () => {
    expect(INGEST).toMatch(/linkItem|signal_items/);
  });

  test("marks items as classified after processing", () => {
    expect(INGEST).toMatch(/markClassified|classified_at = now/);
  });

  test("handles rejections (items not classified into any signal)", () => {
    expect(INGEST).toMatch(/rejection|rejected|classification_result/);
  });

  test("exit 0 when no unclassified items", () => {
    expect(INGEST).toMatch(/no.*unclassified|nothing to do/);
  });

  test("stdout only outputs summary, logs to stderr", () => {
    expect(INGEST).toMatch(/console\.error/);
    expect(INGEST).toMatch(/console\.log|process\.stdout/);
  });

  test("never calls process.exit before closeDb", () => {
    expect(INGEST).not.toMatch(/process\.exit\(/);
    expect(INGEST).toMatch(/closeDb/);
  });
});
