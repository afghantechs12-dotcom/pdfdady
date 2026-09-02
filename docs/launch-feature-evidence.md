# Launch Feature Evidence Matrix

**Date:** 2026-08-05
**Purpose:** every marketing claim PDFDadi makes publicly, traced to the code
that implements it. A claim with no row here may not appear on the site.

**Status vocabulary**

| Status | Meaning |
| --- | --- |
| `verified` | Implemented, reachable by a user, covered by tests. Safe to market. |
| `limited` | Implemented but narrower than the claim implies. Market only with the qualifier stated in the Required wording column. |
| `planned` | Not implemented. Must not be marketed as available. |
| `removed` | Claim currently on the site that is false or unevidenced. Must be deleted or rewritten. |

---

## 1. Claims currently on the site

These are the exact strings a visitor reads today. Each was located in source.

| # | Claim | Where rendered | Backend support | Test evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C1 | "100% Secure" | `data/features.ts` → `WhyChoose` | None. Absolute security claims cannot be substantiated. | — | **removed** |
| C2 | "Files are processed in your browser, never uploaded." | `data/features.ts` → `WhyChoose` | Contradicted by 14 `functional-server` tools (`data/tools.ts`) and by Workspace upload (`api/workspaces/[id]/documents/upload`). | `lib/server/toolProcessing.test.ts` proves server-side processing exists | **removed** |
| C3 | "Auto File Deletion — Nothing is stored." | `data/features.ts` → `WhyChoose` | Contradicted by durable Workspace storage (`.storage/local/`, document versions). | Ingestion tests prove durable versions | **removed** |
| C4 | "Files deleted automatically" | `data/admin/index.ts` `site.trustBullets` → `Hero` | Same contradiction as C3. | — | **removed** |
| C5 | "No sign up required" | `site.trustBullets` → `Hero` | True for the 18 `functional-client` tools. Not true for Workspace. | tool pages render without auth | **limited** — "No sign up needed for browser tools" |
| C6 | "Works on any device" | `site.trustBullets` → `Hero` | Responsive layout; no install step. | responsive QA pending Phase 9 | **verified** |
| C7 | "Super Fast — results in seconds" | `data/features.ts` | Unqualified performance promise dependent on file size and tool. | — | **limited** — rewrite as capability, not a time guarantee |
| C8 | "Works Everywhere — any device, any modern browser. No install." | `data/features.ts` | Web app, no install. | — | **verified** |
| C9 | "Easy to Use" | `data/features.ts` | Subjective, harmless. | — | **verified** |
| C10 | "Private by design — your data stays yours." | `data/trust.ts` | Vague. Acceptable only if the page also states where processing happens. | — | **limited** |
| C11 | AI PDF Tools section (8 tools) | `AIToolsSection` on `/` | **None.** M8 not started. | — | **planned** |
| C12 | "Premium AI" pricing plan | `data/pricing.ts` | No AI, no checkout. | — | **planned** |
| C13 | "Popular PDF Tools" | `PopularTools` on `/` | Ordering is a manually curated slug list (`getPopularToolsSlugs`), **not** usage analytics. | — | **limited** — rename to "Essential PDF tools" |
| C14 | "Server" badge on tool cards | `ToolCard.tsx:15-21` | Internal `functional-server` status leaked to users. | — | **removed** — replace with a processing-mode label |

---

## 2. Real capabilities that are *not* currently marketed

This is the substance of the launch positioning. Every row is implemented and
test-covered, and none of it appears on the public site today.

| # | Capability | Route / component | Backend support | Test evidence | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Persistent Workspace: folders, tags, favorites, recent, archive, trash, projects | `/workspaces/[id]`, `WorkspaceDashboard` | `api/workspaces/[id]/{folders,tags,projects}`, lifecycle routes | `fileManagerLogic.test.ts`, `tagLogic.test.ts`, `dashboardLogic.test.ts` | **verified** |
| R2 | Professional browser editor: text, shapes, annotations, signatures, layers, history | `/editor`, `components/editor/**` | M3.e headless core + `src/application/editor/**` | `CommandHistory.jump.test.ts`, `SetTextStyleCommand.test.ts`, `objects.test.ts`, `toolbarIcons.test.ts` | **verified** |
| R3 | Durable version history with restore | document versions API | `versions/[versionNumber]/restore` | version service tests | **verified** |
| R4 | Autosave + crash recovery | `autosave`, `autosave/recover`, `autosave/mark-saved` | dedicated routes | autosave service tests | **verified** |
| R5 | Multi-document tabs + split view | `session/tabs`, `session/split`, `SplitWorkspaceView` | session routes | `splitViewLogic.test.ts`, `workbenchLogic.test.ts` | **verified** |
| R6 | Operation Center: progress, cancel, retry for long jobs | `OperationCenter`, `operations/[id]/{cancel,retry}` | queue + operations API | operations tests | **verified** |
| R7 | Comments and threads | `CommentsPanel`, `comments/[threadId]/**` | resolve/reopen/messages routes | `commentLogic.test.ts` | **verified** |
| R8 | Document comparison | `comparisons/**` | cancel/retry/result routes | comparison tests | **verified** |
| R9 | Outline / bookmarks | `outline`, `bookmarks` routes | dedicated routes | outline tests | **verified** |
| R10 | Workspace search + smart collections | `SearchPanel`, `SmartCollections` | `search`, `smart-collections/**` | `searchLogic.test.ts`, M7.7 collection grammar tests | **verified** |
| R11 | Imported text is read-only by capability, not duplication | editor core | `sourceText`, `importedTextRendering` | `sourceText.test.ts` (29), `importedTextRendering.test.ts` (12) | **verified** |
| R12 | Command palette | `CommandPalette` | — | `commandLogic.test.ts` | **verified** |
| R13 | 18 browser-processed tools | `/tools/<slug>` dedicated folders | client runners (pdf-lib) | tool runner tests | **verified** |
| R14 | 14 server-processed tools | `/tools/[slug]` + `api/tools/[slug]` | job queue, progress, cancel, download | `toolProcessing.test.ts` | **verified** |
| R15 | Tool → Workspace continuity ("Save to Workspace") | — | Storage + document APIs exist; **the UI affordance does not** | — | **planned for this milestone (Phase 4)** |

