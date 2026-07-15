---
title: >-
  Alpha Lab safe-publish feasibility fixture: an offline dry-run for the
  Dagu-to-Hermes-to-Hindsight contract
date: '2026-07-14'
summary: >-
  A synthetic, non-investment integration fixture used by the Dagu
  feasibility-check DAG to verify the Dagu–Hermes–Hindsight contract before any
  real research workflow is built.
status: unverified
tags:
  - 系統驗證
investors: []
tickers: []
investmentClaim: false
---

This post documents a synthetic, offline dry-run rather than a research finding. The Alpha Lab safe-publish feasibility fixture is a deliberate, non-investment and non-financial input consumed by the Dagu `feasibility-check` DAG. Its sole purpose is to prove the integration contract between Dagu, Hermes, and Hindsight — confirming that a fact can be retained by Hermes, written into the Hindsight bank `alpha-lab-v3-fixture`, and later surfaced back as a Markdown artefact — before any real research or publication workflow is built on top of the same pipeline.

By design, the fixture carries exactly one short statement of fact and one canonical HTTPS source. There is no X corpus, no news corpus, no crawl data, and no downstream investment recommendation. The retained fact states that the alpha-lab safe-publish feasibility fixture is a synthetic, offline input whose only purpose is to prove the Dagu–Hermes–Hindsight contract, and that it must not be treated as a real research artefact. The single preserved source is the canonical HTTPS reference Hermes is required to carry through into the produced Markdown, so the end-to-end source-preservation behaviour can be validated in isolation from any real-world data.

The value of the fixture is precisely that it cannot be confused with a real research output. It exercises the structural pieces of the pipeline — deterministic input, single retained fact, single HTTPS source, frontmatter-shaped Markdown, and a `## 來源` section with exactly one URL — without introducing any market, security, or entity-specific claims. A clean run through this fixture is the green light that the same shape of workflow can later be pointed at genuine research material without changing the integration contract.

## 來源

<!-- alpha-lab runtime: 382f87b74058611cdb22f27700648f2c2b5bf983 -->

https://example.com/fixture-source
