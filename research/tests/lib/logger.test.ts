// logger 單元測試(純 logger 行為驗證,不需 DB)
//
// 重置策略:每個 test 用自己的 tmpLogDir,beforeAll 呼叫 initLogger() 重置 state
// (同一個 filename 不能多 instance — LogFileRotationTransport 內部會 throw)
// 為了避免 cross-file 副作用,所有 test 在同一個 describe block 內,afterAll 統一 dispose + rm

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initLogger,
  createLogger,
  getFileTransport,
  getConsoleTransport,
  getLogDir,
} from "../../lib/logger.ts";

// 從 logDir 讀 alpha-lab-*.log(排除已 rotate 的 .gz),parse JSON 過濾 component,
// polling 直到看到至少 expectedCount 條 or timeoutMs 超時(防 flaky)
async function waitForLogLines(
  logDir: string,
  component: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(logDir).filter(
      (f) => f.startsWith("alpha-lab-") && !f.endsWith(".gz"),
    );
    if (files.length > 0) {
      const content = readFileSync(join(logDir, files[0]!), "utf-8");
      // 按 component 過濾,只算這個 test 寫的 — 不被其他 test 寫入污染(Kilo PR #9:長度假設脆弱)
      const lines = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((l) => {
          try {
            return JSON.parse(l).component === component;
          } catch {
            return false;
          }
        });
      if (lines.length >= expectedCount) return lines.slice(0, expectedCount);
    }
    await Bun.sleep(20);
  }
  throw new Error(
    `waitForLogLines timeout: expected ${expectedCount} lines from ${component} in ${logDir}`,
  );
}

describe("logger (LOG_CONSOLE=false)", () => {
  let tmpLogDir: string;

  beforeAll(() => {
    tmpLogDir = mkdtempSync(join(tmpdir(), "alpha-lab-logger-test-"));
    initLogger({ logDir: tmpLogDir, logConsole: false });
  });

  afterAll(() => {
    // dispose 釋放 file handle,讓 rmSync 不會卡(unix file handle 還在會 rm 失敗)
    const ft = getFileTransport();
    if (ft) {
      try {
        (ft as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
      } catch {
        // best-effort
      }
    }
    rmSync(tmpLogDir, { recursive: true, force: true });
  });

  test("createLogger adds component to every log line", async () => {
    const testLog = createLogger("TEST-COMP");
    testLog.withMetadata({ foo: "bar" }).info("hello from test");
    testLog.withMetadata({ count: 42 }).warn("warn line");
    testLog.withError(new Error("boom")).error("err line");

    // file-stream-rotator 走 Node.js writable stream,emit 是 async。
    // 不用固定 Bun.sleep(Kilo PR #9:CI / busy host 不可靠),改 polling 直到看到 3 條或 timeout。
    const lines = await waitForLogLines(tmpLogDir, "TEST-COMP", 3, 1000);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    // 每條都帶 component 欄位(由 withContext 綁定 + filter 也保證)
    for (const entry of parsed) {
      expect(entry.component).toBe("TEST-COMP");
    }
    expect(parsed[0].message).toBe("hello from test");
    expect(parsed[0].foo).toBe("bar");
    expect(parsed[0].level).toBe("info");

    expect(parsed[1].level).toBe("warn");
    expect(parsed[1].count).toBe(42);

    expect(parsed[2].level).toBe("error");
    // serialize-error 拆開 Error 成 {name, message, stack}
    expect(parsed[2].err.name).toBe("Error");
    expect(parsed[2].err.message).toBe("boom");
  });

  test("log file rotation config is daily/YMD/50M/14d", () => {
    const ft = getFileTransport() as unknown as {
      filename: string;
      frequency: string;
      dateFormat: string;
      maxLogs: string | number;
      size: string;
      compressOnRotate: boolean;
    } | null;
    expect(ft).not.toBeNull();
    expect(ft!.frequency).toBe("daily");
    expect(ft!.dateFormat).toBe("YMD");
    expect(ft!.size).toBe("50M");
    expect(ft!.maxLogs).toBe("14d");
    expect(ft!.compressOnRotate).toBe(true);
    // filename pattern 包含 %DATE% 跟 .log(展開後由 file-stream-rotator 加日期)
    expect(ft!.filename).toContain("alpha-lab-%DATE%.log");
    expect(ft!.filename).toContain(tmpLogDir);
  });

  test("console transport disabled when LOG_CONSOLE=false", () => {
    expect(getConsoleTransport()).toBeNull();
  });

  test("log dir is created on module load", () => {
    expect(getLogDir()).toBe(tmpLogDir);
    expect(existsSync(tmpLogDir)).toBe(true);
  });

  test("audit file path is in LOG_DIR", () => {
    const files = readdirSync(tmpLogDir);
    expect(files).toContain(".audit.json");
    // audit 檔內容是 JSON 物件,沒壞
    const auditContent = readFileSync(join(tmpLogDir, ".audit.json"), "utf-8");
    expect(() => JSON.parse(auditContent)).not.toThrow();
  });
});

describe("logger (LOG_CONSOLE=true)", () => {
  let tmpLogDir: string;

  beforeAll(() => {
    tmpLogDir = mkdtempSync(join(tmpdir(), "alpha-lab-logger-console-"));
    initLogger({ logDir: tmpLogDir, logConsole: true });
  });

  afterAll(() => {
    const ft = getFileTransport();
    if (ft) {
      try {
        (ft as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
      } catch {
        // best-effort
      }
    }
    rmSync(tmpLogDir, { recursive: true, force: true });
  });

  test("console transport enabled when LOG_CONSOLE=true", () => {
    expect(getConsoleTransport()).not.toBeNull();
  });

  test("file transport 仍正常運作(console + file 雙寫)", async () => {
    const testLog = createLogger("DUAL");
    testLog.info("dual output line");
    // 同上 polling(Kilo PR #9:Bun.sleep(150) flaky)
    const lines = await waitForLogLines(tmpLogDir, "DUAL", 1, 1000);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.message).toBe("dual output line");
    expect(parsed.component).toBe("DUAL");
  });
});