# Shape / Draw functional repair — confirmed root causes (2026-08-19)

> **STATUS: ALL SIX DEFECTS FIXED AND VERIFIED.** Everything from here to
> "## Draw" is the **OLD MEASURED DEFECT** record, kept verbatim because those
> measurements are the evidence the fixes are judged against. The implemented
> fixes and the final browser verification are in the two sections at the **end
> of this file**. Do not re-investigate the root cause — it is settled.

All six findings below were reproduced in a real headless Chrome against the running
dev server (throwaway diagnostics, written to the OS temp directory and deleted —
never into the repo). None is a speculation; each line references measured browser
output.

## The engine was never broken

Activated by KEYBOARD, both tools already worked end-to-end:

```
after pressing R: ["Rectangle tool active"]
objects: before=0 afterPointerDown=1 midDrag=1 after=1
inspector headings: ["Pages1","Shape","Shape","Shadow","Position & size","Appearance"]

after pressing D: ["Draw tool active"]
draw: before=1 livePreviewPolylines=4 after=2 => created=1
draw selection headings: ["Pages1","Drawing","Position & size","Appearance"]
```

So `addShape`/`addDrawing`, the gesture machine, the renderer, selection, the
Inspector contract and `drawSettings` are all sound. Every defect is in the path
between the **visible toolbar** and that engine — which is exactly the path the
user was clicking and the old tests never took.

---

## DEFECT 1 (the reported bug) — cluster menus are clipped out of the hit test

`EditorToolbar.tsx:308` renders the tool row inside:

```
flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none
```

The cluster menu (`Add Shape ▾`, `Draw ▾`) is `position: absolute; top: 100%`
inside that scroller. Measured:

```
menu rect:      y=103 → bottom=423   (h=320)
scroller rect:  y=59  → bottom=97    (h=38)
px of menu below the scroller:        326
scroller overflow:  x=auto  y=auto
```

`overflow-x: auto` **cannot** leave the other axis `visible` — per CSS overflow,
a non-`visible` value on one axis computes `visible` on the other to `auto`. So
the row became a scroll container on BOTH axes and the menu is clipped to a 38px
strip. The item is in the DOM, has a real `getBoundingClientRect()`, and is
keyboard reachable — but at its own centre:

```
BEFORE: document.elementFromPoint(692,128) -> <svg role="application">   hit=false
```

The click lands on the **canvas**, not the menu item. Confirmed causally by
neutralising only that one property at runtime:

```
AFTER patching overflow:visible -> hit=true, elementAtPoint=SPAN
then clicking Rectangle -> live region: "Rectangle tool active"
```

That is the whole reported bug: *"menu click opens the menu but does not enter
the tool."* The tool was never entered because the click never reached the item.

**Why the old tests passed:** `editor-object-toolbar-probe.mjs:191` activates
shapes with `await key("r", ...)` and its own comment says *"Use the keyboard
shortcut: shape tools live in a cluster menu."* The click path had no coverage
at any layer.

**Fix:** render the cluster/overflow menu in a portal anchored to the trigger, so
it is never a descendant of a scroll container. A guard test must assert no
ancestor of the open menu has a non-`visible` computed overflow, and the probe
must click the menu ITEM.

---

## DEFECT 2 — one shape drag = TWO undo entries, so Undo does not remove the shape

Stop condition requires "Undo removes the shape". Measured after one drag:

```
undo button: "Undo Resize (Ctrl+Z)"
after undo #1: objects=1   nextUndo="Undo Add object (Ctrl+Z)"
after undo #2: objects=0   nextUndo=disabled
```

`onCanvasPointerDown` (`EditorCanvas.tsx:780`) calls `actions.addShape(...)` →
one `AddObjectCommand("Add object")`. Then every `pointermove` executes a
`TransformObjectsCommand("Resize", …)` (line 885) under one coalesce key. Two
stack entries. The first Ctrl+Z only undoes the *sizing*, leaving a 120×120
shape on the page — the user presses Undo, the shape stays, and it has silently
changed size.

**Fix:** wrap create+size in one history transaction so the drag is a single
entry, labelled for the shape ("Add rectangle").

## DEFECT 3 — the committed shape is the WRONG SIZE (a real coordinate bug)

`DEFAULT_SHAPE_SIZE = 100` (`EditorCanvas.tsx:98`) is used as the scale divisor,
but `createShapeObject` defaults `localBounds` to **120×120**
(`objectFactories.ts:142`). The gesture computes `sx = w/100` and applies it to a
120-wide object, so every shape lands **1.2× larger than the rectangle dragged**:

```
intended screen rect  w=119 h=101
actual object rect    w=143 h=121      OFFSET dw=+24 dh=+20
```

Predicted exactly: `120 * (119/100) = 142.8 ≈ 143`. The brief's requirement
"the visual pointer rectangle and resulting model coordinates must agree" is
violated at every zoom (measured identically at both zoom attempts). Highlight
is worse — its factory bounds are 160×28, so a highlight is stretched 1.6× wide
and shrunk to 0.28× tall.

**Fix:** derive the divisor from the object's ACTUAL `localBounds` instead of a
constant that duplicates the factory's knowledge.

## DEFECT 4 — Escape mid-gesture does not cancel a shape

```
Escape mid-drag: before=2 midDrag=3 afterEscape=3 afterRelease=3
```

