"""Presentation assets for independent exports, with no runtime native dependency.

The retained UI source and its provenance live in resources/html_export.
ZIP SHA-256 checksums detect corruption; they are not signatures.
"""
from __future__ import annotations

import html
import re

import json
from pathlib import Path


_ASSETS = Path(__file__).with_name("resources") / "html_export"
FORMAT = "xwechat-static-v1"
# Exported records can contain remote URLs. Opening a local archive must not
# contact those servers; explicitly downloaded resources are bundled locally.
HEAD = (
    '<meta name="xwechat-export-format" content="xwechat-static-v1" />\n'
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    'script-src \'self\' file:; style-src \'self\' \'unsafe-inline\' file:; '
    'img-src \'self\' file: data: blob:; media-src \'self\' file: data: blob:; '
    'font-src \'self\' file: data:; base-uri \'none\'; form-action \'none\'" />\n'
)


def export_css(kind: str) -> str:
    if kind not in {"chat", "sns", "contacts", "records-project", "records-generic"}:
        raise ValueError(f"Unknown HTML export stylesheet: {kind}")
    return (_ASSETS / f"{kind}.css").read_text(encoding="utf-8")


def runtime_js() -> str:
    return (_ASSETS / "chat-export.js").read_text(encoding="utf-8")


def attribution_html() -> str:
    return (
        (_ASSETS / "attribution.html").read_text(encoding="utf-8")
        + '<p data-xwechat-export="xwechat-static-v1" style="position:fixed;left:8px;bottom:4px;'
        'font-size:10px;color:#6b7280">独立导出 · SHA-256 内容校验不提供来源认证</p>\n'
    )


def page_fragment_js(page_no: int, fragment_html: str) -> str:
    if page_no < 1:
        raise ValueError("HTML page number must be positive")
    payload = json.dumps([page_no, fragment_html], ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return (
        "(() => { const page = " + payload + ";\n"
        "if (typeof window.__WCE_PAGE_LOADED__ === 'function') window.__WCE_PAGE_LOADED__(...page);\n"
        "else (window.__WCE_PAGE_QUEUE__ = window.__WCE_PAGE_QUEUE__ || []).push(page);\n"
        "})();\n"
    )


def prepare_html_zip_assets(css_payload: str) -> dict[str, str]:
    return {
        "cssPath": "assets/export.css", "jsPath": "",
        "cssPayload": css_payload, "jsPayload": "",
        "format": FORMAT,
    }


def protect_html_document(
    document: str,
    *,
    stylesheet_tag: str,
    runtime_tag: str,
) -> str:
    text = str(document or "")
    if "</head>" not in text.lower() or "</body>" not in text.lower():
        raise RuntimeError("HTML 导出页面结构不完整。")
    text = re.sub(r"(?i)</head>", HEAD + stylesheet_tag + runtime_tag + "</head>", text, count=1)
    return re.sub(r"(?i)</body>", attribution_html() + "</body>", text, count=1)


def protect_html_document_with_external_assets(document: str, assets: dict[str, str]) -> str:
    return protect_html_document(
        document,
        stylesheet_tag=f'<link rel="stylesheet" href="{html.escape(assets["cssPath"], quote=True)}" />\n',
        runtime_tag=(f'<script defer src="{html.escape(assets["jsPath"], quote=True)}"></script>\n' if assets.get("jsPath") else ""),
    )
