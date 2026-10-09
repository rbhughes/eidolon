"""Detect when a captured chunk is an exact repeat of recent audio.

Some internet radio relays intermittently serve a short looped segment
instead of true live audio -- observed as a constant loop on one station
(since replaced) and as an intermittent few-times-a-minute repeat on
another. Both showed up as byte-for-byte identical captures seconds to tens
of seconds apart. Catching this generically, rather than re-discovering and
manually vetting each flaky station, is the point of this module.
"""

from __future__ import annotations

import hashlib
import time
from collections import deque


class DuplicateDetector:
    def __init__(self, window_seconds: float = 120.0, max_entries: int = 200):
        self._window_seconds = window_seconds
        self._max_entries = max_entries
        self._seen: deque[tuple[str, float]] = deque()  # (md5, seen_at)

    def check(self, pcm: bytes) -> bool:
        """Record this chunk's hash and return True if it exactly matches
        a chunk already seen within the recent window."""
        now = time.time()
        digest = hashlib.md5(pcm).hexdigest()

        cutoff = now - self._window_seconds
        while self._seen and (self._seen[0][1] < cutoff or len(self._seen) > self._max_entries):
            self._seen.popleft()

        is_dup = any(digest == seen_digest for seen_digest, _ in self._seen)
        self._seen.append((digest, now))
        return is_dup
