// Phase 4 contracts — pure functions every later task depends on.
//
// Three exports:
//   - parseSourceRegistry(text): SourceRegistry
//        Decode the YAML registry of investors and their sources.
//   - qualifiesForBet(run): boolean
//        Decide whether a research run produced a thesis concrete
//        enough to back with a paper bet.
//   - selectSettlementSession(sessions, entryDate)
//        Pick the thirtieth returned trading session after entryDate
//        — NOT a calendar estimate.
//
// All three are pure: deterministic, no I/O, no clock. They are the
// contract surface Phase 4 task 2+ call into before any DB write.

import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// parseSourceRegistry
// ---------------------------------------------------------------------------

export type SourceKind = "x_profile" | "blog";

export type RegistrySource = {
  kind: SourceKind;
  url: string;
  handle?: string;
};

export type RegistryEntry = {
  displayName: string;
  sources: RegistrySource[];
};

export type SourceRegistry = Record<string, RegistryEntry>;

const KNOWN_KINDS = new Set<SourceKind>(["x_profile", "blog"]);

export function parseSourceRegistry(text: string): SourceRegistry {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `source registry: malformed YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("source registry: top-level must be a mapping of investors");
  }
  const registry: SourceRegistry = {};
  for (const [investor, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`source registry: investor '${investor}' must be a mapping`);
    }
    const entry = value as Record<string, unknown>;
    const displayName = entry.display_name;
    if (typeof displayName !== "string" || displayName.length === 0) {
      throw new Error(
        `source registry: investor '${investor}' is missing a non-empty display_name`,
      );
    }
    const sourcesRaw = entry.sources;
    if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
      throw new Error(
        `source registry: investor '${investor}' must declare at least one source`,
      );
    }
    const sources: RegistrySource[] = sourcesRaw.map((s, idx) => {
      if (s === null || typeof s !== "object" || Array.isArray(s)) {
        throw new Error(
          `source registry: investor '${investor}' source #${idx + 1} must be a mapping`,
        );
      }
      const src = s as Record<string, unknown>;
      const kind = src.kind;
      if (typeof kind !== "string" || !KNOWN_KINDS.has(kind as SourceKind)) {
        throw new Error(
          `source registry: investor '${investor}' source #${idx + 1} has unknown kind '${String(kind)}'`,
        );
      }
      const url = src.url;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error(
          `source registry: investor '${investor}' source #${idx + 1} url must be https`,
        );
      }
      const handle = src.handle;
      if (handle !== undefined && typeof handle !== "string") {
        throw new Error(
          `source registry: investor '${investor}' source #${idx + 1} handle must be a string when present`,
        );
      }
      const out: RegistrySource = { kind: kind as SourceKind, url };
      if (typeof handle === "string") out.handle = handle;
      return out;
    });
    registry[investor] = { displayName, sources };
  }
  return registry;
}

// ---------------------------------------------------------------------------
// qualifiesForBet
// ---------------------------------------------------------------------------

export type ResearchRunStatus = "accepted" | "rejected" | "needs_review";

export type ResearchDirection = "long" | "short";

export type ResearchRun = {
  status: ResearchRunStatus;
  ticker: string | null;
  direction?: ResearchDirection;
  confidence: number;
  sourceCitations: string[];
};

export function qualifiesForBet(run: ResearchRun): boolean {
  if (run.status !== "accepted") return false;
  if (run.ticker === null || run.ticker === undefined) return false;
  if (run.direction !== "long" && run.direction !== "short") return false;
  if (!Number.isFinite(run.confidence)) return false;
  if (!Array.isArray(run.sourceCitations) || run.sourceCitations.length === 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// selectSettlementSession
// ---------------------------------------------------------------------------

export type MarketSession = {
  date: string; // YYYY-MM-DD
  adjustedClose: number;
};

export const SETTLEMENT_SESSIONS = 30;

export function selectSettlementSession(
  sessions: MarketSession[],
  entryDate: string,
): MarketSession | null {
  // 包含 entryDate 當天的 session 作為 settlement window
  // 的第一個 session,第 SETTLEMENT_SESSIONS (30) 個
  // returned session 就是結算價。Brief 的 fixture 直接
  // 證明這個語意:entryDate = session[0].date,預期回傳
  // session[29].date。
  const window = sessions.filter((s) => s.date >= entryDate);
  if (window.length < SETTLEMENT_SESSIONS) return null;
  return window[SETTLEMENT_SESSIONS - 1] ?? null;
}