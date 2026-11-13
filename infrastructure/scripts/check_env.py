"""CI check: every backend setting is documented in .env.example, compose variables are defined, and no
real secrets are present in the example file. Run from the repository root: python infrastructure/scripts/check_env.py"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from core.config import Settings  # noqa: E402

# Settings composed by docker-compose or intentionally internal.
COMPOSED = {"DATABASE_URL", "REDIS_URL", "ENVIRONMENT", "APP_NAME", "EMBEDDING_DIM", "WORKER_POLL_INTERVAL",
            "AGENT_MAX_TOOL_ITERATIONS", "JWT_ACCESS_TTL_MINUTES", "JWT_REFRESH_TTL_DAYS", "COOKIE_DOMAIN"}
SECRET_KEYS = {"JWT_SECRET", "ENCRYPTION_KEY", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "ANTHROPIC_API_KEY",
               "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"}


def main() -> int:
    example = (ROOT / ".env.example").read_text()
    keys = dict(re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", example, re.M))
    commented = set(re.findall(r"^#\s*([A-Z][A-Z0-9_]*)=", example, re.M))
    errors: list[str] = []
    for name in Settings.model_fields:
        env = name.upper()
        if env not in keys and env not in commented and env not in COMPOSED:
            errors.append(f"Setting {env} is not documented in .env.example")
    for k in SECRET_KEYS:
        if keys.get(k, "").strip():
            errors.append(f"{k} must be empty in .env.example (never commit secrets)")
    compose = (ROOT / "docker-compose.yml").read_text()
    for var in set(re.findall(r"\$\{([A-Z_]+)[:?}-]", compose)):
        if var not in keys and var not in {"HTTP_PORT", "HTTPS_PORT", "INSTALL_BROWSER"}:
            errors.append(f"docker-compose variable {var} is missing from .env.example")
    if (ROOT / ".env").exists():
        import subprocess
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", ".env"], cwd=ROOT, capture_output=True)
        if tracked.returncode == 0:
            errors.append(".env is tracked by git — remove it and rotate the secrets")
    for e in errors:
        print(f"::error::{e}")
    print("environment configuration OK" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
