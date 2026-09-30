"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ARTIFACT_NAME,
  BINARY_NAME,
  resolveIntegrityNativeArtifact,
} = require("../scripts/integrity-native-packaging.cjs");

test("accepts Windows platform configuration and reports PKI managed status", () => {
  const resolved = resolveIntegrityNativeArtifact({
    platform: "win32",
  });
  assert.equal(resolved.platform, "win32");
  assert.equal(resolved.binaryName, BINARY_NAME);
  assert.equal(resolved.status, "windows-pki-managed");
  assert.equal(ARTIFACT_NAME, "wce-integrity-windows-x64");
  assert.equal(BINARY_NAME, "wce_integrity.pyd");
});

test("rejects non-Windows platforms (darwin / linux)", () => {
  assert.throws(
    () => resolveIntegrityNativeArtifact({ platform: "darwin" }),
    /Windows-only/
  );
  assert.throws(
    () => resolveIntegrityNativeArtifact({ platform: "linux" }),
    /Windows-only/
  );
});
