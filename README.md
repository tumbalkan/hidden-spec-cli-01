# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tumbalkan/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tumbalkan/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one command-line patch tool for every AI edit format — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON edits — with three-tier fuzzy line matching (exact, trailing-whitespace, re-indented) and all-or-nothing writes. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=auto|unified|search-replace|v4a|json`, `--check` (dry run), `--strict` (exact matching only). PATCH is read from standard input when absent or `-`.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. `SPEC.md` is the whole contract it implements.
- `runner.ts`: the kit's trial runner (kept as the kit has it); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts`: the practice set on your own machine: `node check.ts <practice.json>`.
- `SPEC.md`: the specification (version 1).

## Verification

Practice set (100 checks, the kit's `program/generator/practice.json`): **100 of 100 passed, practice score 1000** — unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15. `grade-local` on the practice trial: score 1000, passed 100, replay matched byte for byte, 0 nondeterministic. 22 additional edge-case probes (no-newline handling, empty-O insertion, path inheritance, pure moves, CRLF + tier 2, nearest-tie, multi-hunk drift, strict anchors) all pass.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
