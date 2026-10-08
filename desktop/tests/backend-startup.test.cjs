const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEVELOPMENT_BACKEND_STARTUP_TIMEOUT_MS,
  PACKAGED_BACKEND_STARTUP_TIMEOUT_MS,
  isBackendHealthResponse,
  resolveBackendStartupTimeoutMs,
  shouldRetryBackendOnDifferentPort,
} = require("../src/backend-startup.cjs");

test("health checks require the expected 200 JSON identity", () => {
  assert.equal(
    isBackendHealthResponse({
      statusCode: 200,
      body: JSON.stringify({ status: "healthy", service: "xwechat" }),
    }),
    true
  );
  assert.equal(isBackendHealthResponse({ statusCode: 404, body: "{}" }), false);
  assert.equal(isBackendHealthResponse({ statusCode: 200, body: "not-json" }), false);
  assert.equal(
    isBackendHealthResponse({ statusCode: 200, body: JSON.stringify({ status: "healthy" }) }),
    false
  );
});

test("packaged backend allows PyInstaller onefile cold starts longer than 30 seconds", () => {
  assert.equal(DEVELOPMENT_BACKEND_STARTUP_TIMEOUT_MS, 30_000);
  assert.equal(PACKAGED_BACKEND_STARTUP_TIMEOUT_MS, 180_000);
  assert.equal(resolveBackendStartupTimeoutMs({ isPackaged: false }), 30_000);
  assert.equal(resolveBackendStartupTimeoutMs({ isPackaged: true }), 180_000);
});

test("backend startup timeout accepts a bounded support override", () => {
  assert.equal(
    resolveBackendStartupTimeoutMs({ isPackaged: true, envValue: "240000" }),
    240_000
  );
  for (const envValue of ["not-a-number", "999", "600001", "10000.5"]) {
    assert.throws(() => resolveBackendStartupTimeoutMs({ isPackaged: true, envValue }), /启动超时/);
  }
});

test("a slow live process does not trigger port walking even after binding its port", () => {
  assert.equal(
    shouldRetryBackendOnDifferentPort({ isPackaged: true, portAvailableAfterFailure: true }),
    false
  );
  assert.equal(
    shouldRetryBackendOnDifferentPort({ isPackaged: true, portAvailableAfterFailure: false }),
    true
  );
  assert.equal(
    shouldRetryBackendOnDifferentPort({
      isPackaged: true,
      portAvailableAfterFailure: false,
      backendProcessStillRunning: true,
    }),
    false
  );
  assert.equal(
    shouldRetryBackendOnDifferentPort({ isPackaged: false, portAvailableAfterFailure: false }),
    false
  );
});
