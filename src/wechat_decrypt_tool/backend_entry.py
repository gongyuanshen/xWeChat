"""Module entry point for source launches and backend settings restarts."""

import multiprocessing
import sys

import uvicorn

from wechat_decrypt_tool.desktop_parent_watchdog import (
    start_desktop_parent_watchdog_from_env,
)
from wechat_decrypt_tool.runtime_settings import (
    default_backend_host,
    read_effective_backend_host,
    read_effective_backend_port,
)


def main() -> None:
    if "--smoke-backend" in sys.argv[1:]:
        import json
        payload = {
            "ok": True,
            "frozen": bool(getattr(sys, "frozen", False)),
            "platform": sys.platform,
        }
        print(json.dumps(payload, ensure_ascii=True))
        return

    start_desktop_parent_watchdog_from_env()
    from wechat_decrypt_tool.api import app

    host, _ = read_effective_backend_host(default=default_backend_host())
    port, _ = read_effective_backend_port(default=10392)
    # Keep the application's file handlers and redaction filters.
    uvicorn.run(app, host=host, port=port, log_level="info", log_config=None)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
