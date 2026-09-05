# syntax=docker/dockerfile:1

# ---------- Dependencies ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- Build ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- Runtime ----------
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Install the system binaries used by server-side PDF tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    ghostscript \
    qpdf \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-deu \
    tesseract-ocr-fra \
    tesseract-ocr-spa \
    ocrmypdf \
    fonts-liberation \
    fonts-dejavu \
    fonts-noto-core \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Copy the standalone Next.js output.
#
# There is no `COPY /app/public` line: this repository has no `public/` directory
# (the favicon is `app/favicon.ico`, which the build inlines), and Docker fails a
# COPY whose source does not exist — so that line, carried over from the upstream
# Next.js example, made `docker build` impossible. Should a `public/` ever be
# added, `next build` places it inside the standalone output and the COPY below
# already brings it along.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The migration toolchain, which the standalone output does NOT contain: it traces
# the generated `@prisma/client` and its query engine, but not the `prisma` CLI and
# not `prisma/migrations`. Without these a fresh container starts against a
# database with no tables and 500s on the first query — and, on the no-egress
# network, cannot fetch the CLI to fix itself. Taken from `deps` so the engine
# binaries are the linux ones `npm ci` resolved in this image.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY --chown=nextjs:nodejs prisma ./prisma

# The ingress guard, which the standalone trace cannot know about: nothing in the
# application imports it, because it has to run BEFORE Next creates its
# `http.Server`. Without this directory the CMD below has no entry point and the
# generated `server.js` it would fall back to now refuses to start in production
# (`assertIngressInstalled`), so a missing COPY is a container that exits 1 at
# boot rather than one that quietly serves unguarded.
COPY --chown=nextjs:nodejs ingress ./ingress

# Writable, mountable state, created HERE so a named volume attached to any of
# these paths inherits `nextjs` ownership on first use. `/app` itself is
# root-owned, and the server runs as uid 1001: a directory the app creates lazily
# under `/app` (the default `.storage/local`) fails with EACCES on the first
# upload, which surfaces as a 500 on a user's save rather than as a config error.
RUN mkdir -p /app/data/admin /app/data/db /app/data/storage \
    && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000

# Liveness probe: the Node server answers /api/health. Uses Node's built-in
# fetch (no curl needed on the slim image). Runs as the non-root nextjs user.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrate, then serve — in that order, and only on success. `migrate deploy`
# applies pending migrations and is a no-op when there are none, so a restart is
# safe and a redeploy that adds a migration cannot serve the old schema. A
# migration failure exits non-zero here rather than leaving a container up and
# 500ing every request.
#
# `ingress/server.mjs`, never `server.js`: the guard installs itself around
# `http.createServer`, so it has to own the process before Next builds its
# server. This is the only supported entry point, and it is the artifact rather
# than a note in a runbook — which is what stops the topology from depending on
# an operator remembering a setting.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma && exec node ingress/server.mjs"]
