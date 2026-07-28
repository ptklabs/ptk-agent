"""
Parallel-safe profile directory management for PTK Playwright SDK.

Provides browser profile locking and allocation for safe parallel execution.
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

    Usage:
        profiles = ProfileManager("~/.ptk-playwright/profiles")
        profile_dir = profiles.allocate("chromium", worker_id="worker-1")
        try:
            # Use profile...
        finally:
            profiles.release(profile_dir)
    """

    LOCK_FILENAME = ".ptk-sdk-lock"
    LOCK_STALE_HOURS = 24

    def __init__(self, base_dir: str, sdk_name: str = "ptk-playwright-sdk"):
        """
        Initialize profile manager.

        Args:
            base_dir: Base directory for profiles (e.g., ~/.ptk-playwright/profiles)
            sdk_name: Name to record in lock files
        """
        self.base_dir = Path(base_dir).expanduser()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.sdk_name = sdk_name

    def allocate(self, browser: str, worker_id: str = None, create_if_missing: bool = True) -> str:
        """
        Allocate a profile directory for a worker.

        Pattern: {base_dir}/{browser}-worker-{worker_id}

        Args:
            browser: Browser type (e.g., "chromium", "chrome")
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

    def _acquire_lock(self, profile_dir: Path) -> None:
        """Create SDK lock file with PID + timestamp + hostname."""
        lock_file = profile_dir / self.LOCK_FILENAME

        if lock_file.exists():
            try:
                lock_data = json.loads(lock_file.read_text())
                if self._is_lock_valid(lock_data):
                    started_by = lock_data.get("startedBy", "unknown")
                    raise ProfileLockedError(
                        f"Profile locked by PID {lock_data['pid']} on {lock_data['hostname']} "
                        f"(started by: {started_by}). "
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
        """Check if lock is held by a running process."""
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
