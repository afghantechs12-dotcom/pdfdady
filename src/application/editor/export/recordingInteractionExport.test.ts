import { describe, expect, it } from 'vitest';
import { createEditorInstance } from '@/lib/editor/createEditorInstance';
import { createDrawing, createShapeObject } from '@/src/domain/editor/objectFactories';
import { getActivePage } from '@/src/domain/editor/document';
import { PartialInkGesture } from '@/src/application/editor/tools/partialEraser';
import { EraseInkCommand } from '@/src/application/editor/commands/EraseInkCommand';
import { resolveShapeDraft } from '@/src/application/editor/tools/shapeDraft';
import { PdfExportService } from './PdfExportService';
import { readPdfPageContent } from './testing/pdfContent';

describe('recorded interactions through PDF export', () => {
  it('exports two surviving ink paths and the real polygon after scene reload, without a whiteout', async () => {
    const ed = createEditorInstance();
    const layer = getActivePage(ed.getState()).layerStack.layers[0].id;
    const stroke = createDrawing({ x: 0, y: 0 }, layer, [{ x: 10, y: 50 }, { x: 110, y: 50 }]);
    ed.addObject(stroke, layer);
    const gesture = new PartialInkGesture(getActivePage(ed.getState()), { x: 60, y: 50 }, 8);
    ed.execute(new EraseInkCommand(gesture.page, gesture.replacements));
    ed.addObject(resolveShapeDraft(createShapeObject({ x: 0, y: 0 }, layer, 'polygon'), { x: 100, y: 100 }, { x: 180, y: 180 }, getActivePage(ed.getState())), layer);
    const exporter = new PdfExportService();
    const live = await readPdfPageContent(await exporter.exportPdf(ed.getState()));
    const reopened = createEditorInstance(); reopened.deserialize(ed.serialize());
    const saved = await readPdfPageContent(await exporter.exportPdf(reopened.getState()));
    expect(live.paints.filter(p => p === 'S')).toHaveLength(2);
    expect(live.fills.some(c => c.r === 1 && c.g === 1 && c.b === 1)).toBe(false);
    expect(live.fills).toHaveLength(1);
    expect(saved.paints).toEqual(live.paints);
    expect(saved.strokes).toEqual(live.strokes);
    expect(saved.fills).toEqual(live.fills);
    const coordinates = (s: string) => s.match(/[-\d.]+ [-\d.]+ [ml]/g);
    expect(coordinates(saved.operators)).toEqual(coordinates(live.operators));
  });
});
