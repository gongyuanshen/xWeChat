const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");

test("SNS media CI covers Windows x64 without release secrets", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "sns-media-cross-platform.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /os:\s*windows-2022/);
  assert.match(workflow, /arch:\s*x64/);
  assert.match(workflow, /tests\/sns-wasm-runtime\.test\.cjs/);
  assert.match(workflow, /tests\/sns-media-source\.test\.mjs/);
  assert.match(workflow, /tests\/test_sns_media\.py/);
  assert.doesNotMatch(workflow, /secrets\.|environment:\s*windows-private-pki-production/);
});

test("development launcher owns the Electron process tree directly", () => {
  const source = fs.readFileSync(path.join(desktopRoot, "scripts", "dev.cjs"), "utf8");
  assert.match(source, /const electronCommand = require\("electron"\);/);
  assert.match(source, /shell: options\.shell \?\? \(process\.platform === "win32"\)/);
  assert.match(source, /windowsHide: false/);
  assert.doesNotMatch(source, /detached: true/);
  assert.doesNotMatch(source, /const electronCommand = "electron";/);
});
