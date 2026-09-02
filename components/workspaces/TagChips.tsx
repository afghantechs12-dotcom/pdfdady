"use client";

import { useId, useMemo, useState } from "react";
import { Tag as TagIcon, X, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/Button";
import {
  canAddTag,
  filterTags,
  readableTextColor,
  type TagCatalogItem,
  type TagChipItem,
} from "./tagLogic";
import { TAG_LIMITS } from "@/src/domain/entities/Tag";

/**
 * A tag chip.
 *
 * The swatch is applied as a background with a computed foreground rather than
 * as author-chosen text colour, so a tag can never be given a colour pair that
 * renders it unreadable. `onRemove` is a real button rather than a click
 * handler on the chip: removal must be reachable from the keyboard and
 * announced as its own control.
 */
export function TagChip({
  tag,
  onRemove,
  busy = false,
}: {
  tag: TagChipItem;
  onRemove?: (tag: TagChipItem) => void;
  busy?: boolean;
}) {
  const background = tag.color ?? "#e2e8f0";
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: background, color: readableTextColor(tag.color) }}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(tag)}
          disabled={busy}
          aria-label={`Remove tag ${tag.name}`}
          className="rounded-full p-0.5 transition-opacity hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** The chips on one document, with an empty state that is a sentence, not a blank. */
export function TagChipList({
  tags,
  onRemove,
  busy = false,
  emptyLabel = "No tags yet.",
}: {
  tags: TagChipItem[];
  onRemove?: (tag: TagChipItem) => void;
  busy?: boolean;
  emptyLabel?: string;
}) {
  if (tags.length === 0) {
    return <p className="text-xs text-navy-soft">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <li key={tag.id}>
          <TagChip tag={tag} onRemove={onRemove} busy={busy} />
        </li>
      ))}
    </ul>
  );
}

export interface TagPickerProps {
  catalog: TagCatalogItem[];
  selectedIds: string[];
  onToggle: (tagId: string) => void;
  /** Called when the typed term names no existing tag and creation is offered. */
  onCreate?: (name: string) => void;
  busy?: boolean;
  label?: string;
}

/**
 * The add/remove control.
 *
 * The list is a listbox of toggle buttons rather than a native multi-select:
 * each option carries a swatch and a checked state, and every option is
 * reachable by Tab with a visible focus ring.
 */
export function TagPicker({
  catalog,
  selectedIds,
  onToggle,
  onCreate,
  busy = false,
  label = "Add a tag",
}: TagPickerProps) {
  const [term, setTerm] = useState("");
  const inputId = useId();
  const listId = useId();

  const matches = useMemo(() => filterTags(catalog, term), [catalog, term]);
  const trimmed = term.trim();
  const exactExists = matches.some(
    (tag) => tag.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const atCap = !canAddTag(selectedIds.length);

  return (
    <div className="w-full">
      <label htmlFor={inputId} className="text-sm font-semibold text-navy">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        autoComplete="off"
        value={term}
        disabled={busy}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search tags"
        className="mt-2 w-full rounded-button border border-softborder px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      />

      {atCap && (
        <p role="status" className="mt-2 text-xs text-amber-700">
          This document already has the maximum of {TAG_LIMITS.maxTagsPerDocument} tags.
        </p>
      )}

      <ul id={listId} role="listbox" aria-label="Tags" className="mt-2 max-h-56 overflow-y-auto">
        {matches.length === 0 && (
          <li className="px-1 py-2 text-xs text-navy-soft">No tags match “{trimmed}”.</li>
        )}
        {matches.map((tag) => {
          const selected = selectedIds.includes(tag.id);
          return (
            <li key={tag.id} role="option" aria-selected={selected}>
              <button
                type="button"
                onClick={() => onToggle(tag.id)}
                disabled={busy || (atCap && !selected)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  selected ? "bg-primary/10 text-navy" : "hover:bg-slate-50 text-navy-soft",
                  "disabled:opacity-50",
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: tag.color ?? "#e2e8f0" }}
                />
                <span className="flex-1 truncate">{tag.name}</span>
                {selected && <Check size={14} aria-hidden="true" className="text-primary" />}
              </button>
            </li>
          );
        })}
      </ul>

      {onCreate && trimmed && !exactExists && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy || atCap}
          onClick={() => {
            onCreate(trimmed);
            setTerm("");
          }}
          className="mt-2 w-full justify-center text-sm"
        >
          <Plus size={14} aria-hidden="true" className="mr-1" />
          Create “{trimmed}”
        </Button>
      )}
    </div>
  );
}

/** The tags on one document, with the picker attached. */
export function DocumentTagEditor({
  tags,
  catalog,
  onToggle,
  onCreate,
  busy = false,
}: {
  tags: TagChipItem[];
  catalog: TagCatalogItem[];
  onToggle: (tagId: string) => void;
  onCreate?: (name: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedIds = tags.map((tag) => tag.id);

  return (
    <section aria-label="Document tags" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <TagChipList tags={tags} onRemove={(tag) => onToggle(tag.id)} busy={busy} />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="shrink-0 text-xs"
        >
          <TagIcon size={14} aria-hidden="true" className="mr-1" />
          {open ? "Done" : "Edit tags"}
        </Button>
      </div>

      {open && (
        <div className="rounded-card border border-softborder bg-white p-3 shadow-card">
          <TagPicker
            catalog={catalog}
            selectedIds={selectedIds}
            onToggle={onToggle}
            onCreate={onCreate}
            busy={busy}
          />
        </div>
      )}
    </section>
  );
}
