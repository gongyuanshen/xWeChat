# WXGF frozen worker and Windows release plan

> **For agentic workers:** Use superpowers:executing-plans to implement the steps below with verification after each change.

**Goal:** Decode WXGF in the packaged backend, then rebuild and publish the current Windows application.

**Architecture:** Reuse the backend executable as a bounded decoder child process through `--wxgf-decode-worker input output`. Source launches retain the existing isolated Python script. DLL calls, metadata checks, cancellation, timeout and process cleanup stay shared.

**Tech Stack:** Python 3.11, ctypes/Pillow, PyInstaller, Electron/electron-builder.

**Constraints:** Preserve existing workspace changes and user data. Remove only verified local build outputs. Publish reviewed source and generated release assets; exclude private data and credentials. Never replace failed decoding with a successful/default result.

- [x] Reproduce the frozen rejection and premature server imports with failing tests.
- [x] Modify `wxgf_codec.py` and `backend_entry.py` to dispatch the worker before application startup; run codec, entrypoint and media regressions (58 passed).
- [x] Review version metadata, dependency locks and the source allowlist; remove old local installer/ZIP and their sidecars after checking resolved paths.
- [x] Build the current UI/backend and Windows installer/ZIP from scratch. Verify real frozen WXGF decoding with static, transparent and animated fixtures, plus packaged API startup and checksums. Audit installer resources with an explicit EXE/DLL/JS/WASM allowlist; exclude logs, Python caches and smoke fixtures.
- [ ] Update README limitations using the observed evidence, commit the reviewed source, create a matching tag, upload the release, verify remote assets and publish.

**Review focus:** Worker must not start the API/watchdog; invalid arguments and corrupted images must fail; native crashes must stay in the child; timeout/cancellation must reap the child; actual frozen-parent execution must be distinguished from source-mode and direct-worker checks.
