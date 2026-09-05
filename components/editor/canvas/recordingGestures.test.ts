import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createEditorInstance } from '@/lib/editor/createEditorInstance';
import { createDrawing } from '@/src/domain/editor/objectFactories';
import { getActivePage } from '@/src/domain/editor/document';
import { EditorCanvas } from '@/components/editor/EditorCanvas';
import { InteractionLayer } from './InteractionLayer';
import type { EditorTool } from '@/components/editor/editorTypes';

const context = vi.hoisted(() => ({ value: {} }));
vi.mock('@/components/editor/EditorContext', () => ({ useEditorContext: () => context.value }));
// Shallow handler harness: execute the actual canvas handlers and service, with
// deterministic frame delivery. It does not claim browser capture/layout tests.
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useMemo: (create: () => unknown) => create(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
}));

type ElementProps = { children?: ReactNode; ref?: { current: unknown }; [key: string]: unknown };
function find(node: ReactNode, type: unknown): ReactElement<ElementProps> | null {
  if (!isValidElement<ElementProps>(node)) return null;
  if (node.type === type) return node;
  for (const child of Children.toArray(node.props.children)) { const hit = find(child, type); if (hit) return hit; }
  return null;
}
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
function flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(0)); }
function harness(tool: EditorTool) {
  const ed = createEditorInstance();
  const layer = getActivePage(ed.getState()).layerStack.layers[0].id;
  ed.addObject(createDrawing({ x: 0, y: 0 }, layer, [{ x: 20, y: 100 }, { x: 200, y: 100 }]), layer);
  const state = ed.getState();
  context.value = { state, service: ed, activePage: getActivePage(state), selection: { ids: [], bounds: null }, actions: {
    addObject: ed.addObject.bind(ed), select: ed.select.bind(ed), clearSelection: () => ed.clearSelection(),
  } };
  const tree = EditorCanvas({ tool, viewport: { zoom: 1, pan: { x: 0, y: 0 } }, onViewportChange: vi.fn(), onToolChange: vi.fn() });
  const svg = find(tree, 'svg')!;
  svg.props.ref!.current = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const preview = { ink: vi.fn(), shape: vi.fn(), reset: vi.fn() };
  find(tree, InteractionLayer)!.props.ref!.current = preview;
  const event = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse', shiftKey: false, target: { setPointerCapture: vi.fn() } });
  const send = (name: string, x: number, y: number) => (svg.props[name] as (e: unknown) => void)(event(x, y));
  return { ed, preview, send };
}

describe('actual canvas gesture handlers', () => {
  it('M3: eraser pointer moves never notify persistence or change canonical state', () => {
    const { ed, send, preview } = harness('eraser');
    const before = ed.getState(), depth = ed.undoDepth;
    const notify = vi.fn(); ed.subscribe(notify);
    send('onPointerDown', 100, 70);
    send('onPointerMove', 100, 100); flush();
    expect(preview.ink).toHaveBeenCalled();
    expect(ed.getState()).toBe(before); expect(notify).not.toHaveBeenCalled();
    send('onPointerUp', 100, 130);
    expect(ed.undoDepth).toBe(depth + 1); expect(notify).toHaveBeenCalledTimes(1);
    ed.undo(); expect(ed.getState()).toEqual(before);
  });
  it('pointer cancellation discards a partial erase without a history entry', () => {
    const { ed, send, preview } = harness('eraser'); const before = ed.getState(), depth = ed.undoDepth;
    send('onPointerDown', 100, 100); send('onPointerMove', 100, 110); flush();
    send('onPointerCancel', 100, 110); flush();
    expect(preview.reset).toHaveBeenCalled(); expect(ed.getState()).toBe(before); expect(ed.undoDepth).toBe(depth);
  });
  it('a shape preview has no canonical object until release and commits that exact draft', () => {
    const { ed, send, preview } = harness('polygon'); const before = ed.getState(), depth = ed.undoDepth;
    send('onPointerDown', 200, 200); send('onPointerMove', 300, 300);
    const draft = preview.shape.mock.calls.at(-1)?.[0]; expect(draft.shape).toBe('polygon');
    expect(ed.getState()).toBe(before);
    send('onPointerUp', 300, 300);
    expect(getActivePage(ed.getState()).objects[draft.id]).toEqual(draft); expect(ed.undoDepth).toBe(depth + 1);
  });
  it('cancelled shape gestures cannot commit when a late pointer-up arrives', () => {
    const { ed, send } = harness('polygon'); const depth = ed.undoDepth;
    send('onPointerDown', 200, 200); send('onPointerMove', 300, 300);
    send('onPointerCancel', 300, 300); send('onPointerUp', 300, 300);
    expect(ed.undoDepth).toBe(depth);
  });
});
