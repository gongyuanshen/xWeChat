"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { ensureSourceNativeCore } = require("../src/source-native-core-bootstrap.cjs");
const { resolveNativeCoreArtifacts } = require("./build-backend.cjs");

const desktopRoot = path.resolve(__dirname, "..");

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot, env, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}).`);
}

function main() {
  if (process.platform !== "win32") throw new Error("This build requires Windows x64.");
  if (process.arch !== "x64") throw new Error("This build requires an x64 Node.js runtime.");
  if (process.argv.length > 2) throw new Error("This build does not accept command-line overrides.");
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.statSync(npmCli).isFile()) {
    throw new Error("Run npm --prefix desktop run dist:win:unsigned.");
  }

  // Use the same pinned public runtime as source launches. No signing keys are needed.
  const runtime = ensureSourceNativeCore({ env: process.env });
  const env = { ...process.env, WCE_NATIVE_CORE_ARTIFACT_DIR: runtime.nativeDir };
  delete env.WCE_NATIVE_CORE_ALLOW_DEVELOPMENT_ARTIFACTS;
  const { manifest } = resolveNativeCoreArtifacts({ env });
  const rootCertificate = path.join(desktopRoot, "resources", "native-core-source-root.cer");
  const rootSha256 = crypto.createHash("sha256").update(fs.readFileSync(rootCertificate)).digest("hex").toUpperCase();
  if (rootSha256 !== manifest.windowsPrivateRootSha256) {
    throw new Error("The public root certificate does not match the pinned native runtime.");
  }
  env.WCE_WINDOWS_PRIVATE_ROOT_CERT_PATH = rootCertificate;
  env.WCE_WINDOWS_PRIVATE_ROOT_SHA256 = rootSha256;
  console.log(`Public native runtime: ${manifest.buildId}; expires ${new Date(manifest.buildExpiresAtUnix * 1000).toISOString()}`);

  for (const script of ["build:ui", "build:backend", "build:icon"]) {
    run(process.execPath, [npmCli, "run", script], env);
  }
  run(process.execPath, [
    require.resolve("electron-builder/cli.js"), "--win", "--x64", "--publish", "never",
    "-c.win.forceCodeSigning=false", "-c.win.signExecutable=false",
  ], env);

  const powershellEnv = { ...env };
  // Let PowerShell 5 initialize its own module paths instead of inheriting PowerShell 7 paths.
  for (const name of Object.keys(powershellEnv)) {
    if (name.toLowerCase() === "psmodulepath") delete powershellEnv[name];
  }
  run(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(__dirname, "installer-install-dir.ps1"),
    "-Mode", "GrantRuntimeAccess", "-InstallDir", path.join(desktopRoot, "dist", "win-unpacked"),
  ], powershellEnv);
}

try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
