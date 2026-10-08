"""
Publish release artifacts to GitHub Releases.
"""

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import quote

import requests

REPO = "gongyuanshen/xwechat"


def get_git_exe() -> str:
    found = shutil.which("git")
    if found:
        return found
    for c in [
        r"E:\Git\cmd\git.exe",
        r"C:\Program Files\Git\cmd\git.exe",
        r"C:\Program Files (x86)\Git\cmd\git.exe",
    ]:
        if os.path.isfile(c):
            return c
    return "git"


def get_token() -> str:
    env_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env_token:
        return env_token
    proc = subprocess.run(
        [get_git_exe(), "credential", "fill"],
        input="protocol=https\nhost=github.com\n",
        capture_output=True,
        text=True,
        check=True,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("Could not retrieve GitHub credentials")


def get_session(token: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "xwechat-releaser",
    })
    proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if proxy_url:
        session.proxies.update({
            "http": proxy_url,
            "https": proxy_url,
        })
    return session


class ProgressFileReader:
    def __init__(self, file_path: Path):
        self.file = open(file_path, "rb")
        self.total_size = file_path.stat().st_size
        self.uploaded_size = 0
        self.last_print = 0

    def read(self, size=-1):
        chunk = self.file.read(size)
        if chunk:
            self.uploaded_size += len(chunk)
            now = time.time()
            if now - self.last_print >= 1.0 or self.uploaded_size == self.total_size:
                pct = (self.uploaded_size / self.total_size) * 100 if self.total_size else 100
                mb_up = self.uploaded_size / (1024 * 1024)
                mb_tot = self.total_size / (1024 * 1024)
                print(f"\r  Uploading: {mb_up:.2f} / {mb_tot:.2f} MB ({pct:.1f}%)", end="", flush=True)
                self.last_print = now
        return chunk

    def __len__(self):
        return self.total_size

    def close(self):
        self.file.close()


def upload_file_asset(session: requests.Session, upload_url: str, file_path: Path) -> dict:
    reader = ProgressFileReader(file_path)
    try:
        resp = session.post(
            upload_url,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(file_path.stat().st_size),
            },
            data=reader,
            params={"name": file_path.name},
            timeout=1800,
        )
        print()
        resp.raise_for_status()
        return resp.json()
    finally:
        reader.close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True, help="Full source commit SHA")
    parser.add_argument("--body-file", type=Path, required=True)
    parser.add_argument("--asset", type=Path, action="append", required=True)
    args = parser.parse_args(argv)

    if not args.tag.strip() or re.fullmatch(r"[0-9a-fA-F]{40}", args.commit) is None:
        raise ValueError("A tag and full 40-character commit SHA are required")
    body = args.body_file.read_text(encoding="utf-8")
    assets = {}
    for file_path in args.asset:
        if not file_path.is_file():
            raise FileNotFoundError(f"Release asset is not a file: {file_path}")
        if file_path.name in assets:
            raise ValueError(f"Duplicate asset name: {file_path.name}")
        with file_path.open("rb") as file:
            digest = "sha256:" + hashlib.file_digest(file, "sha256").hexdigest()
        assets[file_path.name] = (file_path, file_path.stat().st_size, digest)

    session = get_session(get_token())
    api_url = f"https://api.github.com/repos/{REPO}"
    tag = quote(args.tag, safe="")
    page = 1
    while True:
        existing = session.get(f"{api_url}/releases", params={"per_page": 100, "page": page}, timeout=30)
        existing.raise_for_status()
        releases = existing.json()
        if any(item["tag_name"] == args.tag for item in releases):
            raise RuntimeError(f"Release {args.tag} already exists; refusing to modify it")
        if len(releases) < 100:
            break
        page += 1

    existing_tag = session.get(f"{api_url}/commits/{tag}", timeout=30)
    if existing_tag.status_code == 200:
        if existing_tag.json()["sha"].lower() != args.commit.lower():
            raise RuntimeError(f"Tag {args.tag} does not point to commit {args.commit}")
    elif existing_tag.status_code != 404:
        existing_tag.raise_for_status()

    created = session.post(
        f"{api_url}/releases",
        json={"tag_name": args.tag, "target_commitish": args.commit, "name": args.tag,
              "body": body, "draft": True, "prerelease": False},
        timeout=30,
    )
    created.raise_for_status()
    release = created.json()
    if not release["draft"] or release["tag_name"] != args.tag:
        raise RuntimeError("GitHub did not create the requested draft release")
    release_url = f"{api_url}/releases/{release['id']}"
    print(f"Created draft release {args.tag} (id={release['id']})", flush=True)
    upload_url = release["upload_url"].split("{")[0]
    for file_path, file_size, _ in assets.values():
        print(f"Uploading {file_path.name} ({file_size} bytes)...", flush=True)
        upload_file_asset(session, upload_url, file_path)

    remote = session.get(f"{release_url}/assets", params={"per_page": 100}, timeout=30)
    remote.raise_for_status()
    remote_assets = remote.json()
    if len(remote_assets) != len(assets) or {item["name"] for item in remote_assets} != set(assets):
        raise RuntimeError("Release asset verification failed: remote asset list differs")
    for item in remote_assets:
        _, size, digest = assets[item["name"]]
        if item["state"] != "uploaded" or item["size"] != size or item["digest"] != digest:
            raise RuntimeError(f"Release asset verification failed: {item['name']}")
        print(f"Verified {item['name']}: {digest}", flush=True)

    published = session.patch(release_url, json={"draft": False, "make_latest": "true"}, timeout=30)
    published.raise_for_status()
    result = published.json()
    if result["draft"]:
        raise RuntimeError("GitHub did not publish the verified draft release")
    print(f"Release publishing complete: {result['html_url']}", flush=True)


if __name__ == "__main__":
    main()
