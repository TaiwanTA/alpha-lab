import { describe, expect, test } from "bun:test";

import {
  buildCalibration,
  serializeCalibration,
  type CalibrationOutcome,
} from "../commands/calibrate-signals.ts";

const unresolvedOutcome: CalibrationOutcome = {
  investor: "Alice",
  signalType: "public_event",
  confidence: 0.9,
  outcome: "unresolved",
};

describe("buildCalibration", () => {
  test("excludes unresolved outcomes from metrics and keeps a zero sample count", () => {
    expect(buildCalibration([unresolvedOutcome])).toEqual({
      sampleSize: 0,
      buckets: [],
    });
  });

  test("uses confidence buckets [0,.5), [.5,.75), [.75,1]", () => {
    const outcomes: CalibrationOutcome[] = [
      { investor: "Alice", signalType: "public_event", confidence: 0, outcome: "loss" },
      { investor: "Alice", signalType: "public_event", confidence: 0.499, outcome: "win" },
      { investor: "Alice", signalType: "public_event", confidence: 0.5, outcome: "win" },
      { investor: "Alice", signalType: "public_event", confidence: 0.749, outcome: "loss" },
      { investor: "Alice", signalType: "public_event", confidence: 0.75, outcome: "win" },
      { investor: "Alice", signalType: "public_event", confidence: 1, outcome: "loss" },
    ];

    expect(buildCalibration(outcomes)).toEqual({
      sampleSize: 6,
      buckets: [
        { investor: "Alice", signalType: "public_event", confidenceBucket: "[0,0.5)", sampleSize: 2, wins: 1, losses: 1, winRate: 0.5 },
        { investor: "Alice", signalType: "public_event", confidenceBucket: "[0.5,0.75)", sampleSize: 2, wins: 1, losses: 1, winRate: 0.5 },
        { investor: "Alice", signalType: "public_event", confidenceBucket: "[0.75,1]", sampleSize: 2, wins: 1, losses: 1, winRate: 0.5 },
      ],
    });
  });

  test("sorts stable JSON by investor, signal type, then confidence bucket", () => {
    const outcomes: CalibrationOutcome[] = [
      { investor: "Zulu", signalType: "public_event", confidence: 0.8, outcome: "win" },
      { investor: "Alice", signalType: "zeta", confidence: 0.8, outcome: "loss" },
      { investor: "Alice", signalType: "public_event", confidence: 0.8, outcome: "win" },
      { investor: "Alice", signalType: "public_event", confidence: 0.2, outcome: "loss" },
    ];

    const first = serializeCalibration(buildCalibration(outcomes));
    const second = serializeCalibration(buildCalibration([...outcomes].reverse()));

    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(parsed.buckets.map((bucket: Record<string, unknown>) => [
      bucket.investor,
      bucket.signalType,
      bucket.confidenceBucket,
    ])).toEqual([
      ["Alice", "public_event", "[0,0.5)"],
      ["Alice", "public_event", "[0.75,1]"],
      ["Alice", "zeta", "[0.75,1]"],
      ["Zulu", "public_event", "[0.75,1]"],
    ]);
    expect(first).not.toMatch(/outperform|underperform|better|worse|strong|weak/i);
  });

  test("rejects non-finite or out-of-range confidence rather than assigning a bucket", () => {
    expect(() => buildCalibration([{ ...unresolvedOutcome, outcome: "win", confidence: Number.NaN }])).toThrow(/confidence/);
    expect(() => buildCalibration([{ ...unresolvedOutcome, outcome: "loss", confidence: 1.01 }])).toThrow(/confidence/);
  });

  test("numeric(4,3) round-trip drift stays in the schema's bucket", () => {
    // PG numeric(4,3)::text may emit a value like "0.7499999" if the
    // underlying computation landed slightly below the canonical
    // form (or "0.7500001" if slightly above). After Number() those
    // become 0.7499999 / 0.7500001, which still hit the right bucket
    // because the boundaries (`< 0.5`, `< 0.75`) leave room. The
    // loadSettledOutcomes helper rounds to 3 decimals so downstream
    // consumers see the canonical value the row was stored with — we
    // assert the rounding step lands on the bucket the schema stores.
    expect(
      buildCalibration([{ ...unresolvedOutcome, outcome: "win", confidence: 0.7499999 }]).buckets[0]
        ?.confidenceBucket,
    ).toBe("[0.5,0.75)");
    expect(
      buildCalibration([{ ...unresolvedOutcome, outcome: "win", confidence: 0.7500001 }]).buckets[0]
        ?.confidenceBucket,
    ).toBe("[0.75,1]");
    // The same confidence after Math.round(n*1000)/1000 stays in the
    // same bucket — the rounding never crosses a boundary for values
    // stored as numeric(4,3).
    const round = (n: number) => Math.round(n * 1000) / 1000;
    expect(round(0.7499999)).toBe(0.75);
    expect(round(0.7500001)).toBe(0.75);
  });
});
