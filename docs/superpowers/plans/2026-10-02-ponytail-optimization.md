# Ponytail cleanup implementation plan

> Implement the audit already approved in this chat. Work in the current checkout and preserve its attachment-send changes. No commit or deployment is part of this task.

**Goal:** Remove verified unused code and dependencies, consolidate identical formatting, and replace handwritten CRC32 without changing active business behavior.

**Architecture:** Keep the existing Nuxt/Vue, Electron and FastAPI/DeepAgents architecture. Delete unreachable production implementations; retain current history, archive/recovery, receipt validation and security boundaries. GPU configuration is a profiling candidate, not an approved automatic change.

**Spec:** The preceding Ponytail Audit report and the user's authorization to implement it.

## Tasks and verification

- [x] Frontend: remove the unused heatmap/replay/stack/edited-preview components and assistant-ui adapters; remove the unused health-poll/plugin/store/banner chain and its writes/styles; share the three identical formatBytes functions; remove direct axios dependency with a consistent lockfile. Verify references, formatting boundaries, frontend tests and static generation.
- [x] Backend: remove isaac64.py, the unused full-message-reader pair, unused platform resource probes, SNS raw-row counter and HTML seal wrapper. Verify references and focused reader/export/SNS/platform tests without accessing personal data.
- [x] AI: remove the unreachable old context/query/report/subtask/model execution paths. First identify direct tests and preserve or migrate meaningful behavior assertions to current production paths. Keep shared parsing/audit helpers and all history/archive/recovery contracts. Run focused AI tests and collection checks. Do not move the obsolete engine into tests merely to keep it alive.
- [x] AI deadline regression found during migration: reproduce the coarse-clock queue timeout in the current Deep model, retain the real timeout context's expired state, and stop only when the total deadline has expired. Verify that an earlier per-attempt timeout can still retry within the total budget.
- [x] Desktop: replace handwritten CRC32 with node:zlib.crc32 and remove unused concurrently direct dependency, updating its lockfile. Verify binary ZIP interoperability, CRC fixtures and focused desktop tests.
- [x] Integration: review all diffs; check preservation of pre-existing work; run source/reference checks, diff whitespace checks and the relevant combined regressions; report exact results and environmental limitations.

## Review focus

- Production imports may still use functions from an otherwise legacy-named module: preserve those functions.
- Removing unused components must account for Nuxt automatic and dynamic component resolution.
- Health-poll deletion must leave actual request errors visible and account selection behavior intact.
- ZIP output must retain UTF-8 filenames, payload checksums and existing metadata.
- Test migration must exercise the current implementation; no deletion of valuable assertions or fake success paths.

The original 28 changed/untracked files and diff are backed up under `.work/ponytail-optimization-20261002/`.

## Verification record

- Production change against the pre-task workspace: 32 files, +27/-5462 lines (net -5435). Removed two direct dependencies, axios and concurrently; no dependency version upgrades.
- Existing attachment-send work: 26 of the original 28 files remain byte-identical. The other two have only the planned CRC32 replacement in main.cjs and health-check removal in useApi.js.
- Frontend: 76 Node tests and 558 Vitest tests passed; static generation produced 34 routes. Logs: frontend-tests.log and frontend-generate.log in the backup directory. Four Python session-layout contracts also passed after removing the deleted preview component's assertion while retaining the live message avatar checks.
- Backend cleanup: 35 focused export/SNS/platform tests passed, with 19 subtests. Desktop: 48 focused ZIP/attachment/package/startup tests passed, plus Python ZIP interoperability checks.
- ZIP microbenchmark: Electron 40.0.0 / Node 24.11.1, one 8 MiB entry, three warmups and nine alternating samples. Median build time changed from 15.385 ms to 2.034 ms; old/new ZIP bytes were identical. This measures the ZIP builder only. Raw samples: zip-benchmark.json.
- AI archive/recovery/relay/governance protection: 170 tests passed. Test migration coverage is recorded in ai-test-map.md in the backup directory.
- Initial combined AI verification exposed an existing unreset test call-policy context; corrected the originating diagnostics test with the existing model_policy context manager. A synchronous-stream deadline test now advances the business clock explicitly after the first chunk, preserving strict partial-output/no-retry assertions without depending on a 50 ms machine-speed assumption.
- Deep total-deadline regression: the failing test reproduced three queue entries after the real timeout expired before the coarse business clock advanced. The production fix now observes the actual timeout context's expired state; an independent per-attempt timeout can still retry within the total budget.
- Final combined AI/catalog regression: all 56 files, 828 passed in 492.71 seconds; two existing LangChain beta warnings. Log: ai-combined-final.log. Command: `.venv/Scripts/python.exe -X utf8 -m pytest <sorted tests/test_ai*.py> tests/test_model_catalog.py -q --tb=short --maxfail=5 -p no:cacheprovider --basetemp=.work/ponytail-ai-combined-final`.
- Whole-project test discovery: 2760 tests collected successfully in 2.80 seconds (collection-final.log); this is discovery, not execution of the whole backend suite. Source reference checks and `git diff --check` passed. Independent review found no further actionable complexity in this cleanup.
- No personal database, real model request, real WeChat send, installer packaging or desktop UI performance claim is part of this validation. Generated frontend output has not been copied into an installed desktop application.
