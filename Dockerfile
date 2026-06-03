# Multi-stage build for augchatd. TLS is terminated by nginx (adr-0012);
# this image only listens on plain HTTP at AUGCHATD_PORT and must be kept
# off the public network — see docker-compose.yml.

FROM oven/bun:1 AS ui-builder
WORKDIR /build/ui
COPY ui/package.json ui/bun.lock ./
RUN bun install --frozen-lockfile
COPY ui/ ./
RUN bun run build

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS runtime
WORKDIR /app
COPY --from=deps       /app/node_modules ./node_modules
COPY --from=ui-builder /build/ui/dist    ./ui/dist
COPY src/             ./src/
COPY package.json tsconfig.json ./
ENV AUGCHATD_PORT=8080
EXPOSE 8080
CMD ["bun", "run", "start"]