The Escape handler (`EditorCanvas.tsx:1063`) handles `pan` and `erase` only.
A half-dragged shape survives Escape and stays committed. Brief requires
"Escape to cancel" and "no orphan preview".

## DEFECT 5 — a plain click creates a full-size shape with no drag

```
click-only: created=1  box 120×120
```

Not necessarily wrong (the brief permits click-to-place a default shape), but it
is currently an accident of defect 3, not a decision: the size comes from the
factory default while the gesture believed it was 100. Made explicit with a
deliberate default size and a real drag threshold.

## DEFECT 6 — shapes can be created in the gray canvas, outside the page

```
off-page start at x=210 (page starts x=242): created=1
box: {x:210, y:372, w:115, h:72}   <- starts 32px OUTSIDE the page
```

Brief: "A shape gesture must start on the actual PDF page. Do not create objects
in the surrounding gray canvas."

---

## Draw

Draw shares defects 1 (menu unreachable) and 4/6 (Escape, page bounds). Its own
commit path is otherwise correct: the live preview already uses the real brush
colour/width/opacity (`EditorCanvas.tsx:1308`), and `drawSettings.ts` is
complete. `addDrawing` is a single command, so Draw does NOT have defect 2.

---

## IMPLEMENTED FIXES

| Defect | Fix as shipped |
|---|---|
| **1** menu clipped out of the hit test | The cluster/overflow menu is rendered in a **portal anchored to its trigger**, so it is never a descendant of the `overflow-x-auto` row. `elementFromPoint` at the item's own centre now returns **SPAN**, and clicking the item enters the tool. |
| **2** one drag = two undo entries | Create + size are **one deferred commit**. Object count reads `before=0 mid=0 after=1` — the object does not exist until the gesture ends — and the drag is **ONE** undo/redo entry. |
| **3** committed shape 1.2x too large | The scale divisor is derived from the object's **actual `localBounds`**, not the `DEFAULT_SHAPE_SIZE = 100` constant that duplicated the factory's 120. Drag 160x100 now commits 160x100 exactly; at 150% zoom a 120x72 drag commits 120x72. |
| **4** Escape does not cancel | Escape cancels the in-flight gesture and leaves **nothing** behind. |
| **5** click-only created an accidental 120x120 | Now a deliberate decision, not a side effect of defect 3: a plain click places a **107x107** default shape, with a real drag threshold separating click-to-place from drag-to-size. |
| **6** shapes created outside the page | A gesture starting in the surrounding grey canvas **creates nothing**. |

### The invariants these fixes established

1. **Portal invariant.** The open menu must **not** descend from the overflow row.
   `overflow-x: auto` cannot leave the cross axis `visible` — per CSS overflow a
   non-`visible` value on one axis computes the other's `visible` to `auto` — so
   any menu inside that row is clipped to the row's own 38px height while keeping
   a real layout rect and keyboard reachability. **Keyboard worked, mouse did
   not**, which is why a keyboard-driven probe called it green for months.
2. **Deferred-commit invariant.** A shape does not enter the document until the
   gesture completes. `before=0 mid=0 after=1`, one history entry.
3. **Real-bound scaling.** Never reintroduce a size constant that duplicates
   factory knowledge — that is the 100-vs-120 mismatch, and Highlight (factory
   bounds 160x28) made it worst.
4. **Active-tool truthfulness.** A control that is not the active tool must not
   claim to be one: `Select` reports `aria-pressed="false"` while Rectangle is
   active, and again while Draw is active.
5. **Draw = one object per stroke.**

## FINAL VERIFICATION

`scripts/editor-shape-draw-probe.mjs --shots`: **46 PASS / 0 FAIL, 0 console
errors**, re-run against a live server (`/editor` = 200 confirmed by curl first —
a dead server returns 000 and produces all-zero measurements that pass
vacuously).

Measured evidence, all from real CDP interaction:

```
shape menu height          406px   (was 38px — the clip)
elementFromPoint at item   SPAN    (was <svg role="application">)
deferred commit            before=0  mid=0  after=1
geometry                   drag 160x100 -> committed 160x100
geometry at 150% zoom      drag 120x72  -> committed 120x72
history                    ONE undo / ONE redo per drag
click-to-place             107x107
Escape                     cancels, nothing left behind
off-page gesture           creates nothing
Draw                       one object per stroke
Select aria-pressed        false while Rectangle active; false while Draw active
```

Nine screenshots of the real states in `docs/screenshots/p1-final/`:
`shape-menu`, `shape-drag-preview`, `shape-created`, `shape-selected`,
`shape-click-default`, `draw-menu`, `draw-active`, `draw-stroke-preview`,
`draw-selected`. **`shape-created.png` and `shape-selected.png` are
byte-identical** (`cmp` reports IDENTICAL) — creating a shape leaves it selected,
so both hooks capture the same state. Reported rather than staged.

One related invariant was found **later**, in the premium visual pass, in the same
row: the tool row carried `min-w-0` inside the scroller, so it shrank below its own
content while its own `overflow-x` stayed `visible`; the scroller then reported
`scrollWidth === clientWidth`, offered no scrollbar, and laid later siblings over
the spilled tools — clicking **Crop** opened the **Pages** panel. Children of a
scroller must be `shrink-0`; only the scroller may be `min-w-0 flex-1`. Full
measurements in `docs/editor-p1-premium-polish.md`.
