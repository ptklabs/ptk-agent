#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import io
import importlib.util
import json
import os
import shutil
import subprocess
import struct
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parent
PTK_ROOT = ROOT.parents[1]
LICENSE_SOURCE = REPOSITORY_ROOT / "LICENSE.txt"
EXPECTED_LICENSE = "AGPL-3.0-only"
EXPECTED_LICENSE_CLASSIFIER = "License :: OSI Approved :: GNU Affero General Public License v3"
PYPI_DOCS = REPOSITORY_ROOT / "docs" / "pypi"
DEFAULT_EXTENSION_INPUT_DIR = PTK_ROOT / "dist"
AUTOMATION_CRX_FILE = "ptk-latest-automation.crx"
AUTOMATION_XPI_FILE = "ptk-latest-automation.xpi"
AUTOMATION_PROVENANCE_FILE = "extension-provenance-automation.json"
PACKAGE_ZIP_FILE = "ptk-latest.zip"
PACKAGE_CHROMIUM_ZIP_FILE = "ptk-latest-chromium.zip"
PACKAGE_CRX_FILE = "ptk-latest.crx"
PACKAGE_CHROMIUM_CRX_FILE = "ptk-latest-chromium.crx"
PACKAGE_XPI_FILE = "ptk-latest.xpi"
PACKAGE_FIREFOX_XPI_FILE = "ptk-latest-firefox.xpi"
PACKAGE_PROVENANCE_FILE = "extension-provenance.json"
DEV_LOCAL_CONFIG_FILE = "dev.local.json"
PACKAGES = {
    "ptk_core": ROOT / "core",
    "ptk_playwright": ROOT / "playwright",
    "ptk_selenium": ROOT / "selenium",
    "pentestkit": ROOT / "pentestkit",
}
PUBLIC_PACKAGE_NAMES = ["pentestkit"]
INTERNAL_PACKAGE_NAMES = ["ptk_core", "ptk_playwright", "ptk_selenium"]
PACKAGE_DOCS = {
    "ptk_core": PYPI_DOCS / "core.md",
    "ptk_playwright": PYPI_DOCS / "playwright.md",
    "ptk_selenium": PYPI_DOCS / "selenium.md",
    "pentestkit": PYPI_DOCS / "README.md",
}


def run(command, cwd=None, env=None):
    pycache_prefix = os.environ.get("PYTHONPYCACHEPREFIX") or str(Path(tempfile.gettempdir()) / "ptk-pypi-pycache")
    pip_cache = os.environ.get("PIP_CACHE_DIR") or str(Path(tempfile.gettempdir()) / "ptk-pip-cache")
    result = subprocess.run(
        command,
        cwd=str(cwd or ROOT),
        env={**os.environ, "PYTHONPYCACHEPREFIX": pycache_prefix, "PIP_CACHE_DIR": pip_cache, **(env or {})},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(command)} failed with {result.returncode}\n{result.stdout}\n{result.stderr}"
        )
    return result


def source_pythonpath(package_names=None):
    names = package_names or PACKAGES.keys()
    return os.pathsep.join(str(PACKAGES[name] / "src") for name in names)


def compile_sources():
    run([
        sys.executable,
        "-m",
        "compileall",
        "-q",
        str(PACKAGES["ptk_core"] / "src"),
        str(PACKAGES["ptk_playwright"] / "src"),
        str(PACKAGES["ptk_selenium"] / "src"),
        str(PACKAGES["pentestkit"] / "src"),
    ])


