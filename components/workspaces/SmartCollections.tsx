"use client";

import { useId, useMemo, useState } from "react";
import { Plus, Trash2, Pencil, AlertCircle, Filter, FileText } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/Button";
import {
  buildQuery,
  emptyDraftCondition,
  operatorForField,
  toggleId,
  validateCollectionDraft,
  type DraftCondition,
  type TagCatalogItem,
} from "./tagLogic";
import {
  QUERY_FIELDS,
  SMART_COLLECTION_LIMITS as L,
  type SmartCollectionQuery,
} from "@/src/domain/entities/SmartCollection";

/** What a saved collection looks like to this component. */
export interface SmartCollectionItem {
  id: string;
  name: string;
  query: SmartCollectionQuery;
  /** True when the stored definition could not be read; it matches nothing. */
  degraded: boolean;
  revision: number;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name contains",
  lifecycleState: "Status is",
  favorite: "Favourite is",
  projectId: "Project is",
  folderId: "Folder is",
  tags: "Has all tags",
  createdAt: "Created between",
  updatedAt: "Updated between",
  createdById: "Created by",
};

/** One condition row in the builder. */
function ConditionRow({
  draft,
  index,
  catalog,
  busy,
  onChange,
  onRemove,
}: {
  draft: DraftCondition;
  index: number;
  catalog: TagCatalogItem[];
  busy: boolean;
  onChange: (next: DraftCondition) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();
  const operator = operatorForField(draft.field);

  return (
    <li className="rounded-card border border-softborder bg-slate-50/60 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={fieldId} className="text-xs font-semibold text-navy">
          Condition {index + 1}
          <select
            id={fieldId}
            value={draft.field}
            disabled={busy}
            onChange={(event) => {
              const field = event.target.value;
              // Resetting the value on a field change is deliberate: a term typed
              // for one field is almost never meaningful for another, and carrying
              // it over is how a user ends up saving a filter they did not mean.
              onChange({ ...emptyDraftCondition(), field, operator: operatorForField(field) });
            }}
            className="mt-1.5 block rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
          >
            {QUERY_FIELDS.map((field) => (
              <option key={field} value={field}>
                {FIELD_LABELS[field] ?? field}
              </option>
            ))}
          </select>
        </label>

        {operator === "range" && (
          <>
            <label className="text-xs font-semibold text-navy">
              From
              <input
                type="date"
                value={draft.from}
                disabled={busy}
                onChange={(event) => onChange({ ...draft, from: event.target.value })}
                className="mt-1.5 block rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              />
            </label>
            <label className="text-xs font-semibold text-navy">
              To
              <input
                type="date"
                value={draft.to}
                disabled={busy}
                onChange={(event) => onChange({ ...draft, to: event.target.value })}
                className="mt-1.5 block rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              />
            </label>
          </>
        )}

        {draft.field === "lifecycleState" && (
          <label className="text-xs font-semibold text-navy">
            Status
            <select
              value={draft.value}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
              className="mt-1.5 block rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <option value="">Choose…</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="trashed">Trashed</option>
            </select>
          </label>
        )}

        {draft.field === "favorite" && (
          <label className="text-xs font-semibold text-navy">
            Favourite
            <select
              value={draft.value}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
              className="mt-1.5 block rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        )}

        {(draft.field === "name" ||
          draft.field === "projectId" ||
          draft.field === "folderId" ||
          draft.field === "createdById") && (
          <label className="min-w-[12rem] flex-1 text-xs font-semibold text-navy">
            Value
            <input
              type="text"
              value={draft.value}
              disabled={busy}
              maxLength={draft.field === "name" ? L.maxTermLength : L.maxIdLength}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
              className="mt-1.5 block w-full rounded-button border border-softborder px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            />
          </label>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove condition ${index + 1}`}
          className="ml-auto"
        >
          <Trash2 size={14} aria-hidden="true" />
        </Button>
      </div>

      {draft.field === "tags" && (
        <fieldset className="mt-3 border-0 p-0">
          <legend className="text-xs font-semibold text-navy">
            Tags (a document must carry all of them)
          </legend>
          {catalog.length === 0 ? (
            <p className="mt-1.5 text-xs text-navy-soft">No tags exist in this workspace yet.</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {catalog.slice(0, L.maxTagsPerCondition).map((tag) => (
                <li key={tag.id}>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-navy-soft ring-1 ring-softborder focus-within:ring-2 focus-within:ring-primary/60">
                    <input
                      type="checkbox"
                      checked={draft.tagIds.includes(tag.id)}
                      disabled={busy}
                      onChange={() => onChange({ ...draft, tagIds: toggleId(draft.tagIds, tag.id) })}
                      className="h-3 w-3 accent-primary"
                    />
                    {tag.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
    </li>
  );
}

export interface SmartCollectionBuilderProps {
  catalog: TagCatalogItem[];
  /** Set when editing an existing collection rather than creating one. */
  editing?: SmartCollectionItem | null;
  /** Evaluates a draft without saving; returns the ids it currently matches. */
  onPreview: (query: SmartCollectionQuery) => Promise<{ documentIds: string[]; total: number }>;
  onSave: (name: string, query: SmartCollectionQuery) => Promise<void> | void;
  onCancel?: () => void;
  error?: string | null;
}

/**
 * The collection builder.
 *
 * Every draft is assembled through the domain grammar before it can be previewed
 * or saved, so the builder cannot offer a query the API would reject. The preview
 * is an explicit action rather than a keystroke-triggered fetch: each preview
 * evaluates against live data, and firing one per character would turn typing
 * into a query storm.
 */
export function SmartCollectionBuilder({
  catalog,
  editing = null,
  onPreview,
  onSave,
  onCancel,
  error = null,
}: SmartCollectionBuilderProps) {
  const [name, setName] = useState(editing?.name ?? "");
  const [mode, setMode] = useState<"all" | "any">(editing?.query.root.mode ?? "all");
  const [drafts, setDrafts] = useState<DraftCondition[]>([emptyDraftCondition()]);
  const [preview, setPreview] = useState<{ documentIds: string[]; total: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();

  const validation = useMemo(
    () => validateCollectionDraft(name, mode, drafts),
    [name, mode, drafts],
  );
  const query = useMemo(() => buildQuery(mode, drafts), [mode, drafts]);
  const atConditionCap = drafts.length >= L.maxConditions;

  async function runPreview() {
    if (query === null) {
      setLocalError("Add at least one complete condition.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      setPreview(await onPreview(query));
    } catch (previewError) {
      setLocalError(
        previewError instanceof Error ? previewError.message : "Preview could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!validation.ok) {
      setLocalError(validation.message);
      return;
    }
    if (query === null) {
      setLocalError("Add at least one complete condition.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onSave(name.trim(), query);
    } finally {
      setBusy(false);
    }
  }

  const message = localError ?? error;

  return (
    <form
      onSubmit={submit}
      aria-labelledby="collection-builder-title"
      className="rounded-card border border-softborder bg-white p-6 shadow-card"
    >
      <h3 id="collection-builder-title" className="text-lg font-bold text-navy">
        {editing ? `Edit “${editing.name}”` : "New smart collection"}
      </h3>
      <p className="mt-1 text-sm text-navy-soft">
        Membership is worked out from your conditions each time the collection is opened, so it stays
        current as documents change.
      </p>

      <label htmlFor={nameId} className="mt-4 block text-sm font-semibold text-navy">
        Collection name
        <input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={L.maxNameLength}
          disabled={busy}
          aria-invalid={message !== null}
          aria-describedby={message ? "collection-builder-status" : undefined}
          className="mt-2 w-full rounded-button border border-softborder px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
        />
      </label>

      <fieldset className="mt-4 border-0 p-0">
        <legend className="text-sm font-semibold text-navy">Match</legend>
        <div className="mt-2 flex gap-4">
          {(["all", "any"] as const).map((option) => (
            <label key={option} className="inline-flex items-center gap-2 text-sm text-navy-soft">
              <input
                type="radio"
                name="collection-mode"
                value={option}
                checked={mode === option}
                disabled={busy}
                onChange={() => setMode(option)}
                className="accent-primary"
              />
              {option === "all" ? "All conditions" : "Any condition"}
            </label>
          ))}
        </div>
      </fieldset>

      <ul className="mt-4 space-y-3">
        {drafts.map((draft, index) => (
          <ConditionRow
            key={index}
            draft={draft}
            index={index}
            catalog={catalog}
            busy={busy}
            onChange={(next) =>
              setDrafts((current) => current.map((item, i) => (i === index ? next : item)))
            }
            onRemove={() =>
              setDrafts((current) =>
                current.length === 1
                  ? [emptyDraftCondition()]
                  : current.filter((_, i) => i !== index),
              )
            }
          />
        ))}
      </ul>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy || atConditionCap}
        onClick={() => setDrafts((current) => [...current, emptyDraftCondition()])}
        className="mt-3"
      >
        <Plus size={14} aria-hidden="true" className="mr-1" />
        Add condition
      </Button>
      {atConditionCap && (
        <p role="status" className="mt-2 text-xs text-amber-700">
          A collection may use at most {L.maxConditions} conditions.
        </p>
      )}

      <p
        id="collection-builder-status"
        role="status"
        aria-live="polite"
        className="mt-3 flex items-center gap-1.5 text-sm text-red-700 empty:hidden"
      >
        {message && <AlertCircle size={14} aria-hidden="true" />}
        {message}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={!validation.ok}>
          {editing ? "Save collection" : "Create collection"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={runPreview}>
          <Filter size={14} aria-hidden="true" className="mr-1" />
          Preview matches
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>

      {preview && (
        <div
          aria-live="polite"
          className="mt-4 rounded-card border border-softborder bg-slate-50/60 p-4"
        >
          <p className="text-sm font-semibold text-navy">
            {preview.total === 0
              ? "No documents match yet."
              : `${preview.total} document${preview.total === 1 ? "" : "s"} match.`}
          </p>
          {preview.total >= L.maxResults && (
            <p className="mt-1 text-xs text-navy-soft">
              Showing the first {L.maxResults}; the collection may match more.
            </p>
          )}
          {preview.documentIds.length > 0 && (
            <ul className="mt-2 space-y-1">
              {preview.documentIds.slice(0, 10).map((documentId) => (
                <li
                  key={documentId}
                  className="flex items-center gap-1.5 font-mono text-xs text-navy-soft"
                >
                  <FileText size={12} aria-hidden="true" />
                  {documentId}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

export interface SmartCollectionListProps {
  collections: SmartCollectionItem[];
  loading?: boolean;
  activeId?: string | null;
  onSelect: (collection: SmartCollectionItem) => void;
  onEdit?: (collection: SmartCollectionItem) => void;
  onDelete?: (collection: SmartCollectionItem) => void;
}

/** The Workspace's saved collections. */
export function SmartCollectionList({
  collections,
  loading = false,
  activeId = null,
  onSelect,
  onEdit,
  onDelete,
}: SmartCollectionListProps) {
  if (loading) {
    return (
      <p role="status" className="text-sm text-navy-soft">
        Loading collections…
      </p>
    );
  }
  if (collections.length === 0) {
    return (
      <p className="text-sm text-navy-soft">
        No smart collections yet. Create one to group documents by a rule instead of by hand.
      </p>
    );
  }

  return (
    <ul aria-label="Smart collections" className="space-y-1">
      {collections.map((collection) => (
        <li key={collection.id} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onSelect(collection)}
            aria-current={activeId === collection.id ? "true" : undefined}
            className={cn(
              "flex flex-1 items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              activeId === collection.id
                ? "bg-primary/10 font-semibold text-navy"
                : "text-navy-soft hover:bg-slate-50",
            )}
          >
            <Filter size={14} aria-hidden="true" />
            <span className="flex-1 truncate">{collection.name}</span>
            {collection.degraded && (
              // Surfaced rather than hidden: an unreadable definition matches
              // nothing, and presenting that as an accurate empty collection
              // would be a lie the user cannot detect.
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                Needs attention
              </span>
            )}
          </button>
          {onEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEdit(collection)}
              aria-label={`Edit collection ${collection.name}`}
            >
              <Pencil size={14} aria-hidden="true" />
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onDelete(collection)}
              aria-label={`Delete collection ${collection.name}`}
            >
              <Trash2 size={14} aria-hidden="true" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface SmartCollectionResultsProps {
  collection: SmartCollectionItem | null;
  documentIds: string[];
  total: number;
  loading?: boolean;
  error?: string | null;
  /** Resolves an id to a display name when the caller has the records loaded. */
  nameFor?: (documentId: string) => string | undefined;
}

/** The documents a selected collection currently matches. */
export function SmartCollectionResults({
  collection,
  documentIds,
  total,
  loading = false,
  error = null,
  nameFor,
}: SmartCollectionResultsProps) {
  if (collection === null) {
    return (
      <p className="text-sm text-navy-soft">Choose a collection to see what it matches.</p>
    );
  }

  return (
    <section aria-labelledby="collection-results-title" className="space-y-3">
      <h3 id="collection-results-title" className="text-base font-bold text-navy">
        {collection.name}
      </h3>

      {collection.degraded && (
        <p
          role="status"
          className="flex items-center gap-1.5 rounded-card bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <AlertCircle size={14} aria-hidden="true" />
          This collection’s rule could not be read, so it matches nothing. Edit it to rebuild the
          rule.
        </p>
      )}

      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-red-700">
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </p>
      )}

      {loading ? (
        <p role="status" className="text-sm text-navy-soft">
          Working out what matches…
        </p>
      ) : documentIds.length === 0 ? (
        <p className="text-sm text-navy-soft">
          Nothing matches right now. Documents will appear here as soon as they meet the rule.
        </p>
      ) : (
        <>
          <p className="text-sm text-navy-soft">
            {total} document{total === 1 ? "" : "s"} match.
          </p>
          <ul className="divide-y divide-softborder/70">
            {documentIds.map((documentId) => (
              <li key={documentId} className="flex items-center gap-2 py-2 text-sm text-navy">
                <FileText size={14} aria-hidden="true" className="text-navy-soft" />
                <span className="truncate">{nameFor?.(documentId) ?? documentId}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
