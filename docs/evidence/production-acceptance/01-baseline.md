# PDFDadi — production acceptance baseline

Captured: 2026-09-05T12:33:59Z (UTC)

## Git
```
branch:            production-acceptance
HEAD:              3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b
HEAD short:        3e4ac8b
started from:      ingress-memory-safety-closeout @ 3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b
merge-base main:   5a4adca7c8550a23d2fbc39f521a33a3f0adf523
commits ahead main:125
commits after 478e111: 10
remotes:           0 configured
tags:              0
```

### git status --porcelain (empty = clean)
```
?? docs/evidence/production-acceptance/
```

### git worktree list
```
/Users/faisalarifi/Downloads/pdfmaster  3e4ac8b [production-acceptance]
/private/tmp/audit-wt-final             2840bea (detached HEAD) prunable
/private/tmp/audit-wt-final2            eb8f7fa (detached HEAD) prunable
```

### git log --oneline -12
```
3e4ac8b A commit count inside one of the commits it counts
1edea88 The harness's own A1 row, satisfied a second time: 67/67 on the tree this report describes
1df8ef6 Two numbers that had to be measured rather than argued: 15.75 MiB of 2800, and serving=1
30a15b5 Three suites that pinned a boot without a lease, and a migration called "the last one"
3b113c7 A GET may carry a body, and only the seam can be asked about that
ce026f6 The gates, held against a broken boundary one property at a time
0c7654b Two instruments that were wrong before the product was
84e7014 A guard nothing starts is a note in a runbook
792abff `DEPLOYMENT_TOPOLOGY=single-instance` proved only that an operator had typed it
1432f91 The 120 MB a page URL would retain for an anonymous stranger
478e111 The three gates that had no artifact: baseline, documentation-only tip, secret scan
46c0053 The harness's own A1 check, satisfied: exit 0 on a clean tree
```

### git branch -vv
```
  final-prelaunch-audit          1640b12 §31/§32: state both the artifact commit's figures and the branch tip's
  final-readiness-reconciliation 478e111 The three gates that had no artifact: baseline, documentation-only tip, secret scan
  ingress-memory-safety-closeout 3e4ac8b A commit count inside one of the commits it counts
  main                           5a4adca Phase 5 closeout: save intention is the Workspace save identity
  phase-6-premium-ui             651c8fa Phase 6 §22: the design-system reference, and the phase's ledger entry
* production-acceptance          3e4ac8b A commit count inside one of the commits it counts
  upload-abuse-closeout          f324053 P2-7 was the wrong severity: the correction, not a replacement
```

## Toolchain
```
node:   v26.7.0
npm:    11.19.0
next:   16.3.4
prisma: ^6.19.3
@prisma/client: ^6.19.3
installed next:   16.3.4
installed prisma: 6.19.3
platform: Darwin 25.6.0 arm64
cpus/mem: 16 cpus, 137.4 GB
```

## Pre-existing build artifact on disk
```
BUILD_ID: 98appVCcbyMxzlhk26zya
accepted cold artifact per closeout: 98appVCcbyMxzlhk26zya
```

## Container runtime detection
```
docker         ABSENT
podman         ABSENT
nerdctl        ABSENT
finch          ABSENT
colima         ABSENT
lima           ABSENT
buildah        ABSENT
kubectl        ABSENT
trivy          ABSENT
grype          ABSENT
syft           ABSENT
docker-scout   ABSENT
```

## Processing binaries on this host
```
soffice      ABSENT
libreoffice  ABSENT
gs           /opt/homebrew/bin/gs
qpdf         /opt/homebrew/bin/qpdf
pdftoppm     /opt/homebrew/bin/pdftoppm
pdfinfo      /opt/homebrew/bin/pdfinfo
tesseract    /opt/homebrew/bin/tesseract
ocrmypdf     /opt/homebrew/bin/ocrmypdf
python3      /opt/homebrew/bin/python3
```
