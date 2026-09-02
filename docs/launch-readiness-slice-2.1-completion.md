# Launch Readiness Slice 2.1 — Recovery Fencing + Clean Gate

**Date:** 2026-08-26
**Scope:** Close the stale-worker write race left open by Slice 2. Slice 2 itself
(stuck-job recovery, graceful shutdown) was not touched.

> **Brief note.** The task brief for this slice was truncated mid-code-block,
> immediately after "### 1. Fix stale-worker writes". Anything after that section
> — including whatever "Clean Gate" was meant to enumerate — was not received.
> This report delivers section 1 in full plus a clean verification gate in the
> shape this repo already uses (typecheck / lint / test / build, plus both
> runtime probes). If the missing sections asked for more, say so and it is a
> separate, small follow-up.

---

## 1. The hole

```
worker A runs attempt 1
→ job becomes stale
→ recovery moves running → queued and charges attempt 1
→ worker B later owns attempt 2
→ worker A wakes up and calls failJob
→ queued → failed is legal, so the write lands
```

Three distinct damages, in increasing order of cost:

1. **A wrong terminal status.** The job reads `failed` while worker B is running
   it to completion. Worker B's own `completeJob` is then refused, so the user is
   told processing failed for a document that was successfully compressed.
2. **A double-charged attempt.** The sweep already recorded attempt 1. The zombie
   recording it again spends a budget that has only had one real attempt, which
   can retire a job before its retries are used.
3. **A refund of live work.** The zombie's `failJob` refusal made its automatic
   `retryJob` fail, which the handler correctly reads as *permanently failed* and
   settles — refunding the allowance for a job another worker is at that moment
   finishing. This one is money, and it is the reason fencing alone was not
   enough (see §3).

There is also a quieter fourth: `updatedAt` **is** the lease read by
`listStaleRunning`. An unfenced progress write from a superseded worker refreshes
the lease of a row it no longer owns, which hides a genuinely stuck job from the
sweep for as long as the zombie keeps writing.

The lifecycle cannot fix any of this. `running → failed` and `queued → failed`
are both legal, deliberately — that is how a worker reports a real failure. The
state machine knows which *moves* are allowed; it has no way to know *who* is
asking.

---

## 2. The fence: `attempts`

`attempts` counts **finished** attempts, so a row under a live attempt N reads
`N - 1`, and recovery always charges the abandoned attempt and bumps it. That
makes it monotonic per job and unique per live attempt — a real fencing token
that already exists.

- **No new column.** A second per-attempt number could disagree with the row it
  describes.
- **Not a random lease id.** `attempts` is the value recovery *has* to write
  anyway, so the fence cannot drift out of sync with the act of recovering.

`JobWriteOptions.expectAttempts` on the port becomes one extra term in the *same*
conditional `updateMany` the status CAS already uses:

```ts
where: {
  id,
  status: current.status,
  ...(opts.expectAttempts !== undefined ? { attempts: opts.expectAttempts } : {}),
}
```

Because it is in the WHERE clause rather than compared against the row that was
read, recovery cannot slip into the read→write window. `update` gained the same
treatment, which is what stops a fenced-out progress write from touching
`updatedAt`.

The fence is **derived, not requested**: `ProcessingJobService.completeJob`,
`failJob`, `markCancelled` and `recordStage` already take the attempt they are
reporting on, so they pass `{ expectAttempts: attempt - 1 }` themselves. A fence
a call site can forget is not a fence.

---

## 3. Superseded vs. beaten — why fencing alone was not enough

A refused write means one of two things, and they owe opposite duties:

| Refusal | Who owns the job | What this worker owes |
| --- | --- | --- |
| **Beaten to a terminal state** under my own attempt (the user cancelled while I was finishing) | still me | the settlement that refunds the user |
| **Superseded** — recovery handed the job to another worker | someone else | nothing, and it must write nothing |

Fencing without this distinction would have *introduced* the refund bug in §1.3
on a new path. `ProcessingJobService.ownsAttempt` answers it from the row:

