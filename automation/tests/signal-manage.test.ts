import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPT = readFileSync(join(HERE, "..", "commands", "signal-manage.ts"), "utf8");

describe("signal-manage.ts CLI", () => {
  test("queries active signals for LLM context", () => {
    expect(SCRIPT).toMatch(/listActive|archived_at IS NULL/);
  });

  test("queries signal activity (recent items + research_runs)", () => {
    expect(SCRIPT).toMatch(/getTimeline|research_runs|getItems/);
  });

  test("reads high soft limit from config", () => {
    expect(SCRIPT).toMatch(/soft_limit|signal-config/);
  });

  test("applies priority changes", () => {
    expect(SCRIPT).toMatch(/changePriority/);
  });

  test("applies archive decisions", () => {
    expect(SCRIPT).toMatch(/archive/);
  });

  test("appends to description with decision reason", () => {
    expect(SCRIPT).toMatch(/appendToDescription/);
  });

  test("exit 0 when no active signals", () => {
    expect(SCRIPT).toMatch(/no.*active|nothing to do/);
  });

  test("never calls process.exit before closeDb", () => {
    expect(SCRIPT).not.toMatch(/process\.exit\(/);
    expect(SCRIPT).toMatch(/closeDb/);
  });
});
