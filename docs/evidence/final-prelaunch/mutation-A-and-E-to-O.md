# Mutations A and E–O — the audit's own regressions, checked for vacuity

B, C and D are in their own files (`mutation-B-legacy-save.md`,
`mutation-C-deployment.md`, `mutation-D-config-truth.md`); each mutates the
product code one of this audit's four fixes changed. The rows here do the other
half of the job: they break a guarantee `finalPrelaunchRegression.test.ts`
(R1–R30) claims to hold, and check that the claim actually goes red. A green row
would mean the test asserts something other than what its name says — this
repository's recorded failure mode, and the reason the file exists at all.

Every row: applied to the named source file, gate run, reverted with
`git checkout -- <file>`, tree confirmed clean by `git status --porcelain` before
the next row. Machine-readable record: `mutation-results.json`.

| # | Mutation | Applied to | Gate | Observed |
|---|---|---|---|---|
| A1 | Write a scrypt hash back into the shipped admin store | `data/admin/store.json` | `shippedStoreSecrets.test.ts` | **RED** — 2 failed / 0 passed. *no JSON file under data/admin holds a scrypt password hash* |
| A2 | Put a scrypt hash in the untracked `store.json.bak` sibling | `data/admin/store.json.bak` (created) | `shippedStoreSecrets.test.ts` | **RED** — 1 failed / 1 passed. *no JSON file under data/admin holds a scrypt password hash*. Reverted by deleting the file (it is gitignored, so `git checkout` would not remove it). |
| E1 | The pilot gate stops gating: every slug is piloted | `lib/server/processingPilot.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 3 failed / 28 passed. *R1 defaults every tool to the legacy path — no flag, no pipeline* |
| E2 | Delete the slug gate, so the env override moves every tool | `lib/server/processingPilot.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R2 an operator turning the pilot ON moves exactly one tool* |
| F1 | The reported output MIME stops overriding the capability | `components/tools/resultWorkflow.ts` | `finalPrelaunchRegression.test.ts resultWorkflowWiring.test.ts` | **RED** — 5 failed / 59 passed. *C2 shows no selector for a result that would have no Save button at all* |
| F2 | Save is offered before a destination is settled | `components/tools/resultWorkflow.ts` | `finalPrelaunchRegression.test.ts resultWorkflowWiring.test.ts` | **RED** — 6 failed / 58 passed. *C2 holds Save inert while the choice is open, and releases it once made* |
| G1 | Drop the header-injection replace from the download name | `src/application/services/documentContent.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 2 failed / 29 passed. *R30 the whole name path composes: upload name in, safe header out* |
| G2 | Append .pdf unconditionally | `src/application/services/documentContent.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R10 a download is named once, with one extension* |
| H1 | Stop sanitizing the staged base name | `lib/server/toolJobSubmit.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 2 failed / 29 passed. *R30 the whole name path composes: upload name in, safe header out* |
| H2 | Accept any extension at the intake | `lib/server/validateUpload.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 2 failed / 29 passed. *R20 the intake's four ceilings are enforced where the file arrives* |
| H3 | Remove the storage root containment guard | `src/infrastructure/storage/LocalFileStorage.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R12 a key that escapes the storage root is refused, at the store* |
| I1 | Serve a version whose manifest could not be read | `src/application/services/documentContent.ts` | `finalPrelaunchRegression.test.ts documentContent.test.ts` | **RED** — 2 failed / 54 passed. *R15 a manifest that could not be read reliably serves nothing* |
| I2 | A pending ingestion stops being waitable | `src/application/services/documentContent.ts` | `finalPrelaunchRegression.test.ts documentContentPreparation.test.ts` | **RED** — 2 failed / 39 passed. *R18 a save that has not been ingested yet is waitable, and says so* |
| I3 | Serve a zero-byte source artifact | `src/application/services/documentContent.ts` | `finalPrelaunchRegression.test.ts documentContent.test.ts` | **RED** — 2 failed / 54 passed. *R16 a version with no usable source artifact serves nothing* |
| J1 | Stop sniffing the leading bytes before a binary runs | `lib/server/validateUpload.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R19 a claimed extension is checked against the actual leading bytes* |
| K1 | Drop the upload size ceiling | `lib/server/validateUpload.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R20 the intake's four ceilings are enforced where the file arrives* |
| K2 | Accept an empty upload | `lib/server/validateUpload.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R20 the intake's four ceilings are enforced where the file arrives* |
| L1 | Remove the concurrency ceiling | `lib/server/concurrency.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R21 the concurrency ceiling holds, and a release admits the waiter* |
| L2 | Put the tuning knob in the saturation message | `lib/server/concurrency.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R21 the concurrency ceiling holds, and a release admits the waiter* |
| M1 | Let script read the session cookie | `src/application/services/authHttp.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R22 the session cookie is unreadable to script and cleared the same way it was set* |
| M2 | Clear the cookie with attributes that do not mirror the set | `src/application/services/authHttp.ts` | `finalPrelaunchRegression.test.ts` | **RED** — 1 failed / 30 passed. *R22 the session cookie is unreadable to script and cleared the same way it was set* |
| N1 | Return the internal failure text to the client | `src/application/services/workspaceHttp.ts` | `finalPrelaunchRegression.test.ts workspaceHttp.test.ts` | **RED** — 1 failed / 43 passed. *R23 an unexpected failure reaches the client as a generic 500* |
| O1 | Drop the event property allowlist | `src/domain/metering/events.ts` | `finalPrelaunchRegression.test.ts events.test.ts` | **RED** — 1 failed / 49 passed. *R24 a failure event carries its category and nothing about the document* |
| O2 | Print a price for a plan that cannot be bought | `data/pricing.ts` | `finalPrelaunchRegression.test.ts pricing.test.ts` | **RED** — 2 failed / 41 passed. *R25 a plan that cannot be bought shows no price and no checkout* |
| O3 | Claim a Workspace can hold a non-PDF output | `lib/tools/capability.ts` | `finalPrelaunchRegression.test.ts capability.test.ts` | **RED** — 7 failed / 63 passed. *R26 the capability record cannot invent a tool, and answers only for real ones* |

## The one row that came back green

**O1** — deleting `if (!allowed.has(key)) continue;` from
`sanitizeEventProperties` — left **50 passed / 0 failed** across R24 and the
pre-existing `src/domain/metering/events.test.ts` together. Three filters guard
that function (the closed-taxonomy allowlist, the privacy denylist, and a
primitives-only check) and every property either test fed it was caught by one of
the other two. The allowlist — what stops an undeclared dimension from reaching an
analytics vendor — was pinned by nothing.

R24 now sends `pageCount`, `orgSeats` and `stackFrame`: undeclared for
`job_failed`, no denylisted substring, primitive values, so only the taxonomy can
drop them. O1 is red at R24 alone; `events.test.ts` still passes with the
allowlist deleted, which is worth knowing about that file.

That is the mutation program earning its place: 23 rows confirmed tests that were
already honest, and the 24th found one that was not.

## What no mutation here could reach

- **The Gate A findings.** Three probe rows and one host row in the Phase 5 run are
  not product behaviour, so no source mutation moves them: the `window.fetch`
  retype hook cannot observe `ServerToolRunner`'s `EventSource` frame (PROBE
  DEFECT), and `soffice`/`qpdf`/`pdftoppm`/`pdfinfo` are absent from this host
  (ENVIRONMENTAL). Recorded in the reconciliation table, not here.
- **A2's revert.** `data/admin/store.json.bak` is gitignored, so the tree was
  already clean while the mutation was live — `git status --porcelain` cannot be
  the check for that row, and `rm` is the revert. That the *test* still catches it
  is the point: it globs filenames under `data/admin`, not tracked paths.
- **Anything upstream of a call.** These rows mutate the function under test. A
  fix that is only wired correctly — the route calling the right service, the
  worker reading the right flag — is proved by the probe runs at HEAD, not by a
  mutation of the callee.
- **The visual layer.** Spacing, colour and hierarchy regressions belong to Entry
  Gate B's mutation, which is measured against screenshots rather than a gate
  exit code.
