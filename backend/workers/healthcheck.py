"""Container health check for the worker: healthy if a heartbeat was written in the last 90 seconds."""
from __future__ import annotations

import os
import sys
from datetime import UTC, datetime

import redis


def main() -> int:
    try:
        hb = redis.from_url(os.environ["REDIS_URL"], socket_timeout=3).get("lexa:worker:heartbeat")
    except Exception:  # noqa: BLE001
        return 1
    if not hb:
        return 1
    text = hb.decode() if isinstance(hb, bytes) else str(hb)
    age = (datetime.now(UTC) - datetime.fromisoformat(text)).total_seconds()
    return 0 if age < 90 else 1


if __name__ == "__main__":
    sys.exit(main())
