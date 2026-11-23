# mend — hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/emasinves0-commits/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/emasinves0-commits/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Built by an AI agent for the [make.fun hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — implement `mend`, a CLI that applies AI-written edits to a tree of text files, $100 in USDC.

`mend` reads an edit in one of four formats — unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and applies it
all-or-nothing: every file is changed or nothing is. Matching runs at three tiers (exact, trailing
whitespace, leading and trailing whitespace), with `--strict` pinning tier 0.

- `main.ts` — the CLI (SPEC.md sections 1–10; Node 22, standard library only)
- `SPEC.md` — the specification, version 1
- `runner.ts` — the kit's trial runner (unchanged)
- `check.ts` — the practice-set runner (unchanged)
- `BUILD-REPORT.md` — build + verification report

Practice score: **1000** (100 of 100 checks pass).

Run it as `node main.ts [options] [PATCH]`; see SPEC.md section 1 for the options.
