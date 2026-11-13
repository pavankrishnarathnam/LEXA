"""CLI used by deploy.sh to record deployment history: python -m workers.record_deployment VERSION SHA STATUS JSON"""
from __future__ import annotations

import asyncio
import json
import sys

from database.models import DeploymentRecord
from database.session import SessionLocal


async def main(version: str, sha: str, status: str, details: str) -> None:
    async with SessionLocal() as db:
        db.add(DeploymentRecord(version=version, git_sha=sha, status=status, details=json.loads(details or "{}")))
        await db.commit()


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:5]))
