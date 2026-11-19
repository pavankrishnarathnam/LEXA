# syntax=docker/dockerfile:1.7
# LEXA backend image (API + worker share this image; the command differs).
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS deps
COPY requirements.lock .
# Optional custom CA (corporate/egress TLS proxies): docker build --secret id=build_ca,src=/path/ca.pem
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir -r requirements.lock

FROM base AS runtime
ARG INSTALL_BROWSER=false
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} UPLOAD_DIR=/data/uploads TRADER_DATA_DIR=/data/trader ENVIRONMENT=production
COPY --from=deps /usr/local /usr/local
# Optional headless Chromium for JavaScript-rendered pages (adds ~400MB).
RUN if [ "$INSTALL_BROWSER" = "true" ]; then pip install --no-cache-dir playwright==1.65.1 \
      && playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi
RUN groupadd --system lexa && useradd --system --gid lexa --home /app lexa \
    && mkdir -p /data/uploads /data/trader /backups && chown -R lexa:lexa /data /backups
COPY --chown=lexa:lexa main.py alembic.ini ./
COPY --chown=lexa:lexa api ./api
COPY --chown=lexa:lexa core ./core
COPY --chown=lexa:lexa agents ./agents
COPY --chown=lexa:lexa orchestration ./orchestration
COPY --chown=lexa:lexa memory ./memory
COPY --chown=lexa:lexa integrations ./integrations
COPY --chown=lexa:lexa database ./database
COPY --chown=lexa:lexa workers ./workers
COPY --chown=lexa:lexa trading ./trading
USER lexa
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "2"]
