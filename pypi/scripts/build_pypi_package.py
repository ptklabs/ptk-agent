#!/usr/bin/env python3
import argparse
import json
import os
import sys
import tarfile
import tempfile
import zipfile
import io
from pathlib import Path

import smoke_packages


ROOT = Path(__file__).resolve().parents[1]
PTK_ROOT = ROOT.parents[1]
DEFAULT_EXTENSION_INPUT_DIR = PTK_ROOT / "dist"
DEFAULT_OUT_DIR = ROOT / ".release" / "pypi"
PUBLIC_PACKAGE_NAME = "pentestkit"
SDIST_SUFFIXES = [
    "pyproject.toml",
    "README.md",
    "LICENSE.txt",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_ZIP_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_CHROMIUM_ZIP_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_CRX_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_CHROMIUM_CRX_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_XPI_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_FIREFOX_XPI_FILE}",
    f"src/pentestkit/extensions/{smoke_packages.PACKAGE_PROVENANCE_FILE}",
    "src/pentestkit/extensions/chromium-unpacked/manifest.json",
]


def run(command, cwd=None, env=None):
    return smoke_packages.run(command, cwd=cwd, env=env)


def clean_public_artifacts(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for pattern in ("pentestkit-*.whl", "pentestkit-*.tar.gz"):
        for artifact in out.glob(pattern):
            artifact.unlink()


def build_wheel(staged_package, out_dir, build_isolation=True):
    before = {path.name for path in Path(out_dir).glob("*.whl")}
    command = [
        sys.executable,
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "--wheel-dir",
        str(out_dir),
        str(staged_package),
    ]
    if not build_isolation:
        command.insert(5, "--no-build-isolation")
    run(command)
    after = {path.name for path in Path(out_dir).glob("*.whl")}
    created = sorted(after - before)
    matched = [name for name in created if name.startswith("pentestkit-")]
    if not matched:
        raise RuntimeError(f"PyPI wheel build did not produce a pentestkit wheel. Created: {created or 'none'}")
    wheel_path = Path(out_dir) / matched[-1]
    smoke_packages.verify_pentestkit_wheel(wheel_path)
    return wheel_path


def build_sdist(staged_package, out_dir):
    before = {path.name for path in Path(out_dir).glob("*.tar.gz")}
    code = (
        "import setuptools.build_meta as build_meta; "
        f"print(build_meta.build_sdist({str(Path(out_dir)).__repr__()}))"
    )
    try:
        run([sys.executable, "-c", code], cwd=staged_package)
    except RuntimeError as error:
        if "No module named 'setuptools'" not in str(error):
            raise
        with tempfile.TemporaryDirectory(prefix="ptk-pypi-build-deps-") as build_deps:
            run([
                sys.executable,
                "-m",
                "pip",
                "install",
                "--target",
                build_deps,
                "setuptools>=61.0",
                "wheel",
            ])
            pythonpath = build_deps
            if os.environ.get("PYTHONPATH"):
                pythonpath = f"{build_deps}{os.pathsep}{os.environ['PYTHONPATH']}"
            run([sys.executable, "-c", code], cwd=staged_package, env={"PYTHONPATH": pythonpath})
    after = {path.name for path in Path(out_dir).glob("*.tar.gz")}
    created = sorted(after - before)
    matched = [name for name in created if name.startswith("pentestkit-")]
    if not matched:
        raise RuntimeError(f"PyPI sdist build did not produce a pentestkit source distribution. Created: {created or 'none'}")
    sdist_path = Path(out_dir) / matched[-1]
    verify_pentestkit_sdist(sdist_path)
    return sdist_path


def read_tar_json(archive, suffix):
    members = [member for member in archive.getmembers() if member.name.endswith(suffix)]
    if len(members) != 1:
        raise RuntimeError(f"Expected one sdist member ending with {suffix}, found {len(members)}")
    handle = archive.extractfile(members[0])
    if handle is None:
        raise RuntimeError(f"Could not read sdist member: {members[0].name}")
    return json.loads(handle.read().decode("utf8"))


def read_tar_optional_json(archive, suffix):
    members = [member for member in archive.getmembers() if member.name.endswith(suffix)]
    if not members:
        return None
    if len(members) != 1:
        raise RuntimeError(f"Expected at most one sdist member ending with {suffix}, found {len(members)}")
    handle = archive.extractfile(members[0])
    if handle is None:
        raise RuntimeError(f"Could not read sdist member: {members[0].name}")
    return json.loads(handle.read().decode("utf8"))


def read_tar_bytes(archive, suffix):
    members = [member for member in archive.getmembers() if member.name.endswith(suffix)]
    if len(members) != 1:
        raise RuntimeError(f"Expected one sdist member ending with {suffix}, found {len(members)}")
    handle = archive.extractfile(members[0])
    if handle is None:
        raise RuntimeError(f"Could not read sdist member: {members[0].name}")
    return handle.read()


def read_sdist_package_metadata(archive):
    members = [
        member for member in archive.getmembers()
        if member.name.endswith("/PKG-INFO") and member.name.count("/") == 1
    ]
    if len(members) != 1:
        raise RuntimeError(f"Expected one root sdist PKG-INFO, found {len(members)}")
    handle = archive.extractfile(members[0])
    if handle is None:
        raise RuntimeError(f"Could not read sdist package metadata: {members[0].name}")
    return handle.read()


def verify_pentestkit_sdist(sdist_path):
    with tarfile.open(sdist_path, "r:gz") as archive:
        names = set(archive.getnames())
        missing = []
        for suffix in SDIST_SUFFIXES:
            if not any(name.endswith(suffix) for name in names):
                missing.append(suffix)
        if missing:
            raise RuntimeError(f"pentestkit sdist missing bundled extension files: {missing}")
        license_text = read_tar_bytes(archive, "LICENSE.txt").decode("utf8")
        package_metadata = read_sdist_package_metadata(archive).decode("utf8")
        provenance = read_tar_json(
            archive,
            f"src/pentestkit/extensions/{smoke_packages.PACKAGE_PROVENANCE_FILE}",
        )
        unpacked_manifest = read_tar_json(
            archive,
            "src/pentestkit/extensions/chromium-unpacked/manifest.json",
        )
        unpacked_dev_local = read_tar_optional_json(
            archive,
            f"src/pentestkit/extensions/chromium-unpacked/{smoke_packages.DEV_LOCAL_CONFIG_FILE}",
        )
        chromium_zip_bytes = read_tar_bytes(
            archive,
            f"src/pentestkit/extensions/{smoke_packages.PACKAGE_CHROMIUM_ZIP_FILE}",
        )
        with zipfile.ZipFile(io.BytesIO(chromium_zip_bytes)) as extension_zip:
            zip_manifest = json.loads(extension_zip.read("manifest.json").decode("utf8"))
            try:
                zip_dev_local = json.loads(
                    extension_zip.read(smoke_packages.DEV_LOCAL_CONFIG_FILE).decode("utf8")
                )
            except KeyError:
                zip_dev_local = None
    if "GNU AFFERO GENERAL PUBLIC LICENSE" not in license_text:
        raise RuntimeError("pentestkit sdist does not bundle the GNU AGPL license text")
    if f"License: {smoke_packages.EXPECTED_LICENSE}" not in package_metadata:
        raise RuntimeError(f"pentestkit sdist metadata does not declare {smoke_packages.EXPECTED_LICENSE}")
    if f"Classifier: {smoke_packages.EXPECTED_LICENSE_CLASSIFIER}" not in package_metadata:
        raise RuntimeError("pentestkit sdist metadata does not include the AGPL classifier")
    if provenance.get("automationEnabledDefault") is not True:
        raise RuntimeError("pentestkit sdist extension provenance does not mark automationEnabledDefault: true")
    smoke_packages.validate_automation_artifact(
        "pentestkit sdist Chromium extension", unpacked_manifest, unpacked_dev_local
    )
    smoke_packages.validate_automation_artifact(
        "pentestkit sdist Chromium ZIP", zip_manifest, zip_dev_local
    )


def copy_stage(staging_root, extension_input_dir):
    return smoke_packages.copy_package_for_build(
        PUBLIC_PACKAGE_NAME,
        smoke_packages.PACKAGES[PUBLIC_PACKAGE_NAME],
        staging_root,
        extension_input_dir=extension_input_dir,
    )


def build_package(out_dir, extension_input_dir, build_isolation=True, skip_smoke=False):
    out = Path(out_dir).resolve()
    extension_input = Path(extension_input_dir).resolve()
    clean_public_artifacts(out)
    import_result = None
    if not skip_smoke:
        smoke_packages.compile_sources()
        import_result = smoke_packages.import_smoke()

    with tempfile.TemporaryDirectory(prefix="ptk-pypi-build-") as staging_root:
        staged_package = copy_stage(staging_root, extension_input)
        wheel_path = build_wheel(staged_package, out, build_isolation=build_isolation)
        sdist_path = build_sdist(staged_package, out)

    return {
        "ok": True,
        "packageName": PUBLIC_PACKAGE_NAME,
        "outDir": str(out),
        "artifactSource": "automation-artifact",
        "extensionInputDir": str(extension_input),
        "artifacts": {
            "wheel": str(wheel_path),
            "sdist": str(sdist_path),
        },
        "import": import_result,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build publishable PTK PyPI package artifacts")
    parser.add_argument(
        "--extension-input-dir",
        default=str(DEFAULT_EXTENSION_INPUT_DIR),
        help="Directory containing chrome_<version>_automation.zip, ptk-latest-automation.crx, ptk-latest-automation.xpi, and extension-provenance-automation.json",
    )
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="PyPI artifact output directory")
    parser.add_argument("--no-build-isolation", action="store_true", help="Build wheel without isolated PEP 517 env")
    parser.add_argument("--skip-smoke", action="store_true", help="Skip compile/import smoke before building")
    args = parser.parse_args(argv)

    result = build_package(
        out_dir=args.out_dir,
        extension_input_dir=args.extension_input_dir,
        build_isolation=not args.no_build_isolation,
        skip_smoke=args.skip_smoke,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
