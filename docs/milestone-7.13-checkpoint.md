# Milestone 7.13 checkpoint — split view and navigation

Status: **complete**. Date: 2026-08-04.

## Design decision: no second persistence model

The phase brief warns against overlapping tab/session persistence. The decision
taken here is that **there is no separate pane store at all**.

A tab's pane is recorded on the tab's own state (`WorkspaceSessionTabState.paneId`),
and the *active pane* is derived from the active tab rather than stored. Two
stores that each believed they knew which document was open would eventually
disagree, and the disagreement would surface as a pane rendering a document the
session says is closed.

Consequences, all deliberate:

- **No migration.** `paneId` rides inside the existing bounded
  `workspace_sessions.tabs` JSON payload. Migration count stays at **17**.
- **A session written before split view restores as single-pane**, because an
  absent `paneId` reads as the primary pane.
- **The layout is derived, never stored.** `layoutOf` reports "split" only when a
  tab actually occupies the right pane, so a stale flag cannot render an empty
  half nobody asked for.
- **Closing a pane moves its tabs to the survivor**, it does not close them. A
  pane arranges documents; collapsing the arrangement must not discard them,
  least of all one holding unsaved changes the user could not recover.

## What is ephemeral, and why

Two things are deliberately **not** persisted:

- **Synchronization mode.** It is a way of *looking at* two documents, not a fact
  about them. Persisting it would restore a user into a linked scroll they set up
  once for a comparison they finished days ago.
- **Navigation history.** It describes a browsing session, and an unbounded one
  is a memory leak that grows for as long as a tab stays open. It is bounded to
  50 entries per pane and dropped on restore.

## Domain

`src/domain/entities/SplitView.ts` (+ `SplitView.test.ts`, **31 tests**).

- `PANE_IDS` is a closed two-value enumeration. Panes are *positions*, not
  identities, so there is nothing to allocate, leak or garbage-collect, and a
  `paneId` from a newer build degrades to the primary pane rather than naming a
  pane this build cannot render.
- `NavigationHistory` is a cursor into one bounded list rather than two stacks.
  Modelling back/forward as separate stacks makes the "navigating after going
  back truncates the forward path" rule easy to get wrong; with a cursor it is
  one slice.
- `pushHistory` refuses to record navigating to where you already are — otherwise
  pressing back appears to do nothing, because it steps between two identical
  positions.
- `shouldPropagate` is the feedback-loop guard: only `source === "user"`
  propagates. A pane that moved *because it was being synchronized* does not
  answer back, so two synchronized panes cannot drive each other indefinitely.
- `synchronizedState` returns only the fields the mode covers, so a page-only
  sync does not quietly drag the zoom level along with it.

## Service

`src/application/services/SplitViewService.ts` (+ **35 tests**).

Layered over `TabService`; every durable write goes through it, so pane
assignment inherits its authorization, bounds, optimistic concurrency and payload
limits, and there is exactly one place a session is persisted. The tests use the
**real** `TabService` against the in-memory session repository rather than a
double, so the layering is exercised rather than imitated.

Behaviours pinned:

- Assignment persists across a reload (verified by a fresh read from storage).
- Another user's session reads as **missing**, not forbidden.
- Focus routes commands: `activePane` follows the active tab, so a keyboard user
  who moved right does not have their next action applied to the left.
- Pane close moves tabs, keeps something active, and preserves `dirty`/`conflict`.
- Sync off / page / zoom / all each mirror exactly what they claim and nothing
  more; a change tagged `sync` does not propagate; a history step is not mirrored
  as though the user had scrolled.
- Restore re-authorizes every document through `TabService.restoreSession`, so a
  revoked grant drops the tab — a pane must not become a way to keep reading a
  document access was lost to. A restore that drops every right-pane tab
  collapses to single-pane on its own, because the layout is derived.

## Adapter change

`PrismaWorkspaceSessionRepository.parseTab` reconstructs tab state field by
field, so `paneId` would have been silently dropped on read. It now parses it,
degrading an unrecognized value to absent. `TabService.normalizeTabState`
validates it on write.

## UI

- `components/workspaces/splitViewLogic.ts` (+ **26 tests**)
- `components/workspaces/SplitWorkspaceView.tsx`

Notable behaviours:

- **Narrow screens collapse the rendering, never the arrangement.** Below 768px
  only the active pane is shown while the assignment is left untouched — rotating
  a phone must not silently rearrange a workspace, and widening restores it
  exactly. A visible note says so.
- **Alt+Left / Alt+Right** switch panes, chosen because the browser and the
  editor already claim most Ctrl/Cmd combinations; a shortcut that fights the
  platform is one nobody can rely on. The shortcut is ignored when a platform
  modifier is held, and is a no-op when the target pane is empty rather than
  throwing at a keyboard user.
- Each pane is a labelled `section` with its own `role="tablist"` and its own
  back/forward controls, so a screen-reader user can tell the two apart and
  navigate each independently. Disabled history buttons carry an explanatory
  label ("No previous location") rather than just being dimmed.
- Tab labels carry unsaved and conflict state into the accessible name.
- A "Move to other pane" button provides pane reassignment without a pointer
  drag.
- No `alert()`; errors render in place with `role="alert"` plus a polite live
  region.

## DI

Token `SplitViewService` added and registered over the same `TabService`
instance. `container.test.ts`: 62 → **66 tests**, including one that writes a
real pane assignment through the resolved service and reads it back through the
tab service — a second, parallel persistence path would show up there as a
session that never changed.

## Gate results

M7.13 focused gate — **198 passed across 5 files**:

| File | Tests |
| --- | --- |
| `SplitView.test.ts` | 31 |
| `SplitViewService.test.ts` | 35 |
| `splitViewLogic.test.ts` | 26 |
| `TabService.test.ts` (M7.12 regression) | 40 |
| `container.test.ts` | 66 |

Repository-wide:

- `npm run typecheck` — **exit 0**
- `npm run lint` — **exit 0, 0 errors, 0 warnings**
- `npm run test` — **140 files, 2602 tests, exit 0**
- Migration count unchanged at **17**; no schema change was required.

## Known limitations

- `SplitWorkspaceView` accepts a `renderPane` callback and falls back to showing
  the document title. The PDF viewer surface itself is the editor's, and wiring
  the two together is workbench integration rather than split-view work.
- Pane reassignment is offered as a button rather than pointer drag-and-drop.
  Keyboard and pointer users get the same affordance; drag is an enhancement, not
  a prerequisite.
- Synchronized scrolling mirrors viewport offsets directly, which assumes
  comparable zoom. Documents at very different page sizes will track
  approximately rather than exactly.