---

## 3. Processing-mode model

The brief requires that displayed processing claims derive from configuration,
not copy. The canonical mapping from the existing tool registry:

| `ToolStatus` (internal) | `ProcessingMode` (user-facing) | Label | Meaning shown to user |
| --- | --- | --- | --- |
| `functional-client` | `browser` | Browser | "Processed in your browser for this operation." |
| `functional-server` | `secure-cloud` | Secure cloud | "Uploaded over an encrypted connection, processed, then removed per the retention policy." |
| (Workspace storage) | `workspace` | Workspace | "Saved to your Workspace and kept until you delete or archive it." |
| `planned` | — | Coming later | Not executable. |
| `coming-soon-ai` | — | Coming later | Not executable. |

**Rule:** the label is derived from `tool.status` in code. A test must assert
that no tool renders a processing label inconsistent with its configured status,
so copy edits cannot drift from behavior.

### Claims that require evidence before use

| Proposed wording | Allowed? | Condition |
| --- | --- | --- |
| "encrypted transport" | Yes, in production | HTTPS in production. Do not claim in a local/dev context. |
| "end-to-end encryption" | **No** | Not implemented. |
| "zero knowledge" | **No** | Not implemented. |
| "SOC 2 / ISO / HIPAA / GDPR compliant" | **No** | No certification or approved legal language exists. |
| "documented retention controls" | Only once written | Requires a real, published retention policy on `/privacy-policy`. Until then, state actual behavior plainly. |
| "unlimited" | **No** | No enforcement model exists to make it true. |

---

## 4. Pricing claims

| Claim | Backend | Status |
| --- | --- | --- |
| Free plan, $0 | No enforcement; everything is currently free | **verified** as "free at launch" |
| Pro "Coming soon" | No checkout, no entitlement system | **planned** — no price, no checkout button |
| Premium AI | No AI | **removed** — must not appear as a purchasable tier |
| Business "Coming soon" | No team billing | **planned** — "Contact us" only |
| Monthly/yearly toggle | Only one price exists per plan | **removed** — toggle may not be shown |
| Crossed-out prices / discounts | None exist | **removed** — never render |
| Testimonials / ratings | None exist | **removed** — no `AggregateRating` schema |

---

## 5. Enforcement

1. Marketing copy lives in `data/admin/index.ts` defaults (admin-overridable),
   never hardcoded in components.
2. Processing labels derive from `tool.status`; a unit test asserts the mapping.
3. A test asserts that no removed claim string (C1–C4, C14) reappears anywhere
   under `app/`, `components/` or `data/`.
4. Any new claim requires a row in this table before it ships.

---

## 6. Delivery status (2026-08-06)

Phases 3–10 are complete. Disposition of every claim in §1:

| # | Claim | Disposition |
| --- | --- | --- |
| C1 | "100% Secure" | **Removed.** Guarded by `FORBIDDEN_CLAIMS`. |
| C2 | "processed in your browser, never uploaded" | **Removed.** Replaced by the three-mode `ProcessingExplainer`, whose copy is derived from the tool registry. |
| C3 | "Auto File Deletion — Nothing is stored" | **Removed.** Guarded. |
| C4 | "Files deleted automatically" | **Removed** from both the defaults and `store.json`. Also removed from the upload dropzone's trust text ("Secure processing • Auto deletion"), which rendered on every tool page. |
| C5 | "No sign up required" | **Qualified** to "Browser tools need no account". |
| C6 | "Works on any device" | Retained. |
| C7 | "Super Fast — results in seconds" | **Removed.** The trust strip's "Fast processing / Get results in seconds" went with it. |
| C8/C9 | "Works Everywhere" / "Easy to Use" | Folded into the rewritten sections. |
| C10 | "Private by design — your data stays yours" | **Removed** as unverifiable; replaced with four checkable statements in `data/trust.ts`. |
| C11 | AI PDF Tools section | **Removed.** Reduced to one non-interactive line (`AIRoadmapNote`). |
| C12 | "Premium AI" pricing plan | **Deleted** from `data/pricing.ts`. |
| C13 | "Popular PDF Tools" | **Renamed** to "Essential PDF tools". |
| C14 | "Server" badge | **Replaced** with the derived Browser / Secure cloud badge. |

§2 capabilities now marketed: R1–R5 (`data/productHighlights.ts`), R3/R4/R6/R7/R9
(`data/features.ts`), R13/R14 (the processing explainer). R15 (Save to
Workspace from a tool result) remains **planned** and is not marketed.

Two claims were added and then corrected during this milestone, both caught
before shipping:

1. A trust bullet stated that deleting a document removes its versions. The
   schema uses a soft-delete/trash model (`deletedAt`), so this was rewritten to
   describe trash and restore.
2. The `AuthShell` panel claimed "nothing is ever lost" and team-scale
   organization. Both were removed — the first is an absolute guarantee of the
   same species as C1, the second describes team management that does not exist.
