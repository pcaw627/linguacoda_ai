"""Rate limiting and concurrency tracking for the compute gateway."""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from threading import Lock


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


class RateLimiter:
    def __init__(self, max_per_minute: int = 60) -> None:
        self.max_per_minute = max_per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> tuple[bool, int]:
        now = time.time()
        with self._lock:
            window = self._hits[key]
            while window and window[0] < now - 60:
                window.popleft()
            if len(window) >= self.max_per_minute:
                retry_after = max(1, int(60 - (now - window[0])) + 1)
                return False, retry_after
            window.append(now)
            return True, 0


class ConcurrencyGate:
    def __init__(self, max_concurrent: int) -> None:
        self.max_concurrent = max_concurrent
        self.active = 0
        self.queued = 0
        self._lock = Lock()

    def try_acquire(self) -> bool:
        with self._lock:
            if self.active >= self.max_concurrent:
                self.queued += 1
                return False
            self.active += 1
            return True

    def release(self) -> None:
        with self._lock:
            self.active = max(0, self.active - 1)
            if self.queued > 0:
                self.queued -= 1

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {"active": self.active, "queued": self.queued}


class GatewayLimits:
    def __init__(self) -> None:
        self.rate_limiter = RateLimiter(
            _int_env("COMPUTE_RATE_LIMIT_PER_MIN", 60)
        )
        self.transcribe = ConcurrencyGate(
            _int_env("MAX_CONCURRENT_TRANSCRIPTIONS", 2)
        )
        self.ollama = ConcurrencyGate(_int_env("MAX_CONCURRENT_OLLAMA", 1))
