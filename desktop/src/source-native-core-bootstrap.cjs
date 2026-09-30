"use strict";

const {
  ENV_SOURCE_NATIVE_CORE_DIR,
} = require("./native-core-path.cjs");
const {
  ASSET_NAME,
  DEFAULT_CONFIG_PATH,
  ENV_SOURCE_NATIVE_CORE_CACHE_DIR,
  PROFILE,
  ensureWindowsSourceNativeCore,
  publicReleaseUrl,
  validatePin,
  validateWindowsSourceRuntimeDirectory,
} = require("./windows-source-native-core-bootstrap.cjs");

function applySourceRuntimeEnvironment(env, result) {
  const target = env || process.env;
  if (!result?.nativeDir) return target;
  target[ENV_SOURCE_NATIVE_CORE_DIR] = result.nativeDir;
  return target;
}

function ensureSourceNativeCore(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    throw new Error(`Only Windows is supported; received platform: ${platform}`);
  }
  return ensureWindowsSourceNativeCore(options);
}

module.exports = {
  ASSET_NAME,
  DEFAULT_CONFIG_PATH,
  ENV_SOURCE_NATIVE_CORE_CACHE_DIR,
  ENV_SOURCE_NATIVE_CORE_DIR,
  PROFILE,
  applySourceRuntimeEnvironment,
  ensureSourceNativeCore,
  publicReleaseUrl,
  validateDownloadedSourceArtifact: validateWindowsSourceRuntimeDirectory,
  validatePin,
  validateSourceRuntimeDirectory: validateWindowsSourceRuntimeDirectory,
};
