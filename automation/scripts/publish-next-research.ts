#!/usr/bin/env bun

import { LedgerDb } from "./phase4/db.ts";

function requiredValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

export async function claimNextResearchPublication(owner: string): Promise<{
  action: "publish" | "finalize";
  researchRunId: string;
} | null> {
  const pushed = await LedgerDb.ResearchRun.claimNextPushed(owner);
  if (pushed) return { action: "finalize", researchRunId: pushed.id };
  const run = await LedgerDb.ResearchRun.claimNextUnpublished(owner);
  return run ? { action: "publish", researchRunId: run.id } : null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const argv = process.argv.slice(2);
  const owner = requiredValue(argv, "--owner");
  if (argv.includes("--mark-pushed")) {
    await LedgerDb.ResearchRun.markPushed(requiredValue(argv, "--mark-pushed"), owner);
    return;
  }
  if (argv.includes("--revert-pushed")) {
    await LedgerDb.ResearchRun.revertPushed(requiredValue(argv, "--revert-pushed"), owner);
    return;
  }
  if (argv.includes("--mark-published")) {
    await LedgerDb.ResearchRun.markPublished(requiredValue(argv, "--mark-published"), owner);
    return;
  }
  if (argv.includes("--release-claim")) {
    await LedgerDb.ResearchRun.releasePublicationClaim(requiredValue(argv, "--release-claim"), owner);
    return;
  }
  const claim = await claimNextResearchPublication(owner);
  if (claim) process.stdout.write(`${JSON.stringify(claim)}\n`);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => LedgerDb.closeDb());
}
