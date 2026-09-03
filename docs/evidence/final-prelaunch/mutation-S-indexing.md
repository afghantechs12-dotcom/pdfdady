# Mutation S — crawler-facing truth (R24, R25)

Gate: `npx vitest run app/seoIndexingTruth.test.ts` (5 tests green at `450657d`).

Like B, C, D and P, these rows mutate code an audit fix introduced or an assertion
this audit wrote, so they live beside those rather than in the A/E–O table.

The finding first. `app/workspaces/[workspaceId]/page.tsx` — the Workspace file
manager, the page a signed-in user spends their time on — exported **no `metadata`
at all**, while its three siblings (`/workspaces`,
`/workspaces/[id]/settings`, `/workspaces/[id]/documents/[id]`) each declared
`robots: { index: false, follow: false }`. There is no `app/workspaces/layout.tsx`
to supply one by inheritance (`ls app/workspaces/` → `[workspaceId]`, `error.tsx`,
`not-found.tsx`, `page.tsx`), so it inherited the root layout's indexable
defaults. Fixed in `450657d`.

`/workspaces` is **not** in `app/robots.ts`'s disallow list, and that is correct
rather than a second finding: a path blocked in robots.txt is never fetched, so its
`noindex` is never read — blocking it is how a URL ends up indexed without its own
page ever being seen. noindex is the mechanism, and now every private route has it.

## Why the test does not contain a list of private routes

A hardcoded list is precisely what gets forgotten: it would have stayed green while
the Workspace page was indexable, because the page nobody remembered to add to the
list is the page nobody remembered to noindex. So the rule is derived from the
product's own two surfaces — walk every `app/**/page.tsx`, call `sitemap()`, and
require each route that surface does not advertise to declare or inherit noindex.

One exemption exists and it is proved by calling, not by reading source:
`app/signup/page.tsx` has no metadata because it never renders — it
`permanentRedirect`s to `/register`. The test invokes the page component and accepts
it only if the throw carries a `NEXT_REDIRECT` digest. Had that branch silently
failed, `/signup` would have been reported as an offender and the suite would be
red; its passing is the evidence the branch ran.

## S1 — the noindex comes off the Workspace file manager

The mutation keeps the `metadata` export and removes only the `robots` key, so a
test that merely checked "has metadata" would stay green:

```ts
export const metadata = { title: brandTitle("Workspace") };
```

Observed: **Tests 1 failed | 4 passed (5)**

- × R24 — no private route is indexable > advertises a route in the sitemap or marks it noindex, with nothing in between

## S2 — the sitemap's availability gate weakened to an existence check

`app/sitemap.ts`, one character short of trusting the registry:

```ts
      if (!capability) return [];   // was: if (!capability?.available)
```

Observed: **Tests 2 failed | 3 passed (5)**

- × R25 … > lists only tools this build can actually run, at the capability's own route
- × R25 … > drops an unavailable slug even when the tool registry offers one

This row changed a claim in the source. `app/sitemap.ts`'s comment reads as though
the availability gate were belt-and-braces behind `getToolsList` — it is not.
`getToolsList()` returns **45** tools; **13** of them (`pdf-to-powerpoint`,
`pdf-to-excel`, `pdf-forms`, `redact-pdf`, `compare-pdf` and the eight
`coming-soon-ai` slugs) have capability rows whose `available` is false. Weakening
the gate to an existence check submits all 13 to crawlers, pointing them at thin
placeholder stubs. The gate is load-bearing, not defensive.

The second failing test is the honest half of the pair: it injects a
`{ slug: "chat-with-pdf", status: "functional-server" }` record into the registry
through `vi.doMock` — a record claiming to work for a slug nothing implements — and
requires the sitemap to drop it anyway. That is the case the source comment
describes, and it cannot arise from the real registry, so it has to be manufactured
to be tested at all.

## S3 — robots.txt forbids what the sitemap submits

```ts
  const disallow = ["/admin", "/api", "/tools", ...seo.robotsDisallow];
```

Observed: **Tests 1 failed | 4 passed (5)**

- × R24 — no private route is indexable > never submits a URL that robots.txt forbids crawling

Worth mutating because the assertion passes on an empty result: `contradictions`
being `[]` is both "coherent" and "the filter never ran". S3 proves it runs — the
33 paths at or under `/tools` that the sitemap submits (the directory page plus
32 tool routes) are found and named.

All three mutations were reverted with `git checkout -- <file>`; the gate is green
at `450657d` and the working tree carries no mutation.

## Collateral: `server-only` made these modules untestable

`lib/seo/adminRuntime.ts` opens with `import "server-only"`, a guard package
supplied by the Next compiler rather than by npm — it is not in `node_modules`, so
under plain vitest **any** module reachable from it failed to load
(`Cannot find package 'server-only'`). `app/sitemap.ts` and `app/robots.ts` both
read it, which is why nothing in this repository had ever called either one; the
existing harness read their source text instead. `test/stubs/server-only.ts` is an
empty module aliased in `vitest.config.ts`. The guard still does its job where it
matters: a real client bundle resolves the real package and fails the build.
