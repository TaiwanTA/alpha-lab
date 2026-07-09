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

    // 給非同步 stream write 一點時間 flush(沒 batch config,但仍走 Node.js writable)
    await Bun.sleep(150);

    const files = readdirSync(tmpLogDir).filter(
      (f) => f.startsWith("alpha-lab-") && !f.endsWith(".gz"),
    );
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(tmpLogDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    // 每條都帶 component 欄位(由 withContext 綁定)
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
    await Bun.sleep(150);
    const files = readdirSync(tmpLogDir).filter((f) => f.startsWith("alpha-lab-"));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(tmpLogDir, files[0]!), "utf-8");
    expect(content).toContain("dual output line");
    expect(content).toContain("DUAL");
  });
});