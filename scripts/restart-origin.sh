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
# Dead state from before ADMIN_STORE_DIR existed: a store the standalone entry used
# to write into its own directory. Removed so nobody debugs a file nothing reads.
rm -rf .next/standalone/data
[ -d public ] && cp -R public .next/standalone/public 2>/dev/null || true
set -a
. ./.env
set +a
export NODE_ENV=production PORT="${PORT:-3002}" HOSTNAME=127.0.0.1
# The production topology, so the audit origin exercises the single-instance lease
# rather than a code path only containers reach.
export DEPLOYMENT_TOPOLOGY="${DEPLOYMENT_TOPOLOGY:-single-instance}"
export DATABASE_URL="${AUDIT_DATABASE_URL:-file:/tmp/audit-final-db.db}"
# Absolute, and outside the repository, for the same reason as the database: the
# production gate refuses a relative object-storage root because `path.resolve()`
# would put stored documents under the working directory. Added in Stage 5 of
# production acceptance, when the Stage 4 gate change made this script's own
# environment incomplete — `deploymentArtifact.test.ts` now feeds it to the gate.
export STORAGE_LOCAL_ROOT="${AUDIT_STORAGE_ROOT:-/tmp/audit-storage}"
# Absolute, and NOT under the repository's `.next`, because the standalone entry
# below chdirs into `.next/standalone`: unset, the admin password hash and all CMS
# content would be written into the build output and destroyed by the next build.
# Added in Stage 7 of production acceptance, when the gate grew the requirement
# this script's own chdir made unavoidable.
export ADMIN_STORE_DIR="${AUDIT_ADMIN_STORE_DIR:-/tmp/audit-admin}"
# Seeded from the repository's shipped store the way the image seeds its volume, so
# the origin renders the content this build ships rather than code defaults. The
# directory must exist before boot for a second reason: `/api/health/ready` checks
# `fs.access(dirname(STORE_PATH))`, so an absent directory reports NOT READY.
mkdir -p "$ADMIN_STORE_DIR"
[ -f "$ADMIN_STORE_DIR/store.json" ] || cp data/admin/store.json "$ADMIN_STORE_DIR/store.json"
export NEXT_PUBLIC_SITE_URL="${AUDIT_SITE_URL:-https://172.20.10.2:3001}"
# The guarded entry, from the repository root — `ingress/server.mjs` installs the
# guard around `http.createServer` and then loads `.next/standalone/server.js`,
# which chdirs into its own directory itself. Starting the generated entry directly
# is no longer a supported topology and exits 1 in production.
exec node ingress/server.mjs
