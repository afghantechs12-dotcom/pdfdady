"use client";
import type { ShapeObject } from "@/src/domain/editor/objects";
import { ColorPicker } from "./color/ColorPicker";

/** Future-shape defaults are separate from the selected object's Inspector. */
export function ShapeControls({ template, onChange }: { template: ShapeObject; onChange: (next: ShapeObject) => void }) {
  const updateStyle = (patch: Partial<ShapeObject["style"]>) => onChange({ ...template, style: { ...template.style, ...patch } });
  const control = "min-h-11 rounded-control border border-editor-border bg-editor-surface px-2 text-sm text-editor-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-editor-accent";
  return <div role="group" aria-label="New shape defaults" className="flex flex-wrap items-center gap-3 border-b border-editor-border bg-editor-surface px-3 py-2 text-sm text-editor-text">
    <strong>New shape</strong>
    <ColorPicker label="New shape fill" value={template.style.fill} allowNoFill onChange={fill => updateStyle({ fill })} triggerClassName={control} />
    <ColorPicker label="New shape stroke" value={template.style.stroke} allowNoFill onChange={stroke => updateStyle({ stroke })} triggerClassName={control} />
    <label className="flex items-center gap-2">Width <input className={`${control} w-16`} type="number" min={0} max={32} step={.5}
      value={template.style.strokeWidth} onChange={e => updateStyle({ strokeWidth: Math.max(0, Math.min(32, Number(e.target.value))) })} /></label>
    <label className="flex items-center gap-2">Opacity <input className={`${control} w-20`} type="number" min={5} max={100} step={5}
      value={Math.round(template.opacity * 100)} onChange={e => onChange({ ...template, opacity: Math.max(.05, Math.min(1, Number(e.target.value) / 100)) })} />%</label>
    <label className="flex items-center gap-2">Line <select className={control} value={template.style.dash?.length ? "dashed" : "solid"}
      onChange={e => updateStyle({ dash: e.target.value === "dashed" ? [6, 4] : [] })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label>
    {template.shape === "polygon" && <label className="flex items-center gap-2">Sides <input className={`${control} w-16`} type="number" min={3} max={12}
      value={template.sides ?? 6} onChange={e => onChange({ ...template, sides: Math.max(3, Math.min(12, Math.round(Number(e.target.value)))) })} /></label>}
    <span className="text-editor-muted">Shift constrains · Esc cancels</span>
  </div>;
}
