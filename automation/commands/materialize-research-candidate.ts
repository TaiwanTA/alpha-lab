#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { LedgerDb } from "../lib/db.ts";

function parseArgs(argv: string[]): { researchRunId: string; claimOwner: string; output: string } {
  const runIndex = argv.indexOf("--research-run-id");
  const ownerIndex = argv.indexOf("--owner");
  const outputIndex = argv.indexOf("--output");
  const researchRunId = runIndex >= 0 ? argv[runIndex + 1] : undefined;
  const claimOwner = ownerIndex >= 0 ? argv[ownerIndex + 1] : undefined;
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (!researchRunId?.trim()) throw new Error("--research-run-id is required");
  if (!claimOwner?.trim()) throw new Error("--owner is required");
  if (!output?.trim()) throw new Error("--output is required");
  return { researchRunId, claimOwner, output };
}

export async function materializeResearchCandidate(
  researchRunId: string,
  claimOwner: string,
  output: string,
): Promise<void> {
  const run = await LedgerDb.ResearchRun.findPublishableById(researchRunId, claimOwner);
  if (!run) throw new Error(`claimed research run not found: ${researchRunId}`);
  if (!run.candidate_markdown.trim()) {
    throw new Error(`stored candidate_markdown is empty: ${researchRunId}`);
  }
  await writeFile(output, run.candidate_markdown, { encoding: "utf8", flag: "wx" });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const args = parseArgs(process.argv.slice(2));
  await materializeResearchCandidate(args.researchRunId, args.claimOwner, args.output);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => LedgerDb.closeDb());
}
