import json
import os
import socket
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from ptk_selenium.browsers.profiles import ProfileManager, ProfileLockedError


def test_profile_allocation_unique():
    with TemporaryDirectory() as tmp:
        mgr = ProfileManager(tmp)
        p1 = mgr.allocate("chrome", "1")
        mgr.release(p1)
        p2 = mgr.allocate("chrome", "2")
        mgr.release(p2)
        assert p1 != p2


def test_profile_locking():
    with TemporaryDirectory() as tmp:
        mgr = ProfileManager(tmp)
        p1 = mgr.allocate("chrome", "default")
        try:
            with pytest.raises(ProfileLockedError):
                mgr.allocate("chrome", "default")
        finally:
            mgr.release(p1)


def test_stale_lock_detection():
    with TemporaryDirectory() as tmp:
        mgr = ProfileManager(tmp)
        profile_dir = Path(tmp) / "chrome-worker-default"
        profile_dir.mkdir(parents=True, exist_ok=True)

        lock_file = profile_dir / mgr.LOCK_FILENAME
        lock_data = {
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "timestamp": time.time() - (mgr.LOCK_STALE_HOURS + 1) * 3600,
            "startedBy": "test",
        }
        lock_file.write_text(json.dumps(lock_data))

        mgr.lock(str(profile_dir))
        mgr.release(str(profile_dir))
