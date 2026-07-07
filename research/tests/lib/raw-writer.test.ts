import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { RawWriter } from "../../lib/raw-writer.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let writer: RawWriter;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "raw-writer-"));
  writer = new RawWriter(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("RawWriter.computePath", () => {
  test("creates nested YYYY-MM/YYYY-MM-DD.jsonl path", () => {
    const date = new Date("2025-07-07T12:00:00Z");
    const { dir, file } = writer.computePath("x_user_timeline", "@BillAckman", date);
    expect(dir).toBe(join(tempDir, "x_user_timeline", "_BillAckman", "2025-07"));
    expect(file).toBe(join(dir, "2025-07-07.jsonl"));
  });

  test("sanitizes special chars in label", () => {
    const { dir } = writer.computePath(
      "x",
      "@user/with:special*chars",
      new Date("2025-07-07"),
    );
    expect(dir).toContain("_user_with_special_chars");
  });

  test("uses UTC date for path", () => {
    // 2025-07-07T23:00:00Z (UTC) → 2025-07
    // 2025-07-07T23:00:00-08:00 (PST) → same UTC date
    const { file } = writer.computePath(
      "x",
      "@a",
      new Date("2025-07-07T23:00:00-08:00"),
    );
    expect(file).toContain("2025-07-08.jsonl"); // UTC is next day
  });
});

describe("RawWriter.append", () => {
  test("writes single JSONL line", async () => {
    const date = new Date("2025-07-07T12:00:00Z");
    const payload = { id: "1", text: "hello" };
    const file = await writer.append("x_user_timeline", "@BillAckman", date, payload);
    const content = await readFile(file, "utf-8");
    expect(content).toBe(JSON.stringify(payload) + "\n");
  });

  test("appends multiple lines to same file", async () => {
    const date = new Date("2025-07-07T12:00:00Z");
    await writer.append("x", "@a", date, { id: "1" });
    await writer.append("x", "@a", date, { id: "2" });
    await writer.append("x", "@a", date, { id: "3" });

    const file = writer.computePath("x", "@a", date).file;
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).id).toBe("1");
    expect(JSON.parse(lines[1]!).id).toBe("2");
    expect(JSON.parse(lines[2]!).id).toBe("3");
  });

  test("separate dates go to separate files", async () => {
    await writer.append("x", "@a", new Date("2025-07-07T00:00:00Z"), { id: "1" });
    await writer.append("x", "@a", new Date("2025-07-08T00:00:00Z"), { id: "2" });

    const day1 = writer.computePath("x", "@a", new Date("2025-07-07")).file;
    const day2 = writer.computePath("x", "@a", new Date("2025-07-08")).file;
    expect(day1).not.toBe(day2);

    const c1 = (await readFile(day1, "utf-8")).trim();
    const c2 = (await readFile(day2, "utf-8")).trim();
    expect(JSON.parse(c1).id).toBe("1");
    expect(JSON.parse(c2).id).toBe("2");
  });
});
