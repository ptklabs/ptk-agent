import time
from typing import Callable, Optional, TypeVar

T = TypeVar("T")


def wait_for(fn: Callable[[], T], timeout: float, interval: float = 0.5) -> Optional[T]:
    """Wait for fn() to return a truthy value within timeout."""
    deadline = time.time() + timeout
    last_result = None

    while time.time() < deadline:
        last_result = fn()
        if last_result:
            return last_result
        time.sleep(interval)

    return None
