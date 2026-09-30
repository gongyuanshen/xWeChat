#!/usr/bin/env python3
"""Build and download this release's signed WCDB components."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile


REPOSITORY = "2977094657/WCDB"
LIFETIME_SECONDS = 45 * 24 * 60 * 60
COMPONENTS = {
    "windows-native": (
        "windows-native-production.yml",
        "wechatdb-native-windows-x64-source-public",
        "wechatdb-native-windows-x64-source-public",
        "WCE_NATIVE_CORE",
        "wechatdb_native_build.json",
    ),
}


def api(path: str, payload: dict | None = None):
    command = ["gh", "api", f"repos/{REPOSITORY}/{path}"]
    if payload is not None:
        command += ["--method", "POST", "--input", "-"]
    result = subprocess.run(
        command,
        input=json.dumps(payload) if payload is not None else None,
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def dispatch(component: str, revision: str, issued_at: int) -> dict:
    workflow = COMPONENTS[component][0]
    build_id = f"wcda-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}-{component}"
    inputs = {
        "source_revision": revision,
        "build_id": build_id,
        "build_issued_at_unix": str(issued_at),
    }
    api(f"actions/workflows/{workflow}/dispatches", {"ref": "main", "inputs": inputs})
    print(f"Building {component}: {build_id} ({revision})", flush=True)
    return {"component": component, "workflow": workflow, "build_id": build_id}


def wait_for_build(build: dict, revision: str) -> int:
    run_id = None
    while run_id is None:
        page = 1
        while True:
            runs = api(
                f"actions/workflows/{build['workflow']}/runs"
                f"?event=workflow_dispatch&head_sha={revision}&page={page}"
            )["workflow_runs"]
            match = next(
                (run for run in runs if run["display_title"] == f"WCDB {build['build_id']}"),
                None,
            )
            if match:
                run_id = match["id"]
                break
            if not runs:
                break
            page += 1
        if run_id is None:
            time.sleep(5)
    print(f"Waiting for https://github.com/{REPOSITORY}/actions/runs/{run_id}", flush=True)
    run = api(f"actions/runs/{run_id}")
    while run["status"] != "completed":
        time.sleep(10)
        run = api(f"actions/runs/{run_id}")
    if run["conclusion"] != "success":
        raise RuntimeError(f"WCDB producer {run_id} finished with {run['conclusion']}")
    if (
        run["head_sha"] != revision
        or run["head_branch"] != "main"
        or run["event"] != "workflow_dispatch"
        or run["path"] != f".github/workflows/{build['workflow']}"
    ):
        raise RuntimeError("WCDB producer identity does not match this release")
    return run_id


def download(build: dict, run_id: int, revision: str, issued_at: int, output_root: Path) -> dict:
    component = build["component"]
    _, artifact_name, directory_name, prefix, manifest_name = COMPONENTS[component]
    build_id = build["build_id"]
    tag = f"{component}-{build_id}"
    asset_name = f"{artifact_name}-{build_id}.zip"
    release = api(f"releases/tags/{tag}")
    if release.get("target_commitish") != revision:
        raise RuntimeError(f"Producer Release target does not match {revision}: {tag}")
    assets = [item for item in release.get("assets", []) if item.get("name") == asset_name]
    if len(assets) != 1:
        raise RuntimeError(f"Producer Release must contain exactly one asset: {asset_name}")
    asset = assets[0]
    expected_digest = asset.get("digest")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest or ""):
        raise RuntimeError(f"Producer Release asset has no SHA-256 digest: {asset_name}")
    destination = output_root / directory_name
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(
            [
                "gh",
                "api",
                f"repos/{REPOSITORY}/releases/assets/{asset['id']}",
                "--header",
                "Accept: application/octet-stream",
            ],
            stdout=archive,
            check=True,
        )
        archive.seek(0)
        digest = hashlib.file_digest(archive, "sha256").hexdigest()
        if f"sha256:{digest}" != expected_digest:
            raise RuntimeError(f"Producer Release asset digest mismatch: {asset_name}")
        archive.seek(0)
        with zipfile.ZipFile(archive) as package:
            package.extractall(destination)
    manifest = json.loads((destination / manifest_name).read_text(encoding="utf-8"))
    identity = manifest["buildId"]
    issued = manifest["buildIssuedAtUnix"]
    expires = manifest["buildExpiresAtUnix"]
    development = manifest["developmentBuild"]
    if component == "windows-native" and (manifest.get("readOnlyBuild") is not True
            or manifest.get("databaseWriteBuild") is not False
            or manifest.get("wechatActions") != []):
        raise RuntimeError("Release native core must be read-only")
    if (identity != build["build_id"] or development
            or issued != issued_at or expires != issued_at + LIFETIME_SECONDS):
        raise RuntimeError(f"{component} was not freshly built with this release's 45-day window")
    values = {
        f"{prefix}_ARTIFACT_REPOSITORY": REPOSITORY,
        f"{prefix}_ARTIFACT_DOWNLOAD_REPOSITORY": REPOSITORY,
        f"{prefix}_ARTIFACT_RUN_ID": str(run_id),
        f"{prefix}_ARTIFACT_SHA256": digest,
        f"{prefix}_SOURCE_REVISION": revision,
        f"{prefix}_BUILD_ID": identity,
        f"{prefix}_ARTIFACT_DIR": str(destination),
    }
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", action="append", choices=COMPONENTS, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get("GH_TOKEN"):
        raise SystemExit("WCE_NATIVE_CORE_PRODUCER_TOKEN is required to rebuild WCDB")
    revision = api("commits/main")["sha"]
    issued_at = int(time.time())
    builds = [dispatch(component, revision, issued_at) for component in args.component]
    values = {}
    for build in builds:
        run_id = wait_for_build(build, revision)
        values.update(download(build, run_id, revision, issued_at, args.output_root))
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as stream:
        for name, value in values.items():
            stream.write(f"{name}={value}\n")
    print(f"WCDB build window: {issued_at} to {issued_at + LIFETIME_SECONDS}", flush=True)


if __name__ == "__main__":
    main()
