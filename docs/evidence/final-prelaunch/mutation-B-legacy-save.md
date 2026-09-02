# Mutation B — the legacy `Save to Workspace` branch

Gate: `npx vitest run app/api/jobs/saveToWorkspaceRoute.test.ts` (19 tests green at
`7facfae`).

## B1 — reinstate the blanket refusal of every non-pipeline job row

```ts
if (!isProcessingJob(row)) {
  return NextResponse.json({ error: "Job not found." }, { status: 404 });
}
```
placed at the top of `resolveSavableOutput`, i.e. the pre-fix behaviour.

Observed: **Tests 4 failed | 15 passed (19)**

- × stores a completed legacy job's own output bytes
- × refuses a legacy job that has not finished, and one with no recorded output
- × refuses a legacy result that is not a PDF, and one too large to store
- × answers a retry with the first document, and adds no second event
- ✓ answers a legacy job that is not yours exactly as it answers an unknown one

The one survivor is expected and is not a weak assertion: the pre-fix route
answered 404 to every legacy row, so "not yours" and "unknown" were *still*
indistinguishable. That assertion is deliberately shape-insensitive — it pins the
absence of an existence oracle, not the presence of the branch. B2 exists because
a guard no fixture can reach is worth nothing.

## B2 — drop the legacy ownership gate, keep the rest of the branch

`const denied = await legacyJobAccessDenied(row); if (denied) return denied;`
removed.

Observed: **Tests 1 failed | 18 passed (19)**

- × answers a legacy job that is not yours exactly as it answers an unknown one

So the ownership assertion does reach the gate: without it another user's completed
`pdf-tool` job is saved into the caller's Workspace.

Both mutations reverted with `git checkout --`; tree clean afterwards.
