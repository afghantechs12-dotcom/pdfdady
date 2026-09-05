#!/bin/sh
# The audit origin, restarted the only order that works.
#
# `next build --output standalone` does NOT copy `.next/static` into
# `.next/standalone`, and a standalone server resolves its static directory ONCE at
# startup: copying the files in after the process is up changes nothing, and every
# `/_next/static/chunks/*.js` keeps answering 404 while the page renders and does
# nothing (audit §25). So: copy, then start — never the other way round.
#
# Env comes from `.env` (never echoed) plus the four audit overrides. DATABASE_URL is
# absolute and outside the repository, which is what the production gate demands and
# what keeps the audit's data off the tree.
set -e
cd "$(dirname "$0")/.."
rm -rf .next/standalone/.next/static
cp -R .next/static .next/standalone/.next/static
[ -d public ] && cp -R public .next/standalone/public 2>/dev/null || true
set -a
. ./.env
set +a
export NODE_ENV=production PORT="${PORT:-3002}" HOSTNAME=127.0.0.1
# The production topology, so the audit origin exercises the single-instance lease
# rather than a code path only containers reach.
export DEPLOYMENT_TOPOLOGY="${DEPLOYMENT_TOPOLOGY:-single-instance}"
export DATABASE_URL="${AUDIT_DATABASE_URL:-file:/tmp/audit-final-db.db}"
export NEXT_PUBLIC_SITE_URL="${AUDIT_SITE_URL:-https://172.20.10.2:3001}"
# The guarded entry, from the repository root — `ingress/server.mjs` installs the
# guard around `http.createServer` and then loads `.next/standalone/server.js`,
# which chdirs into its own directory itself. Starting the generated entry directly
# is no longer a supported topology and exits 1 in production.
exec node ingress/server.mjs
