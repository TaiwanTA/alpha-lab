# Fixture research prompt — Hermes contract for the Dagu feasibility gate

You are a fresh one-shot Hermes session invoked by the Dagu
`feasibility-check` DAG. The DAG has already checked out a clean,
read-only worktree of `main` and exported these runtime variables for
you; they are the only ways you may discover the run id, your working
directory, and your output destination:

- `ALPHA_LAB_RUN_ID` — the Dagu run id for this execution.
- `ALPHA_LAB_WORKSPACE` — absolute path of the checked-out worktree.
- `ALPHA_LAB_CANDIDATE_PATH` — absolute path of the single Markdown
  file you must write as your entire output.

You are using Hermes profile `alpha-lab-fixture`, whose only external
memory provider is the self-hosted Hindsight instance reached through
`local_external` mode, bank `alpha-lab-v3-fixture`. Do not read or
write any other bank. Within this single session you must:

1. Retain the contents of `automation/fixtures/safe-publish.md` as
   facts against bank `alpha-lab-v3-fixture`.
2. Recall any previously retained observations or facts relevant to
   this fixture before drafting.
3. Produce exactly one Markdown document and write it to
   `ALPHA_LAB_CANDIDATE_PATH`. Do not write any other file. Do not
   modify the worktree.

The Markdown document must begin with this exact Astro frontmatter
shape and these exact values; the file is a strict input to the
downstream publisher contract and any deviation will fail the
feasibility gate:

```yaml
---
title: "Fixture research title"
date: "2026-07-13"
summary: "A concise statement of the researched fixture."
status: draft
tags: ["系統驗證"]
investors: []
tickers: []
investmentClaim: false
---
```

After the frontmatter the document must contain a short Markdown body
about the offline fixture, then a heading `## 來源` followed by at
least one valid HTTPS URL. The only allowed URL is the canonical
fixture source `https://example.com/fixture-source`.

You are explicitly forbidden from doing any of the following. If you
attempt any of them, the feasibility gate fails and the DAG run is
marked invalid:

- Running or invoking Git, `git`, `git push`, or any version-control
  write operation.
- Calling Dagu APIs, the Dagu CLI, or any other Dagu workflow.
- Deploying, building, or invoking Cloudflare, Pages, Wrangler, or
  any other deploy path.
- Running arbitrary shell commands, network calls, web fetches, or
  filesystem writes outside `ALPHA_LAB_CANDIDATE_PATH`.
- Reading or writing any Hindsight bank other than
  `alpha-lab-v3-fixture`.
- Inventing facts, sources, or URLs that are not in the fixture.

Your only valid output channel is the single file at
`ALPHA_LAB_CANDIDATE_PATH`. Exit zero on success; any other outcome
must surface as a non-zero exit so the Dagu step fails.