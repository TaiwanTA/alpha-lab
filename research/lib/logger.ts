// 結構化 logger(loglayer singleton + 檔案輪替)
//   設計:每個進程只 init 一次,所有 consumer 共享同一個 file transport
//   採 lazy init — 第一次 createLogger() / getLog() 時才用 env var defaults 初始化。
//   入口(main / if (import.meta.main))可顯式呼叫 initLogger() 覆寫,例如要指定 logDir。
//   createLogger(component) 回傳 child logger,持久帶 component context(每條 log 都自帶)
//
// 注意:child logger 不可跨 re-init reuse:
//   initLogger() 會 dispose 舊 file transport,先前 createLogger() 拿到的 child logger
//   雖然還在記憶體,但其寫入會落到已關閉的 stream(test 想換 logDir 時,fine — 直接重新 createLogger)。
//   這是 OK 的副作用:production 只 init 一次,test 走 fixture 重新 createLogger 而非 reuse。
//
// Env vars:
//   LOG_DIR      — log 檔根目錄(預設 ./logs,lazy init 時 mkdir -p)
//   LOG_CONSOLE  — "false" 時關閉 console transport(讓 systemd 跑時只寫檔不雙重輸出)

import { LogLayer, ConsoleTransport } from "loglayer";
import type { ILogLayer, LogLayerTransport } from "loglayer";
import { LogFileRotationTransport } from "@loglayer/transport-log-file-rotation";
import { serializeError } from "serialize-error";
import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LoggerInitOptions {
  logDir?: string;
  logConsole?: boolean;
}

interface LoggerState {
  logLayer: LogLayer;
  fileTransport: LogFileRotationTransport;
  consoleTransport: ConsoleTransport | null;
  logDir: string;
}

let state: LoggerState | null = null;

// dispose 舊 transport — 同一個 filename 不能多 instance
// (LogFileRotationTransport 內部會 throw,這裡先 release 舊的)
function disposeState(prev: LoggerState): void {
  try {
    prev.fileTransport[Symbol.dispose]();
  } catch {
    // best-effort dispose,失敗不阻斷 reinit
  }
}

export function initLogger(opts: LoggerInitOptions = {}): LogLayer {
  const logDir = opts.logDir ?? process.env.LOG_DIR ?? "./logs";
  const logConsole =
    opts.logConsole ?? process.env.LOG_CONSOLE !== "false";

  // 確保 log dir 存在(audit 檔在同目錄下,遞迴建一次就好,dirname(auditFile) === logDir)
  mkdirSync(logDir, { recursive: true });
  const auditFile = join(logDir, ".audit.json");

  const fileTransport = new LogFileRotationTransport({
    filename: join(logDir, "alpha-lab-%DATE%.log"),
    frequency: "daily",
    dateFormat: "YMD", // daily rotation 必須 YMD
    maxLogs: "14d",
    size: "50M",
    compressOnRotate: true,
    auditFile,
    staticData: {
      hostname: hostname(),
      pid: process.pid,
      env: process.env.NODE_ENV ?? "development",
    },
    fileMode: 0o640,
  });

  const transports: LogLayerTransport[] = [fileTransport];
  let consoleTransport: ConsoleTransport | null = null;
  if (logConsole) {
    consoleTransport = new ConsoleTransport({ logger: console });
    transports.push(consoleTransport);
  }

  const logLayer = new LogLayer({
    errorSerializer: serializeError,
    transport: transports,
  });

  if (state) disposeState(state);
  state = { logLayer, fileTransport, consoleTransport, logDir };
  return logLayer;
}

function getState(): LoggerState {
  if (state) return state;
  // 第一次存取:用 env var defaults lazy init。@kilocode-bot PR #9 iter 1 CRITICAL:
  // 不在 module load eager init,避免每個 import 點建 ./logs/ 副作用 + race。
  initLogger();
  if (!state) throw new Error("logger init failed");
  return state;
}

// 給 consumer 拿「當前」 LogLayer(走 state,所以 test 重 init 後看得到新 logger)
export function getLog(): LogLayer {
  return getState().logLayer;
}

// child logger + component context:每條 log 都自帶 component 欄位
export function createLogger(component: string): ILogLayer {
  return getState().logLayer.child().withContext({ component });
}

// 給測試 inspect 用的 getter(production 不該用)
export function getFileTransport(): LogFileRotationTransport | null {
  return state?.fileTransport ?? null;
}

export function getConsoleTransport(): ConsoleTransport | null {
  return state?.consoleTransport ?? null;
}

export function getLogDir(): string | null {
  return state?.logDir ?? null;
}

// module load 不做副作用 init — 第一次 createLogger() / getLog() 時 lazy init。
// 想覆寫 env var defaults 的入口(例如 cron 想指定絕對路徑 logDir)顯式呼叫 initLogger()
