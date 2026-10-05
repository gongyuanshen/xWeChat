"""
Publish release artifacts to GitHub Releases.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
import requests

REPO = "gongyuanshen/xwechat"
TAG = "v2.7.1"
RELEASE_NAME = "v2.7.1: xwechat 独立纯本地版"

BODY = """# xwechat v2.7.1 - 独立纯本地版发布

一个纯粹出于个人业余兴趣、娱乐探索与技术学习而开发的本地微信数据分析工具。

### ✨ 本次更新重点
- **独立纯本地数据链路**：全面切换为独立快照与数据链路，移除旧 client/broker 模式与专属 Hook。
- **Windows 桌面端打包**：
  - `xwechat-2.7.1-Setup.exe`：标准 Windows x64 安装程序，内置 Nuxt 3 渲染前端、Python 3.11 FastAPI 离线后端与 FFmpeg 转码支持。
  - `xwechat-2.7.1-Setup.zip`：免安装绿色便携压缩包，解压即用。
- **Python 分发包**：
  - `wechat_decrypt_tool-2.7.1-py3-none-any.whl`
  - `wechat_decrypt_tool-2.7.1.tar.gz`
- **完整性校验**：发布包均提供 SHA-256 校验和清单 `SHA256SUMS.txt`。

### 📦 资产列表与说明
| 文件名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `xwechat-2.7.1-Setup.exe` | 安装包 | Windows 推荐安装程序 |
| `xwechat-2.7.1-Setup.zip` | 压缩包 | Windows 免安装便携版 |
| `wechat_decrypt_tool-2.7.1-py3-none-any.whl` | Wheel | Python 命令行与开发分发包 |
| `wechat_decrypt_tool-2.7.1.tar.gz` | Source | 源码发布包 |
| `SHA256SUMS.txt` | 校验和 | 文件的 SHA-256 校验和 |

> ⚠️ **重要声明**：本项目为个人业余娱乐与学习实验项目，纯属自娱自乐与技术研究，不涉及任何经济收益、商业运作或收费服务。严禁将本项目用于任何商业牟利行为。
"""


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
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
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


def main() -> None:
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    token = get_token()
    session = get_session(token)

    # 1. Get or create release
    print(f"Checking existing releases for {REPO}...")
    resp = session.get(f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}")
    if resp.status_code == 200:
        release = resp.json()
        print(f"Found existing release id={release['id']}")
    elif resp.status_code == 404:
        print(f"Creating release {TAG}...")
        create_resp = session.post(
            f"https://api.github.com/repos/{REPO}/releases",
            json={
                "tag_name": TAG,
                "name": RELEASE_NAME,
                "body": BODY,
                "draft": False,
                "prerelease": False,
            },
        )
        create_resp.raise_for_status()
        release = create_resp.json()
        print(f"Created release id={release['id']}")
    else:
        resp.raise_for_status()
        release = resp.json()

    release_html_url = release.get("html_url", f"https://github.com/{REPO}/releases/tag/{TAG}")
    upload_url_template = release["upload_url"].split("{")[0]

    # Existing assets map: name -> asset info dict
    existing_assets = {a["name"]: a for a in release.get("assets", [])}

    repo_root = Path(__file__).resolve().parent.parent
    files_to_upload = [
        repo_root / "desktop" / "dist" / "xwechat-2.7.1-Setup.exe",
        repo_root / "desktop" / "dist" / "xwechat-2.7.1-Setup.zip",
        repo_root / "desktop" / "dist" / "xwechat-2.7.1-Setup.exe.blockmap",
        repo_root / "desktop" / "dist" / "SHA256SUMS.txt",
        repo_root / "dist" / "wechat_decrypt_tool-2.7.1-py3-none-any.whl",
        repo_root / "dist" / "wechat_decrypt_tool-2.7.1.tar.gz",
    ]

    for file_path in files_to_upload:
        if not file_path.is_file():
            print(f"ERROR: File not found: {file_path}")
            sys.exit(1)

        filename = file_path.name
        file_size = file_path.stat().st_size
        print(f"\nProcessing {filename} ({file_size / (1024 * 1024):.2f} MB)...")

        if filename in existing_assets:
            existing = existing_assets[filename]
            if existing.get("size") == file_size and existing.get("state") == "uploaded":
                print(f"Asset {filename} is already up to date ({file_size} bytes), skipping.")
                continue
            print(f"Asset {filename} exists on release but size/state differs ({existing.get('size')} != {file_size}), replacing...")
            del_resp = session.delete(
                f"https://api.github.com/repos/{REPO}/releases/assets/{existing['id']}"
            )
            if del_resp.status_code in (204, 200, 404):
                print(f"Removed stale asset {filename}")
            time.sleep(1)

        print(f"Uploading {filename} (size: {file_size} bytes)...")
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            try:
                uploaded_asset = upload_file_asset(session, upload_url_template, file_path)
                print(f"Successfully uploaded {filename} (id={uploaded_asset.get('id')})")
                break
            except Exception as e:
                print(f"\nUpload attempt {attempt}/{max_attempts} failed: {e}")
                if attempt == max_attempts:
                    raise
                time.sleep(3)

    print("\n" + "=" * 60)
    print("Release publishing complete!")
    print(f"Release URL: {release_html_url}")
    print("=" * 60)

    # Open release in browser window
    try:
        webbrowser.open(release_html_url)
        print(f"Opened release in browser window: {release_html_url}")
    except Exception as e:
        print(f"Could not open browser: {e}")


if __name__ == "__main__":
    main()