def import_smoke():
    public_env = {"PYTHONPATH": source_pythonpath(["pentestkit"])}
    public_code = """
import importlib.util
import pentestkit
from pentestkit.core import PTKBridge
from pentestkit.extensions import chromium_unpacked_path, chromium_zip_path, crx_path, extension_provenance, xpi_path
assert PTKBridge

def has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:
        return False

results = {"pentestkit": True, "pentestkit.core": True}
assert callable(chromium_unpacked_path)
assert callable(chromium_zip_path)
assert callable(crx_path)
assert callable(xpi_path)
assert callable(extension_provenance)
results["pentestkit.extensions"] = True
if has_module("playwright") and has_module("playwright.sync_api"):
    from pentestkit.playwright import with_ptk_scan as playwright_with_ptk_scan
    assert callable(playwright_with_ptk_scan)
    results["pentestkit.playwright"] = True
else:
    results["pentestkit.playwright"] = "skipped_missing_playwright"
if has_module("selenium") and has_module("selenium.webdriver"):
    from pentestkit.selenium import with_ptk_scan as selenium_with_ptk_scan
    assert callable(selenium_with_ptk_scan)
    results["pentestkit.selenium"] = True
else:
    results["pentestkit.selenium"] = "skipped_missing_selenium"
print(results)
"""
    public_result = run([sys.executable, "-c", public_code], env=public_env).stdout.strip()

    internal_env = {"PYTHONPATH": source_pythonpath(["ptk_core", "ptk_playwright", "ptk_selenium"])}
    internal_code = """
import importlib.util
import ptk_core
assert callable(ptk_core.with_ptk_scan)

def has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:
        return False

results = {"ptk_core": True}
if has_module("playwright") and has_module("playwright.sync_api"):
    import ptk_playwright
    assert callable(ptk_playwright.with_ptk_scan)
    results["ptk_playwright"] = True
else:
    results["ptk_playwright"] = "skipped_missing_playwright"
if has_module("selenium") and has_module("selenium.webdriver"):
    import ptk_selenium
    assert callable(ptk_selenium.with_ptk_scan)
    results["ptk_selenium"] = True
else:
    results["ptk_selenium"] = "skipped_missing_selenium"
print(results)
"""
    internal_result = run([sys.executable, "-c", internal_code], env=internal_env).stdout.strip()
    return {
        "public": public_result,
        "internal": internal_result,
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_tree(root):
    digest = hashlib.sha256()
    bytes_total = 0
    files_total = 0
    root = Path(root)
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        digest.update(relative.encode("utf8"))
        digest.update(b"\0")
        digest.update(data)
        bytes_total += len(data)
        files_total += 1
    return {
        "sha256": digest.hexdigest(),
        "bytes": bytes_total,
        "files": files_total,
    }


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf8"))


def read_zip_json(zip_path, name):
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open(name) as handle:
            return json.loads(handle.read().decode("utf8"))


def read_zip_json_optional(zip_path, name):
    with zipfile.ZipFile(zip_path) as archive:
        try:
            with archive.open(name) as handle:
                return json.loads(handle.read().decode("utf8"))
        except KeyError:
            return None


def uses_dedicated_automation_runtime(manifest):
    background = manifest.get("background") if isinstance(manifest, dict) else None
    if not isinstance(background, dict):
        return False
    if manifest.get("manifest_version") == 3:
        return background.get("service_worker") == "app_automation.js"
    if manifest.get("manifest_version") == 2:
        return background.get("page") == "ptk/background_automation.html"
    return False


def validate_automation_artifact(label, manifest, dev_local=None):
    if not isinstance(manifest, dict):
        raise RuntimeError(f"{label} automation artifact has no valid manifest")
    dedicated_runtime = uses_dedicated_automation_runtime(manifest)
    if dev_local is not None:
        if not isinstance(dev_local, dict) or dev_local.get("automationEnabled") is not True:
            raise RuntimeError(f"{label} dev.local.json must set automationEnabled: true when present")
        if dev_local.get("automationAllowChildFrameBootstrap") is True:
            raise RuntimeError(f"{label} automation artifact must not enable child-frame bootstrap globally")
    if not dedicated_runtime and dev_local is None:
        raise RuntimeError(
            f"{label} automation artifact must use the dedicated automation runtime "
            "or include automationEnabled dev.local.json"
        )


def resolve_provenance_artifact_path(extension_input_dir, provenance, artifact_key):
    raw_path = (
        provenance.get("artifacts", {}).get(artifact_key, {}).get("path")
        or provenance.get("source", {}).get(artifact_key)
    )
    if not raw_path:
        return None
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = Path(extension_input_dir) / candidate.name
    return candidate if candidate.exists() else None


def find_latest_automation_chrome_zip(extension_input_dir):
    extension_input_dir = Path(extension_input_dir)
    matches = []
    for path in extension_input_dir.glob("chrome_*_automation.zip"):
        version = path.name.removeprefix("chrome_").removesuffix("_automation.zip")
        parts = version.split(".", 2)
        try:
            key = tuple(int(part) for part in parts[:3])
        except ValueError:
            key = (0, 0, 0)
        matches.append((key, path.name, path))
    if not matches:
        return None
    return sorted(matches, reverse=True)[0][2]


def resolve_automation_chrome_zip(extension_input_dir, provenance):
    from_provenance = resolve_provenance_artifact_path(extension_input_dir, provenance, "chromeZip")
    if from_provenance:
        return from_provenance
    fallback = find_latest_automation_chrome_zip(extension_input_dir)
    if fallback:
        return fallback
    raise RuntimeError(
        f"Chromium automation ZIP not found in {extension_input_dir}; expected chrome_<version>_automation.zip"
    )


def read_pyproject_version(path):
    text = Path(path).read_text(encoding="utf8")
    in_project = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "[project]":
            in_project = True
            continue
        if line.startswith("[") and in_project:
            break
        if in_project and line.startswith("version"):
            _, value = line.split("=", 1)
            return value.strip().strip('"').strip("'")
    return None


def verify_source_license_metadata():
    errors = []
    for package_name, package_dir in PACKAGES.items():
        pyproject_path = package_dir / "pyproject.toml"
        text = pyproject_path.read_text(encoding="utf8")
        if f'license = {{text = "{EXPECTED_LICENSE}"}}' not in text:
            errors.append(f"{package_name}: missing {EXPECTED_LICENSE} project license")
        if f'"{EXPECTED_LICENSE_CLASSIFIER}"' not in text:
            errors.append(f"{package_name}: missing AGPL trove classifier")
    if errors:
        raise RuntimeError("PyPI license metadata validation failed: " + "; ".join(errors))
    if not LICENSE_SOURCE.exists():
        raise RuntimeError(f"Repository license file not found: {LICENSE_SOURCE}")
    license_text = LICENSE_SOURCE.read_text(encoding="utf8")
    if "GNU AFFERO GENERAL PUBLIC LICENSE" not in license_text:
        raise RuntimeError(f"Repository license is not GNU AGPL: {LICENSE_SOURCE}")


def verify_wheel_license(wheel_path):
    with zipfile.ZipFile(wheel_path) as archive:
        names = archive.namelist()
        metadata_names = [name for name in names if name.endswith(".dist-info/METADATA")]
        license_names = [
            name for name in names
            if name.endswith(".dist-info/licenses/LICENSE.txt") or name.endswith(".dist-info/LICENSE.txt")
        ]
        if len(metadata_names) != 1:
            raise RuntimeError(f"Expected one wheel METADATA file, found {len(metadata_names)}: {wheel_path}")
        if len(license_names) != 1:
            raise RuntimeError(f"Expected one bundled AGPL LICENSE.txt, found {len(license_names)}: {wheel_path}")
        metadata = archive.read(metadata_names[0]).decode("utf8")
        license_text = archive.read(license_names[0]).decode("utf8")
    if f"License: {EXPECTED_LICENSE}" not in metadata:
        raise RuntimeError(f"Wheel metadata does not declare {EXPECTED_LICENSE}: {wheel_path}")
    if f"Classifier: {EXPECTED_LICENSE_CLASSIFIER}" not in metadata:
        raise RuntimeError(f"Wheel metadata does not include the AGPL classifier: {wheel_path}")
    if "GNU AFFERO GENERAL PUBLIC LICENSE" not in license_text:
        raise RuntimeError(f"Wheel does not bundle the GNU AGPL license text: {wheel_path}")


def _safe_extract_zip_bytes(zip_bytes, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not str(target).startswith(f"{destination}{os.sep}") and target != destination:
                raise RuntimeError(f"Unsafe extension archive member: {member.filename}")
        archive.extractall(destination)


def unpack_crx(crx_path, destination):
    data = Path(crx_path).read_bytes()
    if data[:4] != b"Cr24":
        _safe_extract_zip_bytes(data, destination)
        return

    if len(data) < 12:
        raise RuntimeError(f"Invalid CRX file: {crx_path}")
    version = struct.unpack_from("<I", data, 4)[0]
    if version == 2:
        if len(data) < 16:
            raise RuntimeError(f"Invalid CRX2 file: {crx_path}")
        public_key_len, signature_len = struct.unpack_from("<II", data, 8)
        zip_offset = 16 + public_key_len + signature_len
    elif version == 3:
        header_len = struct.unpack_from("<I", data, 8)[0]
        zip_offset = 12 + header_len
    else:
        raise RuntimeError(f"Unsupported CRX version {version}: {crx_path}")
    _safe_extract_zip_bytes(data[zip_offset:], destination)


def copy_extension_artifacts(staged_package, extension_input_dir):
    extension_input_dir = Path(extension_input_dir)
    crx_path = extension_input_dir / AUTOMATION_CRX_FILE
    xpi_path = extension_input_dir / AUTOMATION_XPI_FILE
    source_provenance_path = extension_input_dir / AUTOMATION_PROVENANCE_FILE
    if not crx_path.exists():
        raise RuntimeError(f"CRX file not found for PyPI package: {crx_path}")
    if not xpi_path.exists():
        raise RuntimeError(f"XPI file not found for PyPI package: {xpi_path}")
    if not source_provenance_path.exists():
        raise RuntimeError(f"Automation extension provenance not found for PyPI package: {source_provenance_path}")
    source_provenance = read_json(source_provenance_path)
    if source_provenance.get("automationEnabledDefault") is not True:
        raise RuntimeError(f"{AUTOMATION_PROVENANCE_FILE} must set automationEnabledDefault: true")
    chrome_zip_path = resolve_automation_chrome_zip(extension_input_dir, source_provenance)

    extensions_dir = Path(staged_package) / "src" / "pentestkit" / "extensions"
    chromium_unpacked = extensions_dir / "chromium-unpacked"
    if chromium_unpacked.exists():
        shutil.rmtree(chromium_unpacked)
    for filename in (
        PACKAGE_ZIP_FILE,
        PACKAGE_CHROMIUM_ZIP_FILE,
        PACKAGE_CRX_FILE,
        PACKAGE_CHROMIUM_CRX_FILE,
        PACKAGE_XPI_FILE,
        PACKAGE_FIREFOX_XPI_FILE,
        PACKAGE_PROVENANCE_FILE,
    ):
        path = extensions_dir / filename
        if path.exists():
            path.unlink()

    shutil.copyfile(chrome_zip_path, extensions_dir / PACKAGE_ZIP_FILE)
    shutil.copyfile(chrome_zip_path, extensions_dir / PACKAGE_CHROMIUM_ZIP_FILE)
    shutil.copyfile(crx_path, extensions_dir / PACKAGE_CRX_FILE)
    shutil.copyfile(crx_path, extensions_dir / PACKAGE_CHROMIUM_CRX_FILE)
    shutil.copyfile(xpi_path, extensions_dir / PACKAGE_XPI_FILE)
    shutil.copyfile(xpi_path, extensions_dir / PACKAGE_FIREFOX_XPI_FILE)
    chromium_unpacked.mkdir(parents=True, exist_ok=True)
    unpack_crx(crx_path, chromium_unpacked)

    chromium_manifest_path = chromium_unpacked / "manifest.json"
    chromium_dev_local_path = chromium_unpacked / DEV_LOCAL_CONFIG_FILE
    if not chromium_manifest_path.exists():
        raise RuntimeError(f"Unpacked Chromium manifest not found: {chromium_manifest_path}")
    chromium_manifest = read_json(chromium_manifest_path)
    chromium_dev_local = read_json(chromium_dev_local_path) if chromium_dev_local_path.exists() else None
    firefox_manifest = read_zip_json(xpi_path, "manifest.json")
    firefox_dev_local = read_zip_json_optional(xpi_path, DEV_LOCAL_CONFIG_FILE)
    chromium_zip_manifest = read_zip_json(chrome_zip_path, "manifest.json")
    chromium_zip_dev_local = read_zip_json_optional(chrome_zip_path, DEV_LOCAL_CONFIG_FILE)
    for label, manifest, dev_local in (
        ("Chromium", chromium_manifest, chromium_dev_local),
        ("Chromium ZIP", chromium_zip_manifest, chromium_zip_dev_local),
        ("Firefox", firefox_manifest, firefox_dev_local),
    ):
        validate_automation_artifact(label, manifest, dev_local)
    if chromium_manifest.get("version") != firefox_manifest.get("version"):
        raise RuntimeError(
            "Extension artifact version mismatch: "
            f"CRX={chromium_manifest.get('version')} XPI={firefox_manifest.get('version')}"
        )
    if chromium_zip_manifest.get("version") != chromium_manifest.get("version"):
        raise RuntimeError(
            "Extension artifact version mismatch: "
            f"ZIP={chromium_zip_manifest.get('version')} CRX={chromium_manifest.get('version')}"
        )

    with zipfile.ZipFile(chrome_zip_path) as archive:
        chrome_zip_manifest_bytes = archive.read("manifest.json")
    with zipfile.ZipFile(xpi_path) as archive:
        xpi_manifest_bytes = archive.read("manifest.json")
    tree = hash_tree(chromium_unpacked)
    package_version = read_pyproject_version(Path(staged_package) / "pyproject.toml")
    provenance = {
        "schemaVersion": "ptk-extension-provenance-v1",
        "packageName": "pentestkit",
        "packageVersion": package_version,
        "extensionVersion": chromium_manifest.get("version"),
        "manifestVersion": chromium_manifest.get("manifest_version"),
        "automationEnabledDefault": True,
        "automationArtifactProvenance": source_provenance,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "artifactSource": "automation-artifact",
        "inputDir": str(extension_input_dir),
        "pypi": {
            "packageName": "pentestkit",
            "packageVersion": package_version,
        },
        "manifests": {
            "chromium": {
                "version": chromium_manifest.get("version"),
                "manifestVersion": chromium_manifest.get("manifest_version"),
                "sha256": sha256_file(chromium_manifest_path),
            },
            "firefox": {
                "version": firefox_manifest.get("version"),
                "manifestVersion": firefox_manifest.get("manifest_version"),
                "sha256": hashlib.sha256(xpi_manifest_bytes).hexdigest(),
                "browserSpecificSettings": firefox_manifest.get("browser_specific_settings")
                or firefox_manifest.get("applications"),
            },
        },
        "hashes": {
            "chromiumZipSha256": sha256_file(chrome_zip_path),
            "crxSha256": sha256_file(crx_path),
            "xpiSha256": sha256_file(xpi_path),
            "unpackedTreeSha256": tree["sha256"],
            "manifestSha256": sha256_file(chromium_manifest_path),
            "chromiumZipManifestSha256": hashlib.sha256(chrome_zip_manifest_bytes).hexdigest(),
            "xpiManifestSha256": hashlib.sha256(xpi_manifest_bytes).hexdigest(),
        },
        "sizes": {
            "chromiumZipBytes": chrome_zip_path.stat().st_size,
            "crxBytes": crx_path.stat().st_size,
            "xpiBytes": xpi_path.stat().st_size,
            "unpackedTreeBytes": tree["bytes"],
            "unpackedTreeFiles": tree["files"],
            "manifestBytes": chromium_manifest_path.stat().st_size,
            "chromiumZipManifestBytes": len(chrome_zip_manifest_bytes),
            "xpiManifestBytes": len(xpi_manifest_bytes),
        },
        "paths": {
            "chromiumUnpacked": "pentestkit/extensions/chromium-unpacked",
            "chromiumZip": f"pentestkit/extensions/{PACKAGE_CHROMIUM_ZIP_FILE}",
            "legacyZip": f"pentestkit/extensions/{PACKAGE_ZIP_FILE}",
            "crx": f"pentestkit/extensions/{PACKAGE_CRX_FILE}",
            "chromiumCrx": f"pentestkit/extensions/{PACKAGE_CHROMIUM_CRX_FILE}",
            "xpi": f"pentestkit/extensions/{PACKAGE_XPI_FILE}",
            "firefoxXpi": f"pentestkit/extensions/{PACKAGE_FIREFOX_XPI_FILE}",
            "provenance": f"pentestkit/extensions/{PACKAGE_PROVENANCE_FILE}",
        },
        "source": {
            "artifactSource": "automation-artifact",
            "inputDir": str(extension_input_dir),
            "chromeZip": chrome_zip_path.name,
            "crx": AUTOMATION_CRX_FILE,
            "xpi": AUTOMATION_XPI_FILE,
            "provenance": AUTOMATION_PROVENANCE_FILE,
        },
    }
    (extensions_dir / PACKAGE_PROVENANCE_FILE).write_text(
        f"{json.dumps(provenance, indent=2)}\n",
        encoding="utf8",
    )


def copy_package_for_build(expected_name, package_dir, staging_root, extension_input_dir=None):
    package_dir = Path(package_dir)
    doc_path = PACKAGE_DOCS[expected_name]
    if not doc_path.exists():
        raise RuntimeError(f"Published PyPI package doc not found: {doc_path}")

    staged = Path(staging_root) / package_dir.name

    def ignore(_dir, names):
        ignored = {
            ".venv",
            "venv",
            "__pycache__",
            ".pytest_cache",
            ".mypy_cache",
            "build",
            "dist",
        }
        return {
            name for name in names
            if name in ignored or name.endswith(".egg-info") or name.endswith(".pyc")
        }

    shutil.copytree(package_dir, staged, ignore=ignore)
    shutil.copyfile(doc_path, staged / "README.md")
    shutil.copyfile(LICENSE_SOURCE, staged / "LICENSE.txt")
    if expected_name == "pentestkit":
        copy_extension_artifacts(staged, extension_input_dir or DEFAULT_EXTENSION_INPUT_DIR)
    return staged


def verify_pentestkit_wheel(wheel_path):
    verify_wheel_license(wheel_path)
    required = {
        "pentestkit/extensions/__init__.py",
        f"pentestkit/extensions/{PACKAGE_ZIP_FILE}",
        f"pentestkit/extensions/{PACKAGE_CHROMIUM_ZIP_FILE}",
        f"pentestkit/extensions/{PACKAGE_CRX_FILE}",
        f"pentestkit/extensions/{PACKAGE_CHROMIUM_CRX_FILE}",
        f"pentestkit/extensions/{PACKAGE_XPI_FILE}",
        f"pentestkit/extensions/{PACKAGE_FIREFOX_XPI_FILE}",
        f"pentestkit/extensions/{PACKAGE_PROVENANCE_FILE}",
        "pentestkit/extensions/chromium-unpacked/manifest.json",
    }
    with zipfile.ZipFile(wheel_path) as archive:
        names = set(archive.namelist())
        provenance = json.loads(archive.read(f"pentestkit/extensions/{PACKAGE_PROVENANCE_FILE}").decode("utf8"))
        unpacked_manifest = json.loads(
            archive.read("pentestkit/extensions/chromium-unpacked/manifest.json").decode("utf8")
        )
        unpacked_dev_local_name = f"pentestkit/extensions/chromium-unpacked/{DEV_LOCAL_CONFIG_FILE}"
        unpacked_dev_local = (
            json.loads(archive.read(unpacked_dev_local_name).decode("utf8"))
            if unpacked_dev_local_name in names
            else None
        )
        with zipfile.ZipFile(io.BytesIO(archive.read(f"pentestkit/extensions/{PACKAGE_CHROMIUM_ZIP_FILE}"))) as extension_zip:
            zip_manifest = json.loads(extension_zip.read("manifest.json").decode("utf8"))
            try:
                zip_dev_local = json.loads(extension_zip.read(DEV_LOCAL_CONFIG_FILE).decode("utf8"))
            except KeyError:
                zip_dev_local = None
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"pentestkit wheel missing bundled extension files: {missing}")
    if provenance.get("automationEnabledDefault") is not True:
        raise RuntimeError("pentestkit wheel extension provenance does not mark automationEnabledDefault: true")
    validate_automation_artifact("pentestkit wheel Chromium extension", unpacked_manifest, unpacked_dev_local)
    validate_automation_artifact("pentestkit wheel Chromium ZIP", zip_manifest, zip_dev_local)


def build_wheels(out_dir, build_isolation: bool = True, include_internal: bool = False, extension_input_dir=None):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    built = []
    package_names = PUBLIC_PACKAGE_NAMES + (INTERNAL_PACKAGE_NAMES if include_internal else [])
    with tempfile.TemporaryDirectory(prefix="ptk-pypi-stage-") as staging_root:
        for expected_name in package_names:
            package_dir = PACKAGES[expected_name]
            staged_package = copy_package_for_build(
                expected_name,
                package_dir,
                staging_root,
                extension_input_dir=extension_input_dir,
            )
            before = {path.name for path in out.glob("*.whl")}
            command = [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(out),
                str(staged_package),
            ]
            if not build_isolation:
                command.insert(5, "--no-build-isolation")
            run(command)
            after = {path.name for path in out.glob("*.whl")}
            created = sorted(after - before)
            matched = [name for name in created if name.startswith(f"{expected_name}-")]
            if not matched:
                raise RuntimeError(
                    f"Building {package_dir} did not produce expected {expected_name} wheel. "
                    f"Created: {created or 'none'}"
                )
            if expected_name == "pentestkit":
                verify_pentestkit_wheel(out / matched[-1])
            else:
                verify_wheel_license(out / matched[-1])
            built.extend(matched)
    return sorted(set(built))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Smoke test PTK PyPI package shape")
    parser.add_argument("--no-build", action="store_true", help="Skip local wheel builds")
    parser.add_argument("--no-build-isolation", action="store_true", help="Build without isolated PEP 517 env")
    parser.add_argument("--include-internal", action="store_true", help="Also build internal implementation wheels")
    parser.add_argument(
        "--extension-input-dir",
        default=str(DEFAULT_EXTENSION_INPUT_DIR),
        help="Directory containing chrome_<version>_automation.zip, ptk-latest-automation.crx, ptk-latest-automation.xpi, and extension-provenance-automation.json",
    )
    parser.add_argument("--out-dir", default=None, help="Wheel output directory")
    args = parser.parse_args(argv)

    verify_source_license_metadata()
    compile_sources()
    import_result = import_smoke()
    wheels = []
    if not args.no_build:
        out_dir = args.out_dir or tempfile.mkdtemp(prefix="ptk-pypi-wheels-")
        wheels = build_wheels(
            out_dir,
            build_isolation=not args.no_build_isolation,
            include_internal=args.include_internal,
            extension_input_dir=args.extension_input_dir,
        )

    print(json.dumps({
        "ok": True,
        "root": str(ROOT),
        "import": import_result,
        "wheels": wheels,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
