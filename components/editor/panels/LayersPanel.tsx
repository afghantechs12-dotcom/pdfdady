"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Plus,
  Trash2,
} from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import { pageObjects } from "@/hooks/editor/useEditor";
import { isObjectKind, type EditorObject } from "@/src/domain/editor/objects";

/**
 * The Layers panel (Part 5). Lists layers top-first (the stack is stored
 * bottom-first), each with rename / hide / lock / duplicate / delete / reorder,
 * and an expandable list of the objects on it (paint order, top-first) with
 * per-object select / hide / lock / rename / z-order. Selection is kept in sync
 * with the canvas via the shared editor binding.
 */
export function LayersPanel() {
  const { activePage, selection, actions } = useEditorContext();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingLayer, setEditingLayer] = useState<string | null>(null);
  const [editingObject, setEditingObject] = useState<string | null>(null);

  const layers = activePage.layerStack.layers;
  // Display top-first; the stack is bottom-first.
  const ordered = [...layers].reverse();

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-editor-border px-2 py-2">
        <h2 className="text-sm font-semibold text-editor-text">Layers</h2>
        <button
          className="rounded p-1 text-editor-muted hover:bg-editor-subtle hover:text-editor-text"
          onClick={() => actions.addLayer(`Layer ${layers.length + 1}`)}
          aria-label="Add layer"
          title="Add layer"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {ordered.map((layer, displayIdx) => {
          const isOpen = expanded.has(layer.id);
          const layerObjects = pageObjects(activePage).filter((o) => o.layerId === layer.id).reverse();
          return (
            <div key={layer.id} className="mb-0.5">
              <div
                className={`group flex items-center gap-1 rounded px-1 py-1 ${editingLayer === layer.id ? "" : "hover:bg-editor-subtle"}`}
              >
                <button
                  className="rounded p-0.5 text-editor-muted hover:text-editor-text"
                  onClick={() => toggleExpand(layer.id)}
                  aria-label={isOpen ? "Collapse layer" : "Expand layer"}
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <IconButton
                  active={!layer.visible}
                  onClick={() => actions.setLayerProperty(layer.id, { visible: !layer.visible }, layer.visible ? "Hide layer" : "Show layer")}
                  title={layer.visible ? "Hide layer" : "Show layer"}
                >
                  {layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </IconButton>
                <IconButton
                  active={layer.locked}
                  onClick={() => actions.setLayerProperty(layer.id, { locked: !layer.locked }, layer.locked ? "Unlock layer" : "Lock layer")}
                  title={layer.locked ? "Unlock layer" : "Lock layer"}
                >
                  {layer.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </IconButton>
                {editingLayer === layer.id ? (
                  <input
                    autoFocus
                    defaultValue={layer.name}
                    onBlur={(e) => {
                      actions.setLayerProperty(layer.id, { name: e.target.value || layer.name }, "Rename layer");
                      setEditingLayer(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingLayer(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-editor-accent/60 px-1 text-sm"
                    data-editor-text-input="true"
                  />
                ) : (
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm text-editor-text"
                    onDoubleClick={() => setEditingLayer(layer.id)}
                    title="Double-click to rename"
                  >
                    {layer.name}
                  </button>
                )}
                <div className="flex items-center opacity-0 group-hover:opacity-100">
                  <IconButton onClick={() => actions.reorderLayer(layer.id, 1)} disabled={displayIdx === 0} title="Move layer up">
                    <ChevronUpIcon />
                  </IconButton>
                  <IconButton onClick={() => actions.reorderLayer(layer.id, -1)} disabled={displayIdx === ordered.length - 1} title="Move layer down">
                    <ChevronDownIcon />
                  </IconButton>
                  <IconButton onClick={() => actions.duplicateLayer(layer.id)} title="Duplicate layer">
                    <Copy className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    onClick={() => layers.length > 1 && actions.deleteLayer(layer.id)}
                    disabled={layers.length <= 1}
                    title="Delete layer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>
              {isOpen ? (
                <div className="ml-4 border-l border-editor-border pl-2">
                  {layerObjects.map((obj) => (
                    <ObjectRow
                      key={obj.id}
                      obj={obj}
                      selected={selection.ids.includes(obj.id)}
                      editing={editingObject === obj.id}
                      onSelect={() => actions.select(obj.id)}
                      onToggleVisible={() => actions.setProperty(obj.id, { visible: !obj.visible }, obj.visible ? "Hide object" : "Show object")}
                      onToggleLock={() => actions.setProperty(obj.id, { locked: !obj.locked }, obj.locked ? "Unlock object" : "Lock object")}
                      onRename={() => setEditingObject(obj.id)}
                      onCommitRename={(name) => {
                        actions.setProperty(obj.id, { name: name || obj.name }, "Rename object");
                        setEditingObject(null);
                      }}
                      onCancelRename={() => setEditingObject(null)}
                      onForward={() => actions.bringForward(obj.id)}
                      onBackward={() => actions.sendBackward(obj.id)}
                    />
                  ))}
                  {layerObjects.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-editor-muted">Empty layer</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ObjectRow({
  obj,
  selected,
  editing,
  onSelect,
  onToggleVisible,
  onToggleLock,
  onRename,
  onCommitRename,
  onCancelRename,
  onForward,
  onBackward,
}: {
  obj: EditorObject;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  onRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onForward: () => void;
  onBackward: () => void;
}) {
  return (
    <div className={`group flex items-center gap-1 rounded px-1 py-0.5 ${selected ? "bg-editor-accentsoft" : "hover:bg-editor-subtle"}`}>
      <IconButton active={!obj.visible} onClick={onToggleVisible} title={obj.visible ? "Hide" : "Show"}>
        {obj.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      </IconButton>
      <IconButton active={obj.locked} onClick={onToggleLock} title={obj.locked ? "Unlock" : "Lock"}>
        {obj.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
      </IconButton>
      {/* A small marker distinguishing original PDF text from editor-authored text.
          Readonly runs are locked by default but the marker stays even if unlocked,
          so the Layers list always shows provenance. */}
      {isObjectKind(obj, "text") && obj.sourceText != null ? (
        <span
          className="shrink-0 h-1.5 w-1.5 rounded-full bg-blue-500"
          title={obj.sourceText.mode === "readonly" ? "Original PDF text (readonly)" : "Text replacement"}
          aria-label={obj.sourceText.mode === "readonly" ? "Original PDF text" : "Text replacement"}
        />
      ) : null}
      {editing ? (
        <input
          autoFocus
          defaultValue={obj.name}
          onBlur={(e) => onCommitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") onCancelRename();
          }}
          className="min-w-0 flex-1 rounded border border-editor-accent/60 px-1 text-xs"
          data-editor-text-input="true"
        />
      ) : (
        <button
          className={`min-w-0 flex-1 truncate text-left text-xs ${selected ? "text-editor-accent" : "text-editor-muted"}`}
          onClick={onSelect}
          onDoubleClick={onRename}
          title="Click to select, double-click to rename"
        >
          {obj.name}
        </button>
      )}
      <div className="flex items-center opacity-0 group-hover:opacity-100">
        <button className="rounded p-0.5 text-editor-muted hover:text-editor-text" onClick={onForward} title="Bring forward" aria-label="Bring forward">
          <ChevronUpIcon />
        </button>
        <button className="rounded p-0.5 text-editor-muted hover:text-editor-text" onClick={onBackward} title="Send backward" aria-label="Send backward">
          <ChevronDownIcon />
        </button>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  active,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`rounded p-0.5 ${active ? "text-editor-accent" : "text-editor-muted"} ${disabled ? "cursor-not-allowed opacity-30" : "hover:bg-editor-subtle hover:text-editor-text"}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function ChevronUpIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