```ts
if (job.attempts === attempt - 1) return true;              // my attempt is live
return job.attempts === attempt && isTerminal(job.status);  // my attempt went terminal
```

The `isTerminal` half matters: after recovery *requeues* a job the row also reads
`attempts === attempt`, but a later attempt is live, so claiming ownership there
would be exactly wrong.

`ProcessingJobHandler` short-circuits on superseded in both outcome paths — the
completion-refused branch and `recordFailure` — before any usage event, any
settlement, and any retry. Each logs one sanitized line, `"Superseded attempt
wrote nothing"`.

---

## 4. Deliberately not changed

- **`ALLOWED_TRANSITIONS`.** Removing `queued → failed` would not fix the more
  dangerous `running → failed` overwrite of a live worker's attempt, and would
  break legitimate failures.
- **`StuckJobRecoveryService`'s own transitions.** Competing sweeps already
  serialise on the status CAS on `running`; no hole was demonstrated, so no fence
  was added.
- **User-initiated writes** (cancel request, retry). They are not about one
  attempt, so they stay unfenced.

---

## 5. Verification gates

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass — 1 error, 10 warnings, **all pre-existing**, none in a file this slice touched (the error is `next.config.mjs:34 'process' is not defined`) |
| Tests | `npm run test` | **Pass — 312 files, 6374 tests, 0 failed** (was 6367; +7) |
| Build | `npm run build` | Pass |
| Worker recovery probe | `npx tsx scripts/worker-recovery-probe.mts` | **45 / 45** (was 34; +11 — new section 8) |
| Processing pilot probe | `node scripts/processing-pilot-probe.mjs` | **41 / 41** |

### New tests (+7)

| Where | Tests | What it pins |
| --- | --- | --- |
| `ProcessingJobService.test.ts` | 5 | The real sweep drives the requeue; the stale attempt's `completeJob`, `failJob`, `markCancelled` and `recordStage` are all refused, `updatedAt` does not move, and `ownsAttempt` separates superseded from beaten |
| `ProcessingJobHandler.test.ts` | 2 | A superseded attempt publishes nothing, records no usage event and triggers no settlement — on the success path and the throw path |
| `scripts/worker-recovery-probe.mts` §8 | 11 checks | The same race against **real Prisma**: the `updateMany` WHERE clause and the untouched `@updatedAt` |

Every refusal is paired with the successor's identical call **succeeding**. A
fence that refuses everyone would pass the refusals and fail the pairings.

### Mutation evidence

| Mutation | Result |
| --- | --- |
| `expectAttempts` guard removed from `InMemoryJobRepository` | 4 of the 5 service tests red |
| `ownsAttempt` always returns true | both handler tests red |
| `expectAttempts` dropped from the Prisma `updateMany` WHERE clause | 6 probe checks red — including `status=failed attempts=1 cat=processor_failed` on a job another worker owned, which is the reported bug reproduced verbatim |

The fifth service test (`ownsAttempt`) survives mutation 1 by design: it tests
the service's derivation, and mutation 2 is its target.

---

## 6. Two findings worth recording

- **The in-memory repository cannot validate this feature.** It has no
  `@updatedAt` and no WHERE clause. Probe section 8 is not belt-and-braces; it is
  the only place the central claim is testable. This is the same lesson as the
  probe's own header comment, now with a second instance.
- **`scripts/processing-pilot-probe.mjs`'s documented run recipe is stale.** Its
  header says to run `npx next start -p 3001` with
  `NEXT_PUBLIC_SITE_URL=http://localhost:3001`, and that combination is now
  refused at startup by the Slice 1 production gate (loopback site URL), and
  `next start` additionally warns it does not work with `output: standalone`. It
  was run for this gate against `npm run dev` with the matching
  `NEXT_PUBLIC_SITE_URL` — 41/41. Pointing it at the default `:3000` site URL
  while serving `:3001` fails exactly one check ("the result route served the
  output"), which is the failure mode that header comment warns about. Updating
  that comment is a one-line follow-up, not part of this slice.

---

## 7. Next

CSP, which is where the brief was heading. Nothing in this slice is left open.
