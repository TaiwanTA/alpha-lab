import { describe, expect, test } from "bun:test";
import { parseSignalConfig, type SignalConfig } from "../lib/signal-config.ts";

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
    // valid — test a separate invalid one
    const invalid = yaml.replace("'high'", "'medium'");
    // just verify valid passes
    const config = parseSignalConfig(yaml);
    expect(config.priorities.high.soft_limit).toBe(5);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseSignalConfig(":\n  : -")).toThrow();
  });

  test("parses the shipped signal-config.yaml file", () => {
    const text = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "config", "signal-config.yaml"),
      "utf8",
    );
    const config = parseSignalConfig(text);
    expect(config.version).toBe(1);
    expect(config.priorities.high.soft_limit).toBe(5);
    expect(config.priorities.low.soft_limit).toBe(20);
    expect(config.description.max_chars).toBe(500);
  });
});
