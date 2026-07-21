// automation/lib/signal-config.ts
//
// Pure YAML parser for signal-config.yaml.
// Validates structure: version, priorities (high+low), description.max_chars.
// Throws on missing/invalid fields — fail loud so a typo doesn't
// silently break priority budgets.

import { parse as parseYaml } from "yaml";

export type SignalConfigPriority = {
  soft_limit: number;
  research_schedule: string;
  research_model: string;
  research_per_signal: boolean;
};

export type SignalConfig = {
  version: number;
  priorities: {
    high: SignalConfigPriority;
    low: SignalConfigPriority;
  };
  description: {
    max_chars: number;
  };
};

const SUPPORTED_VERSION = 1;

export function parseSignalConfig(text: string): SignalConfig {
  const raw = parseYaml(text);
  if (raw === null || typeof raw !== "object") {
    throw new Error("signal-config: malformed YAML");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== SUPPORTED_VERSION) {
    throw new Error(
      `signal-config: version must be ${SUPPORTED_VERSION}, got ${String(obj.version)}`,
    );
  }

  if (obj.priorities === undefined || typeof obj.priorities !== "object") {
    throw new Error("signal-config: missing priorities");
  }
  const pri = obj.priorities as Record<string, unknown>;

  // 先確認兩個優先級都存在,再逐欄驗證——避免在 low 缺失時
  // 因 high 欄位不完整而丟出誤導性的錯誤訊息。
  for (const level of ["high", "low"] as const) {
    if (pri[level] === undefined || typeof pri[level] !== "object") {
      throw new Error(`signal-config: missing priority level '${level}'`);
    }
  }

  for (const level of ["high", "low"] as const) {
    const p = pri[level] as Record<string, unknown>;
    if (typeof p.soft_limit !== "number" || p.soft_limit < 1) {
      throw new Error(`signal-config: ${level}.soft_limit must be a positive number`);
    }
    if (typeof p.research_schedule !== "string" || p.research_schedule.length === 0) {
      throw new Error(`signal-config: ${level}.research_schedule must be a non-empty string`);
    }
    if (typeof p.research_model !== "string" || p.research_model.length === 0) {
      throw new Error(`signal-config: ${level}.research_model must be a non-empty string`);
    }
    if (typeof p.research_per_signal !== "boolean") {
      throw new Error(`signal-config: ${level}.research_per_signal must be a boolean`);
    }
  }

  if (obj.description === undefined || typeof obj.description !== "object") {
    throw new Error("signal-config: missing description");
  }
  const desc = obj.description as Record<string, unknown>;
  if (typeof desc.max_chars !== "number" || desc.max_chars < 1) {
    throw new Error("signal-config: description.max_chars must be a positive number");
  }

  return {
    version: obj.version as number,
    priorities: {
      high: pri.high as unknown as SignalConfigPriority,
      low: pri.low as unknown as SignalConfigPriority,
    },
    description: {
      max_chars: desc.max_chars as number,
    },
  };
}
