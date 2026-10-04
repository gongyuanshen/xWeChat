const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));

test("desktop package excludes the retired Koffi and WCDB sidecar runtime", () => {
  const nodeModulesRule = packageJson.build.files.find(
    (item) => item && typeof item === "object" && item.from === "node_modules"
  );
  assert.equal(nodeModulesRule, undefined);
  assert.equal(packageJson.dependencies.koffi, undefined);
  assert.equal(packageJson.build.asarUnpack, undefined);
  assert.ok(packageJson.build.files.includes("!src/wcdb-sidecar.cjs"));
});

test("desktop package keeps Electron run-as-node enabled for the SNS WASM helper", () => {
  assert.equal(packageJson.build.electronFuses?.runAsNode, true);
});

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

test("desktop package ships ffmpeg only as an external resource with its license", () => {
  const { FileMatcher, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher.js");
  const resource = packageJson.build.extraResources.find(
    (item) => item && item.from === "node_modules/ffmpeg-static"
  );
  assert.ok(resource);
  assert.equal(resource.to, "ffmpeg");
  const binary = require("ffmpeg-static");
  const destination = path.join(desktopRoot, "dist", "ffmpeg-filter-check");
  const resourceFilter = new FileMatcher(
    path.join(desktopRoot, resource.from), destination, (value) => value, resource.filter
  ).createFilter();
  for (const file of [binary, `${binary}.LICENSE`, `${binary}.README`, path.join(path.dirname(binary), "LICENSE")]) {
    assert.equal(resourceFilter(file, fs.statSync(file)), true, `missing ffmpeg resource: ${path.basename(file)}`);
  }
  const dependencyFilter = getNodeModuleFileMatcher(
    desktopRoot, destination, (value) => value, packageJson.build.win,
    { config: packageJson.build, debugLogger: { isEnabled: false } }
  ).createFilter();
  assert.equal(dependencyFilter(binary, fs.statSync(binary)), false, "ffmpeg binary must not be duplicated in application dependencies");
});

test("Windows package uses private-PKI signing while preserving producer signatures", () => {
  const signingResource = packageJson.build.extraResources.find(
    (item) => item && item.from === "resources/signing"
  );
  assert.ok(signingResource);
  assert.deepEqual([...signingResource.filter].sort(), [
    "windows-private-pki-root.cer",
    "windows-private-pki.ps1",
  ]);
  assert.equal(packageJson.build.win.forceCodeSigning, true);
  assert.ok(packageJson.build.win.signExts.includes("!wechatdb_broker.exe"));
  assert.ok(packageJson.build.win.signExts.includes("!wechatdb_client.dll"));
  assert.ok(packageJson.build.win.signExts.includes("wce_integrity.pyd"));
  assert.ok(packageJson.build.win.signExts.includes("img_helper.dll"));
  assert.equal(
    packageJson.build.win.signtoolOptions.sign,
    "./scripts/windows-private-pki-sign.cjs"
  );
  assert.deepEqual(packageJson.build.win.signtoolOptions.publisherName, ["WDA Private PKI"]);
  assert.deepEqual(packageJson.build.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
  assert.match(
    packageJson.build.win.signtoolOptions.rfc3161TimeStampServer,
    /^https?:\/\//
  );
});

test("Windows release uses protected cloud private-PKI signing and installer smoke", () => {
  const smokeScript = path.join(desktopRoot, "scripts", "smoke-windows-package.cjs");
  assert.equal(packageJson.scripts["smoke:win"], "node scripts/smoke-windows-package.cjs");
  assert.equal(
    packageJson.scripts["smoke:win:real"],
    "node scripts/smoke-windows-real-database.cjs"
  );
  assert.ok(fs.existsSync(smokeScript), smokeScript);
  const smokeSource = fs.readFileSync(smokeScript, "utf8");
  assert.match(smokeSource, /wechat-backend\.exe/);
  assert.match(smokeSource, /wechatdb_client\.dll/);
  assert.match(smokeSource, /wechatdb_broker\.exe/);
  assert.match(smokeSource, /\/api\/health/);
  assert.match(smokeSource, /smokeElectronApp/);
  assert.match(smokeSource, /smokeElectronNodeWasm/);
  assert.match(smokeSource, /smokePackagedBackendWasm/);
  assert.match(smokeSource, /AUTO_UPDATE_ENABLED:\s*"0"/);

  const workflow = fs
    .readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const windowsJob = workflow.match(
    /\n  build-windows:\n([\s\S]*?)(?=\n  [A-Za-z0-9_-]+:\n|$)/
  )?.[1] || "";
  const rebuildRelease = fs.readFileSync(
    path.join(repoRoot, "tools", "rebuild_wcdb_release.py"), "utf8"
  );
  assert.match(windowsJob, /runs-on:\s*windows-2022/);
  assert.match(windowsJob, /environment:\s*windows-private-pki-production/);
  assert.match(windowsJob, /fetch-depth:\s*0/);
  assert.match(windowsJob, /persist-credentials:\s*false/);
  assert.match(windowsJob, /\$tagCommit\s+-cne\s+\$head/);
  assert.match(windowsJob, /git merge-base --is-ancestor \$tagRef origin\/main/);
  assert.match(windowsJob, /WCE_WINDOWS_CLIENT_CERT_THUMBPRINT/);
  assert.match(
    windowsJob,
    /WCE_WINDOWS_CLIENT_SIGNING_PFX_BASE64:\s*\$\{\{ secrets\.WCE_WINDOWS_CLIENT_SIGNING_PFX_BASE64 \}\}/
  );
  assert.match(
    windowsJob,
    /WCE_WINDOWS_CLIENT_SIGNING_PFX_PASSWORD:\s*\$\{\{ secrets\.WCE_WINDOWS_CLIENT_SIGNING_PFX_PASSWORD \}\}/
  );
  assert.match(
    windowsJob,
    /WCE_WINDOWS_PRIVATE_ROOT_CERT_BASE64:\s*\$\{\{ secrets\.WCE_WINDOWS_PRIVATE_ROOT_CERT_BASE64 \}\}/
  );
  assert.match(windowsJob, /Import-WindowsCloudSigningIdentity\.ps1/);
  assert.match(windowsJob, /Remove-WindowsCloudSigningIdentity\.ps1/);
  assert.match(windowsJob, /if:\s*always\(\)/);
  assert.match(windowsJob, /steps\.cloud-signing\.outputs\.client-thumbprint/);
  assert.match(windowsJob, /steps\.cloud-signing\.outputs\.root-certificate-path/);
  assert.match(windowsJob, /WCE_WINDOWS_SIGNING_ASSURANCE/);
  assert.match(windowsJob, /Install Python dependencies/);
  assert.match(windowsJob, /Run focused Python release tests/);
  assert.match(windowsJob, /uv sync --frozen/);
  assert.match(windowsJob, /uv run pytest -q/);
  assert.match(windowsJob, /tests\/test_native_core_broker_lifecycle\.py/);
  assert.match(windowsJob, /tests\/test_native_core_device_credential\.py/);
  assert.match(windowsJob, /tests\/test_wcdb_realtime_native_core_required\.py/);
  assert.doesNotMatch(windowsJob, /Prepare signed ephemeral Python test host/);
  assert.doesNotMatch(windowsJob, /WCE_PYTHON_TEST_HOST/);
  assert.doesNotMatch(windowsJob, /WECHAT_TOOL_NATIVE_CORE_(?:LIBRARY|BROKER)/);
  assert.match(windowsJob, /WCE_NATIVE_CORE_SOURCE_REVISION/);
  assert.match(windowsJob, /WCE_NATIVE_CORE_BUILD_ID/);
  assert.match(windowsJob, /WCE_NATIVE_CORE_ARTIFACT_SHA256/);
  assert.match(windowsJob, /WCE_NATIVE_CORE_PRODUCER_TOKEN/);
  assert.match(windowsJob, /python tools\/rebuild_wcdb_release\.py/);
  assert.match(windowsJob, /--component windows-native/);
  assert.match(
    rebuildRelease,
    /"windows-native":\s*\(\s*"windows-native-production\.yml",\s*"wechatdb-native-windows-x64-source-public"/
  );
  assert.match(rebuildRelease, /tag = f"\{component\}-\{build_id\}"/);
  assert.match(rebuildRelease, /asset_name = f"\{artifact_name\}-\{build_id\}\.zip"/);
  assert.match(rebuildRelease, /release\.get\("target_commitish"\) != revision/);
  assert.match(rebuildRelease, /expected_digest = asset\.get\("digest"\)/);
  assert.match(windowsJob, /WCE_WINDOWS_PRIVATE_ROOT_CERT_PATH/);
  assert.match(windowsJob, /WCE_WINDOWS_PRIVATE_ROOT_SHA256/);
  assert.match(windowsJob, /WCE_RFC3161_TIMESTAMP_URL/);
  assert.match(windowsJob, /windows-private-pki-sign\.cjs preflight/);
  assert.match(windowsJob, /provenance\.json/);
  assert.match(windowsJob, /SHA256SUMS\.txt/);
  assert.match(windowsJob, /GitHub releases must not contain a recipient-bound distribution capsule/);
  assert.match(windowsJob, /GitHub releases require the shared public native distribution mode/);
  assert.match(windowsJob, /\$manifestFields -notcontains 'distributionMode'/);
  assert.match(windowsJob, /\$provenance\.build\.distributionMode -cne 'public'/);
  assert.match(windowsJob, /distributionMode = 'public'/);
  assert.match(windowsJob, /offlineBootstrapFeatureBits -ne 3/);
  assert.match(windowsJob, /nativeAsrAuthorization -cne 'database-read'/);
  assert.match(windowsJob, /nativeAsrAuthorization = 'database-read'/);
  assert.match(windowsJob, /offlineExportSealFormat -cne 'WES2'/);
  assert.match(windowsJob, /WCE-AUTOMATED-ANALYSIS-NOTICE-V2/);
  assert.match(windowsJob, /WCE-AI-CHECKPOINT-SET-V3/);
  assert.match(windowsJob, /securityCheckpointCount -ne 7/);
  assert.match(windowsJob, /securityCheckpointSetSha256 -cnotmatch/);
  assert.match(
    windowsJob,
    /\$provenance\.build\.securityCheckpointSetSha256 -cne\s+\$manifest\.securityCheckpointSetSha256/
  );
  assert.match(windowsJob, /WCE_NATIVE_CORE_SECURITY_NOTICE_SHA256/);
  assert.match(windowsJob, /WCE_NATIVE_CORE_SECURITY_CHECKPOINT_SET_SHA256/);
  assert.match(windowsJob, /windowsPrivatePkiLeafRevocation = 'build-and-lease-only'/);
  assert.doesNotMatch(
    windowsJob,
    /WCE_WINDOWS_CLIENT_CSC_LINK|WIN_CSC_KEY_PASSWORD|runs-on:\s*\[self-hosted|wce-production-signing|WCE_SIGNTOOL_PATH|[A-Z]:\\abc\\/i
  );
  assert.match(windowsJob, /Verify signed unpacked Windows runtime/);
  assert.match(windowsJob, /WCE_WINDOWS_INSTALLER_SMOKE_ALLOWED:\s*"1"/);
  assert.match(windowsJob, /run:\s*npm run smoke:win/);
  assert.match(windowsJob, /Run focused desktop release tests/);
  assert.match(windowsJob, /tests\/package-config\.test\.cjs/);
  assert.match(windowsJob, /tests\/native-core-before-pack\.test\.cjs/);
  assert.match(windowsJob, /tests\/native-core-packaging\.test\.cjs/);
  assert.match(windowsJob, /tests\/windows-package-smoke\.test\.cjs/);
  assert.match(windowsJob, /tests\/windows-private-pki-runtime\.test\.cjs/);
  assert.match(windowsJob, /tests\/windows-private-pki-sign\.test\.cjs/);
  assert.doesNotMatch(windowsJob, /tests\/\*\.test\.cjs/);
  assert.match(windowsJob, /Generate Windows release checksums and provenance/);
  assert.match(windowsJob, /Get-FileHash -Algorithm SHA256/);
  assert.match(windowsJob, /\[System\.Text\.Encoding\]::ASCII/);
  assert.match(windowsJob, /release-provenance\.json/);
  assert.match(windowsJob, /WDA_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.match(windowsJob, /WDA_REVISION:\s*\$\{\{ github\.sha \}\}/);
  assert.match(windowsJob, /WDA_TAG:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(windowsJob, /NATIVE_REPOSITORY:/);
  assert.match(windowsJob, /NATIVE_RUN_ID:/);
  assert.match(windowsJob, /NATIVE_REVISION:/);
  assert.match(windowsJob, /NATIVE_BUILD_ID:/);
  assert.match(windowsJob, /NATIVE_CLIENT_SIGNER_SHA256:/);
  assert.match(windowsJob, /NATIVE_BROKER_SIGNER_SHA256:/);
  assert.match(windowsJob, /WINDOWS_PRIVATE_ROOT_SHA256:/);
  assert.match(windowsJob, /WORKFLOW_RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(windowsJob, /WORKFLOW_RUN_ATTEMPT:\s*\$\{\{ github\.run_attempt \}\}/);

  const rebuildIndex = windowsJob.indexOf("python tools/rebuild_wcdb_release.py");
  const archiveHashIndex = rebuildRelease.indexOf('digest = hashlib.file_digest(archive, "sha256")');
  const verifyHashIndex = rebuildRelease.indexOf('f"sha256:{digest}" != expected_digest');
  const expandIndex = rebuildRelease.indexOf("package.extractall(destination)");
  const importIndex = windowsJob.indexOf("Import-WindowsCloudSigningIdentity.ps1");
  const validateIndex = windowsJob.indexOf("Validate native source-public artifact");
  const pythonDependenciesIndex = windowsJob.indexOf("Install Python dependencies");
  const pythonTestsIndex = windowsJob.indexOf("Run focused Python release tests");
  const buildIndex = windowsJob.indexOf("Build Windows installer");
  const uploadIndex = windowsJob.indexOf("Upload Windows release files");
  const cleanupIndex = windowsJob.indexOf("Remove-WindowsCloudSigningIdentity.ps1");
  assert.ok(rebuildIndex >= 0 && rebuildIndex < importIndex);
  assert.ok(archiveHashIndex >= 0 && archiveHashIndex < verifyHashIndex);
  assert.ok(verifyHashIndex < expandIndex);
  assert.ok(importIndex < validateIndex);
  assert.ok(
    validateIndex < pythonDependenciesIndex && pythonDependenciesIndex < pythonTestsIndex
  );
  assert.ok(pythonTestsIndex < buildIndex && buildIndex < uploadIndex);
  assert.ok(uploadIndex < cleanupIndex);

  const importScript = fs.readFileSync(
    path.join(desktopRoot, "scripts", "Import-WindowsCloudSigningIdentity.ps1"),
    "utf8"
  );
  const cleanupScript = fs.readFileSync(
    path.join(desktopRoot, "scripts", "Remove-WindowsCloudSigningIdentity.ps1"),
    "utf8"
  );
  assert.match(importScript, /Microsoft Software Key Storage Provider/);
  assert.match(importScript, /AllowExport\|AllowPlaintextExport/);
  assert.match(importScript, /Import-PfxCertificate/);
  assert.match(importScript, /\[IO\.File\]::Delete\(\$pfxPath\)/);
  assert.match(cleanupScript, /Remove-Item -LiteralPath \$certificatePath -DeleteKey -Force/);

  const upload = windowsJob.match(/- name: Upload Windows release files\n([\s\S]*?)$/)?.[1] || "";
  assert.match(upload, /desktop\/dist\/\*Setup\*\.exe/);
  assert.match(upload, /desktop\/dist\/\*Setup\*\.exe\.blockmap/);
  assert.match(upload, /desktop\/dist\/latest\.yml/);
  assert.match(upload, /desktop\/dist\/SHA256SUMS\.txt/);
  assert.match(upload, /desktop\/dist\/release-provenance\.json/);
  assert.doesNotMatch(upload, /builder-debug\.yml/);
});

test("release workflow pins every remote action to an approved commit", () => {
  const workflow = fs
    .readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const approved = new Map([
    ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
    ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
    ["actions/setup-python", "a26af69be951a213d495a4c3e4e4022e16d87065"],
    ["actions/cache", "0057852bfaa89a56745cba8c7296529d2fc39830"],
    ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
    ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
    ["dtolnay/rust-toolchain", "4cda84d5c5c54efe2404f9d843567869ab1699d4"],
    ["softprops/action-gh-release", "3bb12739c298aeb8a4eeaf626c5b8d85266b0e65"],
    ["H3CoF6/qq-notify-action", "50d180981e7c7b8552a3331b981e3f8cfcf40c44"],
  ]);
  const remoteUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1])
    .filter((use) => !use.startsWith("./"));

  assert.ok(remoteUses.length > 0);
  for (const use of remoteUses) {
    const separator = use.lastIndexOf("@");
    const action = use.slice(0, separator);
    const revision = use.slice(separator + 1);
    assert.match(revision, /^[0-9a-f]{40}$/, `${use} is not pinned to a commit`);
    assert.equal(revision, approved.get(action), `${action} uses an unapproved commit`);
  }
  for (const action of [
    "actions/checkout",
    "actions/setup-node",
    "actions/setup-python",
    "actions/download-artifact",
    "actions/upload-artifact",
    "softprops/action-gh-release",
  ]) {
    assert.ok(remoteUses.includes(`${action}@${approved.get(action)}`), `${action} is missing`);
  }
});

test("desktop has no upstream update client or publishing destination", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "src", "main.cjs"), "utf8");
  const verifier = fs.readFileSync(
    path.join(desktopRoot, "src", "windows-private-pki-runtime.cjs"),
    "utf8"
  );
  assert.doesNotMatch(main, /autoUpdater|checkForUpdates|downloadAndInstall/);
  assert.equal(packageJson.dependencies["electron-updater"], undefined);
  assert.equal(packageJson.build.publish, undefined);
  assert.match(verifier, /windowsPrivateRootSha256/);
  assert.match(verifier, /windowsClientSignerSha256/);
  assert.doesNotMatch(verifier, /verifyUpdateCodeSignature/);
  assert.match(verifier, /windows-private-pki\.ps1/);
});

test("tag release publishes Windows release", () => {
  const workflow = fs
    .readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const publishJob = workflow.split("\n  publish-release:\n", 2)[1] || "";

  assert.match(workflow, /^name: Release \(Windows\)$/m);
  assert.doesNotMatch(workflow, /build-macos-arm64/);
  assert.doesNotMatch(workflow, /native\/wce_integrity/);
  assert.match(publishJob, /needs:\s*\n\s*- build-windows/);
  assert.match(publishJob, /merge-multiple: true/);
});

test("Windows packages are built only by the tag-triggered release workflow", () => {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const workflow = fs
    .readFileSync(path.join(workflowsDir, "release.yml"), "utf8")
    .replace(/\r\n/g, "\n");

  // Desktop packaging is expensive; keep it off pull requests and main pushes.
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - "v\*"\n/m);
  assert.match(workflow, /\n  build-windows:\n/);

  for (const entry of fs.readdirSync(workflowsDir)) {
    const source = fs.readFileSync(path.join(workflowsDir, entry), "utf8");
    if (!/npm run (?:dist|smoke):win/.test(source)) continue;
    assert.equal(
      entry,
      "release.yml",
      `${entry} packages the desktop app outside the tag-triggered release workflow`
    );
  }
});

test("frontend joins copied output paths using the native path style", async () => {
  const modulePath = path.join(repoRoot, "frontend", "lib", "native-path.js");
  const { joinNativePath } = await import(pathToFileURL(modulePath).href);

  assert.equal(joinNativePath("/Users/demo/output/", "wxid_demo"), "/Users/demo/output/wxid_demo");
  assert.equal(joinNativePath("D:\\wechat\\output\\", "wxid_demo"), "D:\\wechat\\output\\wxid_demo");
  assert.equal(joinNativePath("\\\\server\\share\\output", "wxid_demo"), "\\\\server\\share\\output\\wxid_demo");
});
