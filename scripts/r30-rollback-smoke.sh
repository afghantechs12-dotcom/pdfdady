#!/bin/sh
# R30 — deploy and rollback rehearsal on the path this host can actually run.
#
# The container path is ENVIRONMENTAL here (no Docker daemon), so this exercises the
# standalone artifact the image would carry: build it, boot it, put a real job
# through it, then put the PREVIOUS artifact back and prove that one still serves.
# Swapping the artifact directory is the standalone analogue of rolling an image
# digest back — the same "the bytes that served yesterday serve again" claim, minus
# the daemon. The database leg is NOT repeated here: the online backup and its
# byte-exact restore are already proven in migration-restore-drill.log (R22).
#
# Leaves the tree serving the artifact built at HEAD, so a later gate cannot
# accidentally measure the rolled-back one.
set -eu
cd "$(dirname "$0")/.."
API=${R30_API:-http://127.0.0.1:3002}
ORIGIN=${R30_ORIGIN:-https://172.20.10.2:3001}
WORK=${R30_WORK:-/tmp/r30}
FIXTURE=${R30_FIXTURE:-/tmp/perf-fixtures/manypage-fixture.pdf}
FAILED=0

gate() {
  if [ "$2" = ok ]; then printf 'PASS  %-56s — %s\n' "$1" "$3"
  else printf 'FAIL  %-56s — %s\n' "$1" "$3"; FAILED=$((FAILED + 1)); fi
}

stop_origin() {
  pid=$(lsof -nP -iTCP:3002 -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  n=0
  while [ -n "$(lsof -nP -iTCP:3002 -sTCP:LISTEN -t 2>/dev/null || true)" ] && [ "$n" -lt 40 ]; do
    n=$((n + 1)); sleep 0.25
  done
}

boot_origin() {
  nohup sh scripts/restart-origin.sh >>"$WORK/origin.log" 2>&1 &
  n=0
  while [ "$n" -lt 120 ]; do
    code=$(curl -sS -o /dev/null -m 2 -w '%{http_code}' "$API/api/health" 2>/dev/null || echo 000)
    [ "$code" = 200 ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# One real job, end to end: submit, poll, download the bytes back.
job_smoke() {
  id=$(curl -sS -m 30 -H "Origin: $ORIGIN" -F "file=@$FIXTURE;type=application/pdf" \
        "$API/api/jobs?slug=compress-pdf" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobId",""))' 2>/dev/null || true)
  [ -n "$id" ] || { echo "no job id"; return 1; }
  n=0
  while [ "$n" -lt 120 ]; do
    st=$(curl -sS -m 10 "$API/api/jobs/$id" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
    case "$st" in
      completed) break ;;
      failed|cancelled|expired) echo "job $st"; return 1 ;;
    esac
    n=$((n + 1)); sleep 1
  done
  head=$(curl -sS -m 30 "$API/api/jobs/$id/download" | head -c 5)
  [ "$head" = "%PDF-" ] || { echo "download was not a PDF"; return 1; }
  echo "$id"
}

mkdir -p "$WORK"
: >"$WORK/origin.log"
HEAD_SHA=$(git rev-parse --short HEAD)
printf 'R30 — DEPLOY AND ROLLBACK REHEARSAL (standalone path)\n'
printf 'HEAD %s · %s\n\n' "$HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 0. Keep the artifact that is serving now: this is the "previous release". ──
[ -d .next/standalone ] || { echo "no .next/standalone to keep aside"; exit 2; }
rm -rf "$WORK/prev-standalone" "$WORK/prev-static"
cp -R .next/standalone "$WORK/prev-standalone"
cp -R .next/static "$WORK/prev-static"
prev_id=$(cat "$WORK/prev-standalone/.next/BUILD_ID" 2>/dev/null || echo unknown)
gate "the artifact now serving is kept aside as the rollback target" ok "BUILD_ID $prev_id"

# ── 1. Deploy leg: build at HEAD, boot it, put a real job through it. ──
if npm run build >"$WORK/build.log" 2>&1; then
  new_id=$(cat .next/BUILD_ID 2>/dev/null || echo unknown)
  rm -rf "$WORK/head-standalone" "$WORK/head-static"
  cp -R .next/standalone "$WORK/head-standalone"
  cp -R .next/static "$WORK/head-static"
  gate "npm run build produces an artifact at HEAD" ok "BUILD_ID $new_id, $(wc -l <"$WORK/build.log") lines of output"
else
  gate "npm run build produces an artifact at HEAD" no "see $WORK/build.log"; exit 1
fi
stop_origin
if boot_origin; then
  gate "the artifact built at HEAD boots and answers liveness" ok "$API/api/health → 200"
else
  gate "the artifact built at HEAD boots and answers liveness" no "no 200 within 60s"; exit 1
fi
ready=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$API/api/health/ready" || echo 000)
ready_body=$(curl -sS -m 10 "$API/api/health/ready" || echo '{}')
case "$ready" in
  200) gate "readiness answers on the new artifact" ok "200 ready" ;;
  503) gate "readiness answers on the new artifact" ok "503 degraded, and says which: $(printf '%s' "$ready_body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(k for k in ("dataDir","toolchain","database") if not d.get(k)) + " false")' 2>/dev/null || echo "unparsed body")" ;;
  *)   gate "readiness answers on the new artifact" no "unexpected $ready" ;;
esac
if job=$(job_smoke); then
  gate "a real job completes on the new artifact and returns a PDF" ok "job $job, %PDF- downloaded"
else
  gate "a real job completes on the new artifact and returns a PDF" no "$job"
fi

# ── 2. Rollback leg: put the previous artifact back and prove it still serves. ──
stop_origin
rm -rf .next/standalone .next/static
cp -R "$WORK/prev-standalone" .next/standalone
cp -R "$WORK/prev-static" .next/static
if boot_origin; then
  gate "the PREVIOUS artifact boots again after a rollback" ok "BUILD_ID $prev_id, /api/health → 200"
else
  gate "the PREVIOUS artifact boots again after a rollback" no "no 200 within 60s"
fi
if job=$(job_smoke); then
  gate "a real job completes on the rolled-back artifact" ok "job $job, %PDF- downloaded"
else
  gate "a real job completes on the rolled-back artifact" no "$job"
fi

# ── 3. Roll forward again, so the tree is left serving HEAD. ──
stop_origin
rm -rf .next/standalone .next/static
cp -R "$WORK/head-standalone" .next/standalone
cp -R "$WORK/head-static" .next/static
if boot_origin; then
  gate "rolling forward again leaves HEAD serving" ok "BUILD_ID $(cat .next/standalone/.next/BUILD_ID 2>/dev/null || cat .next/BUILD_ID), /api/health → 200"
else
  gate "rolling forward again leaves HEAD serving" no "the HEAD artifact did not come back up"
fi

printf '\n────────────────────────────────────────────────────────────\n'
if [ "$FAILED" -eq 0 ]; then printf 'R30 REHEARSAL — PASS (container path NOT EXERCISED: no Docker daemon)\n'
else printf 'R30 REHEARSAL — %d FAILED\n' "$FAILED"; exit 1; fi
