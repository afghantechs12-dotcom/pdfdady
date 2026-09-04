# Final-HEAD verification — the commands, verbatim

HEAD 21bb4dab2a0d4bfdc373c8f14c65037f38abd1b7 · BUILD_ID _DzYjfCuvno7KJhZM8SWY · 2026-09-04T01:07:03Z
Origin used by every browser probe: https://172.20.10.2:3051 (TLS front) -> 127.0.0.1:3052
NEXT_PUBLIC_SITE_URL is that same origin; a mismatch makes the CSRF/origin gate refuse every mutation.
Node fetch needs NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed front; CDP Chrome needs --ignore-certificate-errors.

```
npm run build                       # BUILD_ID _DzYjfCuvno7KJhZM8SWY
npx tsc --noEmit
npx eslint .
npx prisma validate && npx prisma migrate status
npx vitest run
node .next/standalone/server.js     # PORT=3052 HOSTNAME=127.0.0.1 NODE_ENV=production
node scripts/tls-front.mjs --listen 3051 --target 3052
node scripts/final-prelaunch-audit.mjs --json ...        # static harness, groups A-R
node scripts/workflow-completeness-probe.mjs --url https://172.20.10.2:3051
node scripts/phase1-workspace-reliability-probe.mjs https://172.20.10.2:3051
node scripts/tool-runtime-matrix-probe.mjs --url https://172.20.10.2:3051 --json ...
node scripts/legacy-job-ownership-probe.mjs --url https://172.20.10.2:3051
npm run test:export-fidelity
node scripts/visual-acceptance-probe.mjs --url https://172.20.10.2:3051 --auth
```

No secret, cookie or session token value appears in any file in this directory.
