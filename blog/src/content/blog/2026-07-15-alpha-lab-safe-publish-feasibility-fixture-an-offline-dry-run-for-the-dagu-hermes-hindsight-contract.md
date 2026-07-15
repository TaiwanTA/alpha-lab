---
title: >-
  Alpha Lab safe-publish feasibility fixture: an offline dry-run for the
  Dagu–Hermes–Hindsight contract
date: '2026-07-15'
summary: >-
  A synthetic, offline, non-investment dry-run fixture used solely to verify the
  Dagu-to-Hermes-to-Hindsight integration contract before any real research
  workflow is built on top of it.
status: unverified
tags:
  - 系統驗證
investors: []
tickers: []
investmentClaim: false
---

The artefact described in this post is the **Alpha Lab safe-publish feasibility fixture**, a synthetic, offline, deterministic input that the Dagu `feasibility-check` DAG consumes to verify the Dagu-to-Hermes-to-Hindsight contract. It is explicitly *not* a research output. It carries no X corpus, no news corpus, no crawl data, and no downstream investment recommendation, and it is designed so that it cannot be confused with a real research artefact produced by the Alpha Lab pipeline.

The fixture's single retained statement of fact is intentionally self-referential: the alpha-lab safe-publish feasibility fixture is a synthetic, offline input whose only purpose is to prove the Dagu–Hermes–Hindsight contract, and it must not be treated as a real research artefact. Because the payload describes the fixture itself, the run is a clean contract check: if Hermes preserves the statement and the single canonical HTTPS source URL in the produced Markdown, the dry-run is considered successful, and no further inference about markets, securities, or investors is attempted.

The prior observations recalled from the Hindsight bank `alpha-lab-v3-fixture` reinforce the same scope boundary from many angles. They consistently describe the fixture as non-investment, non-financial, deterministic, and explicitly synthetic, with exactly one short factual statement and one valid HTTPS source. This convergence is itself part of the contract: the memory layer is expected to retain the fact that the fixture is a dry-run, so that any future recall cannot accidentally promote fixture data into real research output. The tag `系統驗證` (system validation) is the only one applied here, and the post carries no investors and no tickers, in line with the fixture's non-investment nature.

## 來源

<!-- alpha-lab runtime: 7b96bac1b73a3c04738d84601b1361b7ccad7407 -->

https://example.com/fixture-source
