import { describe, expect, test } from "bun:test";

import {
  parseSourceRegistry,
  qualifiesForBet,
  selectSettlementSession,
} from "../scripts/phase4/contracts.ts";

// ---------------------------------------------------------------------------
// parseSourceRegistry — registry contract for source citations.
//
// YAML registry keyed by investor. Each entry lists the canonical sources
// (URLs, kinds, handles) the ingestor will pull from. The registry is what
// downstream tasks rely on to scope capture; missing / malformed entries
// MUST fail loud so a typo doesn't silently drop a source.
// ---------------------------------------------------------------------------

describe("parseSourceRegistry", () => {
  test("parses every investor entry with at least one https source", () => {
    const yaml = `
alice:
  display_name: "Alice"
  sources:
    - kind: x_profile
      handle: alice
      url: https://x.com/alice
bob:
  display_name: "Bob"
  sources:
    - kind: blog
      url: https://example.com/bob
`;
    const registry = parseSourceRegistry(yaml);
    expect(Object.keys(registry).sort()).toEqual(["alice", "bob"]);
    expect(registry.alice.displayName).toBe("Alice");
    expect(registry.alice.sources).toHaveLength(1);
    expect(registry.alice.sources[0]).toEqual({
      kind: "x_profile",
      handle: "alice",
      url: "https://x.com/alice",
    });
    expect(registry.bob.sources[0]?.url).toBe("https://example.com/bob");
  });

  test("rejects an entry with zero sources", () => {
    const yaml = `
alice:
  display_name: "Alice"
  sources: []
`;
    expect(() => parseSourceRegistry(yaml)).toThrow(/at least one source/);
  });

  test("rejects a source whose url is not https", () => {
    const yaml = `
alice:
  display_name: "Alice"
  sources:
    - kind: blog
      url: http://example.com/alice
`;
    expect(() => parseSourceRegistry(yaml)).toThrow(/https/i);
  });

  test("rejects an unknown source kind", () => {
    const yaml = `
alice:
  display_name: "Alice"
  sources:
    - kind: rss_feed
      url: https://example.com/alice
`;
    expect(() => parseSourceRegistry(yaml)).toThrow(/kind/i);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseSourceRegistry(":\n  : -")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// qualifiesForBet — accept only a single-ticker long/short thesis that has
// the minimum observable contract: accepted status, non-null ticker, real
// direction, finite confidence, and ≥1 source citation.
// ---------------------------------------------------------------------------

describe("qualifiesForBet", () => {
  const acceptedLong: Parameters<typeof qualifiesForBet>[0] = {
    status: "accepted",
    ticker: "ABC",
    direction: "long",
    confidence: 0.7,
    sourceCitations: ["https://x.com/a/status/1"],
  };

  test("accepts a complete accepted single-ticker long thesis", () => {
    expect(qualifiesForBet(acceptedLong)).toBe(true);
  });

  test("accepts a complete accepted single-ticker short thesis", () => {
    expect(
      qualifiesForBet({ ...acceptedLong, direction: "short" }),
    ).toBe(true);
  });

  test("rejects when status is not accepted", () => {
    expect(qualifiesForBet({ ...acceptedLong, status: "needs_review" })).toBe(false);
    expect(qualifiesForBet({ ...acceptedLong, status: "rejected" })).toBe(false);
  });

  test("rejects when ticker is null or missing", () => {
    expect(qualifiesForBet({ ...acceptedLong, ticker: null })).toBe(false);
  });

  test("rejects when direction is missing", () => {
    expect(qualifiesForBet({ ...acceptedLong, direction: undefined })).toBe(false);
  });

  test("rejects when confidence is non-finite", () => {
    expect(qualifiesForBet({ ...acceptedLong, confidence: Number.NaN })).toBe(false);
    expect(qualifiesForBet({ ...acceptedLong, confidence: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test("rejects when no source citations are provided", () => {
    expect(qualifiesForBet({ ...acceptedLong, sourceCitations: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectSettlementSession — return the thirtieth session after the entry
// date, NOT a calendar estimate. Calendar arithmetic would put the
// settlement window ~30 calendar days out, which disagrees with the 30th
// *trading* session.
// ---------------------------------------------------------------------------

describe("selectSettlementSession", () => {
  test("returns the thirtieth returned session, ignoring calendar gaps", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      date: index === 29 ? "2026-02-13" : `2026-01-${String(index + 2).padStart(2, "0")}`,
      adjustedClose: 100,
    }));
    expect(selectSettlementSession(sessions, "2026-01-02")?.date).toBe("2026-02-13");
  });

  test("returns null when fewer than 30 sessions are available", () => {
    const sessions = Array.from({ length: 29 }, (_, index) => ({
      date: `2026-01-${String(index + 2).padStart(2, "0")}`,
      adjustedClose: 100,
    }));
    expect(selectSettlementSession(sessions, "2026-01-02")).toBeNull();
  });

  test("returns null for an empty session list", () => {
    expect(selectSettlementSession([], "2026-01-02")).toBeNull();
  });
});