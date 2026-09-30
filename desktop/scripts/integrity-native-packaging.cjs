"use strict";

const ARTIFACT_NAME = "wce-integrity-windows-x64";
const BINARY_NAME = "wce_integrity.pyd";
const ARTIFACT_FILE_NAMES = Object.freeze([BINARY_NAME]);
const CHECKSUM_FILE_NAMES = Object.freeze([BINARY_NAME]);

function resolveIntegrityNativeArtifact({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    throw new Error(`Integrity native packaging is Windows-only; unsupported platform: ${platform}`);
  }
  return {
    platform: "win32",
    binaryName: BINARY_NAME,
    status: "windows-pki-managed",
  };
}

module.exports = {
  ARTIFACT_FILE_NAMES,
  ARTIFACT_NAME,
  BINARY_NAME,
  CHECKSUM_FILE_NAMES,
  resolveIntegrityNativeArtifact,
};
