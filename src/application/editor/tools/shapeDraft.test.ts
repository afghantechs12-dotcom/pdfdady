import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createShapeObject } from '@/src/domain/editor/objectFactories';
import { isObjectKind } from '@/src/domain/editor/objects';
import { shapePathData } from '@/src/domain/editor/shapeGeometry';
import { resolveShapeDraft } from './shapeDraft';
import { ShapeDraft } from '@/components/editor/canvas/InteractionLayer';
import { createEditorInstance } from '@/lib/editor/createEditorInstance';
const page = { width: 595, height: 842 };
const a = { x: 100, y: 100 }, b = { x: 220, y: 170 };

describe('live shape draft', () => {
  it.each(['rect', 'ellipse', 'line', 'arrow', 'polygon'] as const)('paints real %s geometry and style before canonical commit', shape => {
    const template = createShapeObject(a, 'layer-1', shape);
    const draft = resolveShapeDraft(template, a, b, page);
    const markup = renderToStaticMarkup(createElement(ShapeDraft, { object: draft, viewport: { zoom: 1, pan: { x: 0, y: 0 } }, origin: { x: 0, y: 0 } }));
    expect(isObjectKind(draft, 'shape')).toBe(true);
    if (!isObjectKind(draft, 'shape')) throw new Error('shape expected');
    expect(markup).toContain(`d="${shapePathData(draft)}"`);
    expect(markup).toContain('120 × 70');
    expect(draft.style).toEqual(template.style);
    const ed = createEditorInstance(); const before = ed.undoDepth;
    ed.addObject(draft, draft.layerId); expect(ed.undoDepth).toBe(before + 1);
    expect(ed.getState().document.pages[0].objects[draft.id]).toEqual(draft);
    ed.undo(); expect(ed.getState().document.pages[0].objects[draft.id]).toBeUndefined();
    ed.redo(); expect(ed.getState().document.pages[0].objects[draft.id]).toEqual(draft);
  });
  it('normalizes reverse drags and constrains a Shift ellipse', () => {
    const t = createShapeObject(a, 'layer-1', 'ellipse');
    const reverse = resolveShapeDraft(t, b, a, page);
    expect(reverse.transform.e).toBe(100); expect(reverse.transform.f).toBe(100);
    const square = resolveShapeDraft(t, a, b, page, true);
    expect(square.localBounds.width).toBe(square.localBounds.height);
  });
  it('keeps line direction on a reverse drag and snaps Shift to 45 degrees', () => {
    const t = createShapeObject(a, 'layer-1', 'line');
    const d = resolveShapeDraft(t, b, a, page, true);
    if (!isObjectKind(d, 'shape')) throw new Error('shape expected');
    expect(d.points[0].x).toBeGreaterThan(d.points[1].x);
    expect(d.points[0].x - d.points[1].x).toBeCloseTo(d.points[0].y - d.points[1].y);
  });
  it('keeps minimum-size drafts inside the page at its edges', () => {
    const d = resolveShapeDraft(createShapeObject(a, 'layer-1', 'rect'), { x: 595, y: 842 }, { x: 700, y: 900 }, page);
    expect(d.transform.e + d.localBounds.width).toBeLessThanOrEqual(page.width);
    expect(d.transform.f + d.localBounds.height).toBeLessThanOrEqual(page.height);
  });
  it('a click has a documented visible default size and never creates a zero area object', () => {
    const d = resolveShapeDraft(createShapeObject(a, 'layer-1', 'rect'), a, a, page);
    expect(d.localBounds.width).toBeCloseTo(595 * .18);
    expect(d.localBounds.height).toBe(d.localBounds.width);
  });
});
