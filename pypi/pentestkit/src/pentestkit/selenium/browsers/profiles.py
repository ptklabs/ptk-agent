"""
Parallel-safe profile directory management for PTK Selenium SDK.

This module provides browser-agnostic profile locking and allocation,
ensuring safe parallel execution in CI environments.
"""

import json
import os
import socket
import tempfile
import time
from pathlib import Path


class ProfileLockedError(Exception):
    """Profile is locked by another process."""


class ProfileNotFoundError(Exception):
    """Profile directory not found."""


class ProfileManager:
    """
    Parallel-safe profile directory allocation with explicit SDK locks.

    IMPORTANT: This manager does NOT auto-delete profiles. Users who seed
    profiles (PTK installed, settings configured) won't lose their work.

    Usage:
        profiles = ProfileManager("~/.ptk-selenium/profiles")
        profile_dir = profiles.allocate("chromium", worker_id="worker-1")
        try:
            # Use profile...
        finally:
            profiles.release(profile_dir)
    """

    LOCK_FILENAME = ".ptk-sdk-lock"
    LOCK_STALE_HOURS = 24

    def __init__(self, base_dir: str, sdk_name: str = "ptk-sdk"):
        """
        Initialize profile manager.

        Args:
            base_dir: Base directory for profiles (e.g., ~/.ptk-selenium/profiles)
            sdk_name: Name to record in lock files (e.g., "ptk-selenium-sdk")
        """
        self.base_dir = Path(base_dir).expanduser()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.sdk_name = sdk_name

    def allocate(self, browser: str, worker_id: str = None, create_if_missing: bool = True) -> str:
        """
        Allocate a profile directory for a worker.

        Pattern: {base_dir}/{browser}-worker-{worker_id}

        - Creates directory if create_if_missing=True
        - Acquires SDK lock (refuses if locked by another process)
        - Does NOT clean or modify existing profile contents

        Args:
            browser: Browser type (e.g., "chromium", "chrome", "firefox")
            worker_id: Worker identifier for parallel runs (default: "default")
            create_if_missing: Create directory if it doesn't exist

        Returns:
            Absolute path to the allocated profile directory

        Raises:
            ProfileLockedError: If profile is locked by another process
            ProfileNotFoundError: If profile doesn't exist and create_if_missing=False
        """
        worker_id = worker_id or "default"
        profile_dir = self.base_dir / f"{browser}-worker-{worker_id}"

        if create_if_missing:
            profile_dir.mkdir(parents=True, exist_ok=True)
        elif not profile_dir.exists():
            raise ProfileNotFoundError(f"Profile not found: {profile_dir}")

        self._acquire_lock(profile_dir)
        return str(profile_dir)

    def lock(self, profile_dir: str) -> None:
        """
        Acquire SDK lock on an explicit profile directory.

        Args:
            profile_dir: Path to profile directory to lock

        Raises:
            ProfileLockedError: If profile is locked by another process
        """
        self._acquire_lock(Path(profile_dir))

    def release(self, profile_dir: str) -> None:
        """
        Release SDK lock on a profile.

        Args:
            profile_dir: Path to profile directory to unlock
        """
        self._release_lock(Path(profile_dir))

    def reset_profile(self, profile_dir: str, keep_extension: bool = True) -> None:
        """
        DANGEROUS: Reset a profile to clean state.

        WARNING: This is intended for SDK-managed temp profiles only.
        DO NOT use on seeded Chrome/Edge profiles - you will lose your extension!

        Args:
            profile_dir: Path to profile directory to reset
            keep_extension: If True, preserve the 'extensions' subdirectory
        """
        path = Path(profile_dir)
        if not path.exists():
            return

        preserve = {"extensions"} if keep_extension else set()

        for item in path.iterdir():
            if item.name in preserve:
                continue
            if item.name == self.LOCK_FILENAME:
                continue
            if item.is_dir():
                import shutil

                shutil.rmtree(item)
            else:
                item.unlink()

    def cleanup_sdk_temps(self, max_age_hours: int = 24) -> None:
        """
        Clean up profiles created by SDK with temp=True marker.

        Only removes directories that have .ptk-sdk-temp marker file
        AND are older than max_age_hours.

        Args:
            max_age_hours: Maximum age in hours before cleanup
        """
        cutoff = time.time() - (max_age_hours * 3600)

        for profile_dir in self.base_dir.iterdir():
            if not profile_dir.is_dir():
                continue

            temp_marker = profile_dir / ".ptk-sdk-temp"
            if not temp_marker.exists():
                continue

            if temp_marker.stat().st_mtime < cutoff:
                import shutil

                shutil.rmtree(profile_dir)

    def _acquire_lock(self, profile_dir: Path) -> None:
        """
        Create SDK lock file with PID + timestamp + hostname.

        Uses atomic write (write to temp, then rename) to avoid races.
        """
        lock_file = profile_dir / self.LOCK_FILENAME

        if lock_file.exists():
            try:
                lock_data = json.loads(lock_file.read_text())
                if self._is_lock_valid(lock_data):
                    started_by = lock_data.get("startedBy", "unknown")
                    raise ProfileLockedError(
                        f"Profile locked by PID {lock_data['pid']} on {lock_data['hostname']} "
                        f"(started by: {started_by}). "
                        "If this is Chrome/Edge, the browser may still be running with this profile. "
                        "Close the browser or use a different profile."
                    )
            except json.JSONDecodeError:
                pass

        lock_data = {
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "timestamp": time.time(),
            "startedBy": self.sdk_name,
        }

        temp_fd, temp_path = tempfile.mkstemp(dir=profile_dir, prefix=".lock-")
        try:
            with os.fdopen(temp_fd, "w") as f:
                json.dump(lock_data, f)
            os.replace(temp_path, lock_file)
        except Exception:
            try:
                os.unlink(temp_path)
            except Exception:
                pass
            raise

    def _release_lock(self, profile_dir: Path) -> None:
        lock_file = profile_dir / self.LOCK_FILENAME
        if lock_file.exists():
            try:
                lock_file.unlink()
            except Exception:
                pass

    def _is_lock_valid(self, lock_data: dict) -> bool:
        """
        Check if lock is held by a running process.

        Returns False (stale) if:
        - Process is dead (same hostname)
        - Lock is older than LOCK_STALE_HOURS (any hostname - for CI)
        """
        lock_age_hours = (time.time() - lock_data.get("timestamp", 0)) / 3600

        if lock_age_hours > self.LOCK_STALE_HOURS:
            return False

        if lock_data.get("hostname") != socket.gethostname():
            return True

        try:
            os.kill(lock_data["pid"], 0)
            return True
        except OSError:
            return False
