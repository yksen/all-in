# syntax=docker/dockerfile:1

# ---- deps: install production node_modules only ----
FROM oven/bun:1.3.5-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1.3.5-slim AS runtime
WORKDIR /app
# json logs (no pino-pretty in production deps); DATA_DIR holds the SQLite DB + backups.
ENV NODE_ENV=production \
    LOG_FORMAT=json \
    DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Persisted state lives here — mount a named volume (see docker-compose.yml).
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

# Drop to the image's non-root user.
USER bun

# The bot runs TypeScript directly under Bun (no separate compile step needed in-container).
CMD ["bun", "run", "src/index.ts"]
