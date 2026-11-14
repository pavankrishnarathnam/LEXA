# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Optional custom CA (corporate/egress TLS proxies): docker build --secret id=build_ca,src=/path/ca.pem
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ARG BACKEND_URL=http://backend:8000
ENV NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=${BACKEND_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 KEEP_ALIVE_TIMEOUT=65000
RUN addgroup -S lexa && adduser -S lexa -G lexa
COPY --from=build --chown=lexa:lexa /app/.next/standalone ./
COPY --from=build --chown=lexa:lexa /app/.next/static ./.next/static
COPY --from=build --chown=lexa:lexa /app/public ./public
USER lexa
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
