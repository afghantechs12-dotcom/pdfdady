"use client";

import { useId, useState } from "react";
import { Pencil, Trash2, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TagChip } from "./TagChips";
import {
  readableTextColor,
  summarizeBulkResult,
  validateBulkSelection,
  validateColorDraft,
  validateTagDraft,
  type TagCatalogItem,
} from "./tagLogic";
import { TAG_LIMITS } from "@/src/domain/entities/Tag";

export interface TagCatalogProps {
  tags: TagCatalogItem[];
  loading?: boolean;
  /** Server-reported failure for the last action, surfaced verbatim to the user. */
  error?: string | null;
  onCreate: (draft: { name: string; color: string | null }) => Promise<void> | void;
  onRename: (tag: TagCatalogItem, name: string, color: string | null) => Promise<void> | void;
  onDelete: (tag: TagCatalogItem) => Promise<void> | void;
}

/**
 * Tag management for a Workspace.
 *
 * Validation runs against the same domain rules the API enforces, so a name the
 * form accepts is a name the server accepts. A failure that only the server can
 * know about — a tag created concurrently, a stale revision — is surfaced as
 * the server worded it rather than replaced with a generic apology.
 */
export function TagCatalog({
  tags,
  loading = false,
  error = null,
  onCreate,
  onRename,
  onDelete,
}: TagCatalogProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const colorId = useId();

  const editing = tags.find((tag) => tag.id === editingId) ?? null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nameCheck = validateTagDraft(name, tags, editingId ?? undefined);
    if (!nameCheck.ok) {
      setLocalError(nameCheck.message);
      return;
    }
    const colorCheck = validateColorDraft(color);
    if (!colorCheck.ok) {
      setLocalError(colorCheck.message);
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      const trimmedColor = color.trim() || null;
      if (editing) await onRename(editing, name.trim(), trimmedColor);
      else await onCreate({ name: name.trim(), color: trimmedColor });
      setName("");
      setColor("");
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(tag: TagCatalogItem) {
    setEditingId(tag.id);
    setName(tag.name);
    setColor(tag.color ?? "");
    setLocalError(null);
  }

  const message = localError ?? error;

  return (
    <section
      aria-labelledby="tag-catalog-title"
      className="rounded-card border border-softborder bg-white p-6 shadow-card"
    >
      <h2 id="tag-catalog-title" className="text-xl font-bold text-navy">
        Tags
      </h2>
      <p className="mt-1 text-sm text-navy-soft">
        Tags are shared across this workspace. Up to {TAG_LIMITS.maxTagsPerDocument} can be applied
        to a document.
      </p>

      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <label htmlFor={nameId} className="text-sm font-semibold text-navy">
          Name
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={TAG_LIMITS.maxNameLength}
            disabled={busy}
            aria-invalid={message !== null}
            aria-describedby={message ? "tag-catalog-status" : undefined}
            className="mt-2 w-full rounded-button border border-softborder px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
          />
        </label>
        <label htmlFor={colorId} className="text-sm font-semibold text-navy">
          Colour
          <input
            id={colorId}
            value={color}
            onChange={(event) => setColor(event.target.value)}
            placeholder="#3366cc"
            maxLength={TAG_LIMITS.maxColorLength}
            disabled={busy}
            className="mt-2 w-32 rounded-button border border-softborder px-3 py-2 font-mono text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
          />
        </label>
        <Button type="submit" loading={busy} className="self-end">
          {editing ? "Save" : <><Plus size={14} aria-hidden="true" className="mr-1" />Add tag</>}
        </Button>
      </form>

      {editing && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => {
            setEditingId(null);
            setName("");
            setColor("");
            setLocalError(null);
          }}
        >
          Cancel edit
        </Button>
      )}

      <p
        id="tag-catalog-status"
        role="status"
        aria-live="polite"
        className="mt-3 flex items-center gap-1.5 text-sm text-red-700 empty:hidden"
      >
        {message && <AlertCircle size={14} aria-hidden="true" />}
        {message}
      </p>

      <div className="mt-5">
        {loading ? (
          <p className="text-sm text-navy-soft">Loading tags…</p>
        ) : tags.length === 0 ? (
          <p className="text-sm text-navy-soft">
            No tags yet. Create one above to start organising documents.
          </p>
        ) : (
          <ul className="divide-y divide-softborder/70">
            {tags.map((tag) => (
              <li key={tag.id} className="flex items-center justify-between gap-3 py-2.5">
                <TagChip tag={tag} />
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => beginEdit(tag)}
                    aria-label={`Edit tag ${tag.name}`}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(tag)}
                    aria-label={`Delete tag ${tag.name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export interface BulkTagPanelProps {
  catalog: TagCatalogItem[];
  selectedDocumentIds: string[];
  onApply: (
    operation: "assign" | "remove",
    tagIds: string[],
  ) => Promise<{ succeeded: string[]; failed: Array<{ documentId: string; error: string }> } | void>;
}

/**
 * Bulk tagging over a document selection.
 *
 * The result is reported per document rather than as a single success or
 * failure: a batch where two of twenty documents were archived is a partial
 * success, and saying only "failed" would be wrong in both directions.
 */
export function BulkTagPanel({ catalog, selectedDocumentIds, onApply }: BulkTagPanelProps) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(operation: "assign" | "remove") {
    const check = validateBulkSelection(selectedDocumentIds, tagIds);
    if (!check.ok) {
      setStatus(check.message);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await onApply(operation, tagIds);
      if (result) setStatus(summarizeBulkResult(result));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="bulk-tag-title"
      className="rounded-card border border-softborder bg-white p-5 shadow-card"
    >
      <h3 id="bulk-tag-title" className="text-base font-bold text-navy">
        Tag {selectedDocumentIds.length} selected
        {selectedDocumentIds.length === 1 ? " document" : " documents"}
      </h3>

      {catalog.length === 0 ? (
        <p className="mt-3 text-sm text-navy-soft">Create a tag first to use bulk tagging.</p>
      ) : (
        <fieldset className="mt-3 border-0 p-0">
          <legend className="sr-only">Choose tags to apply or remove</legend>
          <ul className="flex flex-wrap gap-2">
            {catalog.map((tag) => {
              const checked = tagIds.includes(tag.id);
              return (
                <li key={tag.id}>
                  <label
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold focus-within:ring-2 focus-within:ring-primary/60"
                    style={{
                      backgroundColor: checked ? tag.color ?? "#e2e8f0" : "#f1f5f9",
                      color: checked ? readableTextColor(tag.color) : "#475569",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() =>
                        setTagIds((current) =>
                          current.includes(tag.id)
                            ? current.filter((id) => id !== tag.id)
                            : [...current, tag.id],
                        )
                      }
                      className="h-3 w-3 accent-primary"
                    />
                    {tag.name}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" loading={busy} onClick={() => run("assign")}>
          Apply tags
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run("remove")}
        >
          Remove tags
        </Button>
      </div>

      <p role="status" aria-live="polite" className="mt-3 text-sm text-navy-soft empty:hidden">
        {status}
      </p>
    </section>
  );
}
