#!/usr/bin/env python3
"""Create deterministic Chrome/Edge and Firefox store packages."""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

from validate_extensions import validate


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PACKAGES = {
    "chrome": "chrome-edge",
    "firefox": "firefox",
}
EXCLUDED_NAMES = {".DS_Store", "README.md"}
FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def source_files(browser: str) -> list[Path]:
    browser_dir = ROOT / browser
    files = [
        path
        for path in browser_dir.rglob("*")
        if path.is_file()
        and path.name not in EXCLUDED_NAMES
        and "__pycache__" not in path.parts
    ]
    if browser_dir / "manifest.json" not in files:
        raise RuntimeError(f"{browser}/manifest.json is missing")
    return sorted(files, key=lambda path: path.relative_to(browser_dir).as_posix())


def write_package(browser: str, package_label: str, version: str) -> Path:
    browser_dir = ROOT / browser
    destination = DIST / f"breaktest-browser-recorder-{package_label}-{version}.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in source_files(browser):
            relative = source.relative_to(browser_dir).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compresslevel=9)
    return destination


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    validation_errors = validate()
    if validation_errors:
        formatted = "\n".join(f"- {error}" for error in validation_errors)
        raise RuntimeError(f"Extension validation failed:\n{formatted}")
    manifests = {
        browser: json.loads((ROOT / browser / "manifest.json").read_text(encoding="utf-8"))
        for browser in PACKAGES
    }
    versions = {manifest["version"] for manifest in manifests.values()}
    if len(versions) != 1:
        raise RuntimeError(f"Manifest versions differ: {sorted(versions)}")
    version = versions.pop()

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    packages = [
        write_package(browser, label, version)
        for browser, label in PACKAGES.items()
    ]
    checksums = "".join(f"{sha256(path)}  {path.name}\n" for path in packages)
    (DIST / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    for package in packages:
        print(package.relative_to(ROOT))


if __name__ == "__main__":
    main()
