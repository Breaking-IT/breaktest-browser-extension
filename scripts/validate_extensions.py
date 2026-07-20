#!/usr/bin/env python3
"""Validate store-facing manifests and packaged extension sources."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
BROWSERS = ("chrome", "firefox")
PRIVACY_URL = (
    "https://github.com/Breaking-IT/"
    "breaktest-browser-extension/blob/main/PRIVACY.md"
)
FORBIDDEN_PERMISSIONS = {"activeTab"}
FORBIDDEN_CODE_PATTERNS = {
    "eval": re.compile(r"\beval\s*\("),
    "Function constructor": re.compile(r"\bnew\s+Function\s*\("),
}


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.assets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        attribute = {"script": "src", "link": "href", "img": "src"}.get(tag)
        if attribute and values.get(attribute):
            self.assets.append(values[attribute] or "")


def load_manifest(browser: str) -> dict:
    path = ROOT / browser / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AssertionError(f"Unable to read {path.relative_to(ROOT)}: {error}") from error


def referenced_manifest_files(manifest: dict) -> set[str]:
    files: set[str] = set()
    background = manifest.get("background", {})
    if background.get("service_worker"):
        files.add(background["service_worker"])
    files.update(background.get("scripts", []))

    for key in ("icons",):
        files.update(manifest.get(key, {}).values())
    files.update(manifest.get("action", {}).get("default_icon", {}).values())

    side_panel = manifest.get("side_panel", {})
    if side_panel.get("default_path"):
        files.add(side_panel["default_path"])

    sidebar = manifest.get("sidebar_action", {})
    if sidebar.get("default_panel"):
        files.add(sidebar["default_panel"])
    files.update(sidebar.get("default_icon", {}).values())
    return files


def validate_html_assets(html_path: Path) -> list[str]:
    parser = AssetParser()
    parser.feed(html_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    for asset in parser.assets:
        parsed = urlparse(asset)
        if parsed.scheme in {"http", "https", "data"} or asset.startswith("#"):
            continue
        if not (html_path.parent / parsed.path).is_file():
            relative_html = html_path.relative_to(ROOT)
            errors.append(f"{relative_html} references missing asset {asset}")
    return errors


def validate() -> list[str]:
    errors: list[str] = []
    manifests = {browser: load_manifest(browser) for browser in BROWSERS}
    versions = {manifest.get("version") for manifest in manifests.values()}
    if len(versions) != 1:
        errors.append(f"Manifest versions differ: {sorted(str(version) for version in versions)}")
    version = next(iter(versions), "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(version)):
        errors.append(f"Store version must use major.minor.patch, found {version!r}")

    for browser, manifest in manifests.items():
        browser_dir = ROOT / browser
        if manifest.get("manifest_version") != 3:
            errors.append(f"{browser}: only Manifest V3 packages are supported")
        permissions = set(manifest.get("permissions", []))
        if "downloads" not in permissions:
            errors.append(f"{browser}: downloads permission is required for the Save As dialog")
        forbidden = permissions & FORBIDDEN_PERMISSIONS
        if forbidden:
            errors.append(f"{browser}: unnecessary permissions present: {sorted(forbidden)}")
        if manifest.get("homepage_url") != "https://github.com/Breaking-IT/breaktest-browser-extension":
            errors.append(f"{browser}: homepage_url is missing or unexpected")

        for relative in referenced_manifest_files(manifest):
            if not (browser_dir / relative).is_file():
                errors.append(f"{browser}/manifest.json references missing file {relative}")

        for html_path in sorted(browser_dir.glob("*.html")):
            errors.extend(validate_html_assets(html_path))
            html = html_path.read_text(encoding="utf-8")
            if re.search(r"<script\b[^>]*\bsrc=[\"']https?://", html, re.IGNORECASE):
                errors.append(f"{html_path.relative_to(ROOT)} loads a remote script")
        for js_path in sorted(browser_dir.glob("*.js")):
            source = js_path.read_text(encoding="utf-8")
            for name, pattern in FORBIDDEN_CODE_PATTERNS.items():
                if pattern.search(source):
                    errors.append(f"{js_path.relative_to(ROOT)} uses forbidden {name}")
            result = subprocess.run(
                ["node", "--check", str(js_path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode:
                errors.append(
                    f"JavaScript syntax check failed for {js_path.relative_to(ROOT)}:\n"
                    f"{result.stderr.strip()}"
                )

    firefox_collection = (
        manifests["firefox"]
        .get("browser_specific_settings", {})
        .get("gecko", {})
        .get("data_collection_permissions", {})
        .get("required")
    )
    if firefox_collection != ["none"]:
        errors.append("firefox: data_collection_permissions.required must be ['none']")
    firefox_minimum = (
        manifests["firefox"]
        .get("browser_specific_settings", {})
        .get("gecko", {})
        .get("strict_min_version", "0")
    )
    try:
        firefox_minimum_parts = tuple(int(part) for part in firefox_minimum.split("."))
    except (AttributeError, ValueError):
        firefox_minimum_parts = (0,)
    if firefox_minimum_parts < (142, 0):
        errors.append("firefox: strict_min_version must remain 142.0 or newer for the data disclosure key")

    for browser in BROWSERS:
        panel_file = "sidepanel.html" if browser == "chrome" else "sidebar.html"
        script_file = "sidepanel.js" if browser == "chrome" else "sidebar.js"
        panel = (ROOT / browser / panel_file).read_text(encoding="utf-8")
        panel_script = (ROOT / browser / script_file).read_text(encoding="utf-8")
        if PRIVACY_URL not in panel:
            errors.append(f"{browser}: recorder UI does not link to the public privacy policy")
        if "recording-consent" not in panel:
            errors.append(f"{browser}: recorder UI does not contain recording consent")
        if "cleaned up after 24 hours" not in panel:
            errors.append(f"{browser}: recorder UI does not disclose pending HAR retention")
        for button_id in ("start-button", "blank-start-button"):
            if not re.search(rf'<button\s+[^>]*id="{button_id}"[^>]*\bdisabled\b', panel):
                errors.append(f"{browser}: {button_id} must be disabled before consent")
        if "function requireRecordingConsent()" not in panel_script:
            errors.append(f"{browser}: recorder start actions do not enforce consent")
        if 'RECORDING_CONSENT_KEY = "recordingDisclosureAcceptedVersion"' not in panel_script:
            errors.append(f"{browser}: accepted disclosure version is not stored")
        if "RECORDING_DISCLOSURE_VERSION = 2" not in panel_script:
            errors.append(f"{browser}: recording disclosure version must cover IndexedDB export retention")
        if "function showPrivacySettings()" not in panel_script or "privacy-settings-button" not in panel:
            errors.append(f"{browser}: saved consent cannot be reviewed from the recorder")
        if "consentVersion: RECORDING_DISCLOSURE_VERSION" not in panel_script:
            errors.append(f"{browser}: private-window launches do not carry consent state")
        if "saveAs: true" not in panel_script:
            errors.append(f"{browser}: HAR export does not require a Save As dialog")
        if "Start in new tab" not in panel:
            errors.append(f"{browser}: the new-tab recording action is not clearly labelled")
        if "discard-button" not in panel or 'type: "cancel-recording"' not in panel_script:
            errors.append(f"{browser}: recordings cannot be explicitly discarded")

        background_file = "service-worker.js" if browser == "chrome" else "background.js"
        background_source = (ROOT / browser / background_file).read_text(encoding="utf-8")
        if 'case "cancel-recording"' not in background_source:
            errors.append(f"{browser}: the background recorder cannot cancel an active recording")
        for command in ("rename-transaction", "delete-transaction"):
            if f'case "{command}"' not in background_source:
                errors.append(f"{browser}: background recorder does not support {command}")
            if f'type: "{command}"' not in panel_script:
                errors.append(f"{browser}: recorder UI does not send {command}")
        if "nextTransactionOrdinal" not in background_source:
            errors.append(f"{browser}: transaction IDs can collide after deletion")
        if "entry._breaktest.transactionName = normalizedName" not in background_source:
            errors.append(f"{browser}: transaction rename does not update captured HAR entries")
        if "entry._breaktest.transactionId !== id" not in background_source:
            errors.append(f"{browser}: transaction deletion does not remove captured HAR entries")
        if 'requestDisposition === "previous"' not in background_source:
            errors.append(f"{browser}: transaction requests cannot be moved to the previous transaction")
        if 'requestDisposition === "next"' not in background_source:
            errors.append(f"{browser}: transaction requests cannot be moved to the next transaction")
        if "entry._breaktest.transactionId = targetTransaction.id" not in background_source:
            errors.append(f"{browser}: moved transaction requests do not update captured HAR entries")
        if "state.transaction = targetTransaction" not in background_source:
            errors.append(f"{browser}: in-flight requests are not moved with their transaction")
        if 'textContent = "✎"' not in panel_script or 'textContent = "×"' not in panel_script:
            errors.append(f"{browser}: transaction edit and delete controls are missing")
        if "chooseTransactionRemoval" not in panel_script or "requestDisposition" not in panel_script:
            errors.append(f"{browser}: transaction removal choices are missing from the recorder UI")
        if 'id="move-requests-previous"' not in panel or 'id="move-requests-next"' not in panel:
            errors.append(f"{browser}: previous and next transaction choices are missing from the dialog")
        if "HarExportStore.save(har)" not in background_source:
            errors.append(f"{browser}: completed HARs are not staged outside extension messaging")
        if "return {ok: true, har" in background_source:
            errors.append(f"{browser}: completed HARs must not cross the extension message boundary")
        if "HarExportStore.get(exportDescriptor.id)" not in panel_script:
            errors.append(f"{browser}: recorder UI cannot load a staged HAR export")
        if "HarExportStore.remove(pendingExport.id)" not in panel_script:
            errors.append(f"{browser}: staged HAR exports are not removed after use or discard")
        if "response.har" in panel_script or "pendingHar" in panel_script:
            errors.append(f"{browser}: recorder UI still expects a monolithic HAR message")
        if not (browser_dir / "har-export-store.js").is_file():
            errors.append(f"{browser}: IndexedDB HAR export helper is missing")

    chrome_worker = (ROOT / "chrome" / "service-worker.js").read_text(encoding="utf-8")
    if "openPanelOnActionClick: true" not in chrome_worker:
        errors.append("chrome: toolbar action must open the configured tab-specific panel")
    if "function configureTabPanel(tabId)" not in chrome_worker:
        errors.append("chrome: recorder side panel is not configured per tab")
    if "prepareCurrentTabAsBlank" not in chrome_worker:
        errors.append("chrome: incognito launcher tab is not reused for recording")
    if 'case "start-incognito-recording"' not in chrome_worker:
        errors.append("chrome: incognito launcher cannot start recording directly")
    if 'importScripts("har-export-store.js")' not in chrome_worker:
        errors.append("chrome: service worker does not load IndexedDB HAR export support")
    if "preparedNewTab" not in chrome_worker:
        errors.append("chrome: extension-created new tabs are not distinguished from internal pages")
    if manifests["chrome"].get("side_panel"):
        errors.append("chrome: a manifest-level side panel would make the recorder global")

    firefox_background_scripts = manifests["firefox"].get("background", {}).get("scripts", [])
    if firefox_background_scripts[:2] != ["har-export-store.js", "background.js"]:
        errors.append("firefox: IndexedDB HAR export support must load before the recorder background")

    if not (ROOT / "PRIVACY.md").is_file():
        errors.append("PRIVACY.md is missing")
    elif "browser-local IndexedDB" not in (ROOT / "PRIVACY.md").read_text(encoding="utf-8"):
        errors.append("PRIVACY.md does not disclose staged HAR export retention")
    return errors


def main() -> int:
    errors = validate()
    if errors:
        print("Extension validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Chrome/Edge and Firefox extension sources are store-ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
