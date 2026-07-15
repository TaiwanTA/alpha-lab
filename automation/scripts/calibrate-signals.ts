#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { LedgerDb } from "./phase4/db.ts";

export type CalibrationOutcome = {
  investor: string;
  signalType: string;
  confidence: number;
  outcome: "win" | "loss" | "unresolved";
};

export type CalibrationBucket = {
  investor: string;
  signalType: string;
  confidenceBucket: "[0,0.5)" | "[0.5,0.75)" | "[0.75,1]";
  sampleSize: number;
  wins: number;
  losses: number;
  winRate: number;
};

export type Calibration = {
  sampleSize: number;
  buckets: CalibrationBucket[];
};

const BUCKET_ORDER: Record<CalibrationBucket["confidenceBucket"], number> = {
  "[0,0.5)": 0,
  "[0.5,0.75)": 1,
  "[0.75,1]": 2,
};

function confidenceBucket(confidence: number): CalibrationBucket["confidenceBucket"] {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be finite and within [0,1]");
  }
  if (confidence < 0.5) return "[0,0.5)";
  if (confidence < 0.75) return "[0.5,0.75)";
  return "[0.75,1]";
}

export function buildCalibration(outcomes: CalibrationOutcome[]): Calibration {
  const settled = outcomes.filter((row) => row.outcome === "win" || row.outcome === "loss");
  const grouped = new Map<string, Omit<CalibrationBucket, "winRate">>();
  for (const row of settled) {
    const bucket = confidenceBucket(row.confidence);
    const key = JSON.stringify([row.investor, row.signalType, bucket]);
    const current = grouped.get(key) ?? {
      investor: row.investor,
      signalType: row.signalType,
      confidenceBucket: bucket,
      sampleSize: 0,
      wins: 0,
      losses: 0,
    };
    current.sampleSize += 1;
    if (row.outcome === "win") current.wins += 1;
    else current.losses += 1;
    grouped.set(key, current);
  }
  const buckets = [...grouped.values()]
    .map((bucket) => ({ ...bucket, winRate: bucket.wins / bucket.sampleSize }))
    .sort((left, right) =>
      left.investor.localeCompare(right.investor) ||
      left.signalType.localeCompare(right.signalType) ||
      BUCKET_ORDER[left.confidenceBucket] - BUCKET_ORDER[right.confidenceBucket]
    );
  return { sampleSize: settled.length, buckets };
}

export function serializeCalibration(calibration: Calibration): string {
  return `${JSON.stringify(calibration, null, 2)}\n`;
}

function parseOutputArg(argv: string[]): string | null {
  const index = argv.indexOf("--output");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value?.trim()) throw new Error("--output requires a path");
  return value;
}

async function loadSettledOutcomes(): Promise<CalibrationOutcome[]> {
  const rows = await LedgerDb.db`
    SELECT se.investor,
           se.signal_type,
           pb.confidence::text AS confidence,
           bo.outcome
    FROM bet_outcomes bo
    JOIN paper_bets pb ON pb.id = bo.paper_bet_id
    JOIN signal_events se ON se.id = pb.event_id
    WHERE bo.outcome IN ('win','loss')
    ORDER BY se.investor ASC, se.signal_type ASC, pb.confidence ASC, bo.id ASC
  `;
  return rows.map((row: Record<string, unknown>) => {
    // numeric(4,3) round-trips through text → Number() can drift
    // (0.7499999 or 0.7500001) due to the text formatter and IEEE-754
    // representation. Round to the schema's precision so the bucket
    // boundary check (`confidence < 0.75`) lands on the canonical
    // value the row was stored with.
    const parsed = Number(row.confidence);
    const confidence = Math.round(parsed * 1000) / 1000;
    return {
      investor: row.investor as string,
      signalType: row.signal_type as string,
      confidence,
      outcome: row.outcome as "win" | "loss",
    };
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const calibration = buildCalibration(await loadSettledOutcomes());
  const json = serializeCalibration(calibration);
  const output = parseOutputArg(process.argv.slice(2));
  if (output) await writeFile(output, json, { encoding: "utf8", flag: "wx" });
  process.stdout.write(json);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => LedgerDb.closeDb());
}
