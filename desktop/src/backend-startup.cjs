const DEVELOPMENT_BACKEND_STARTUP_TIMEOUT_MS = 30_000;
// PyInstaller onefile extraction/imports are silent; captured cold starts have exceeded 90 seconds.
const PACKAGED_BACKEND_STARTUP_TIMEOUT_MS = 180_000;
const MIN_BACKEND_STARTUP_TIMEOUT_MS = 5_000;
const MAX_BACKEND_STARTUP_TIMEOUT_MS = 600_000;

function resolveBackendStartupTimeoutMs({ isPackaged = false, envValue } = {}) {
  const defaultTimeout = isPackaged
    ? PACKAGED_BACKEND_STARTUP_TIMEOUT_MS
    : DEVELOPMENT_BACKEND_STARTUP_TIMEOUT_MS;
  const raw = String(envValue ?? "").trim();
  if (!raw) return defaultTimeout;

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_BACKEND_STARTUP_TIMEOUT_MS ||
    parsed > MAX_BACKEND_STARTUP_TIMEOUT_MS
  ) {
    throw new RangeError(`后端启动超时必须为 ${MIN_BACKEND_STARTUP_TIMEOUT_MS}-${MAX_BACKEND_STARTUP_TIMEOUT_MS} 毫秒的整数`);
  }
  return parsed;
}

function shouldRetryBackendOnDifferentPort({
  isPackaged = false,
  portAvailableAfterFailure = true,
  backendProcessStillRunning = false,
} = {}) {
  return Boolean(
    isPackaged &&
      !backendProcessStillRunning &&
      portAvailableAfterFailure === false
  );
}

function parseHealthJson(response) {
  if (Number(response?.statusCode) !== 200) return null;
  try {
    const parsed = JSON.parse(String(response?.body || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isBackendHealthResponse(response) {
  const payload = parseHealthJson(response);
  return payload?.status === "healthy" && payload?.service === "xwechat";
}

module.exports = {
  DEVELOPMENT_BACKEND_STARTUP_TIMEOUT_MS,
  PACKAGED_BACKEND_STARTUP_TIMEOUT_MS,
  isBackendHealthResponse,
  resolveBackendStartupTimeoutMs,
  shouldRetryBackendOnDifferentPort,
};
