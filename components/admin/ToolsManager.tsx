"use client";

import { useState } from "react";
import { Plus, X, Trash2, Search } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/admin/Card";
import { Modal } from "@/components/ui/Modal";
import {
  Field,
  inputClass,
  SaveButton,
  textareaClass,
} from "@/components/admin/SaveStatus";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";
import {
  iconToneClasses,
  type IconTone,
} from "@/styles/tokens";
import type { Tool, ToolCategory, ToolStatus } from "@/data/tools";
import { useRouter } from "next/navigation";

const CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: "organize", label: "Organize PDF" },
  { id: "optimize", label: "Optimize PDF" },
  { id: "convert-to", label: "Convert to PDF" },
  { id: "convert-from", label: "Convert from PDF" },
  { id: "edit", label: "Edit PDF" },
  { id: "security", label: "PDF Security" },
  { id: "ai", label: "AI PDF Tools" },
];

const STATUSES: { id: ToolStatus; label: string; help: string }[] = [
  { id: "functional-client", label: "Functional (browser)", help: "Runs in the user's browser." },
  { id: "functional-server", label: "Functional (server)", help: "Runs through a server API route." },
  { id: "planned", label: "Planned", help: "Not yet built — explain why in the reason field." },
  { id: "coming-soon-ai", label: "Coming Soon (AI)", help: "Demo / waitlist only." },
];

const TONES: IconTone[] = ["purple", "blue", "green", "orange", "pink", "teal", "red"];

/**
 * The tools manager: editorial content for the tools the code implements.
 *
 * There is no "New tool" control, and the removal was not cosmetic. A tool
 * identity is created by implementing one — a registry row, a route, a processor
 * — and the store cannot supply any of that. A record created here used to be
 * listed in the public catalog and counted in "32 tools ready" while its route
 * 404d and the job API refused it, so the one thing the button reliably produced
 * was a public number that no longer matched the product. `/api/admin/tools`
 * refuses an unknown identity now, so a button here would only surface that
 * refusal as an error toast.
 */
export function ToolsManager({
  initial,
  categories,
  orphans = [],
}: {
  initial: Tool[];
  categories: { id: string; label: string; tabLabel: string }[];
  /** Stored records whose slug the code does not implement. Normally empty. */
  orphans?: { slug: string; name?: string; status?: string }[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Tool | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const filtered = initial.filter((t) => {
    if (filter !== "all" && t.category !== filter) return false;
    if (query && !`${t.slug} ${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <Card
        title={`Tools (${initial.length})`}
        description="Editorial content for the tools this build implements: name, description, icon, category and accepted types. Which tools exist, whether each one is available and where it runs are owned by the code — they cannot be added, removed or changed here."
        status={status}
        errorMessage={error ?? undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-navy-soft/60"
            />
            <input
              className={inputClass() + " pl-8"}
              placeholder="Search by slug, name or description"
              aria-label="Search tools"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className={inputClass() + " max-w-[220px]"}
            aria-label="Filter tools by category"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <ul className="mt-5 divide-y divide-softborder overflow-hidden rounded-xl border border-softborder bg-white">
          {filtered.map((t) => {
            const cat = categories.find((c) => c.id === t.category);
            return (
              <li
                key={t.slug}
                className="flex items-center gap-3 px-3 py-3 hover:bg-lavender/40"
              >
                <span
                  className={cn(
                    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    iconToneClasses[t.iconTone],
                  )}
                >
                  <ToolIcon name={t.icon} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-navy">{t.name}</span>
                    <span className="font-mono text-xs text-navy-soft">
                      /{t.slug}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-navy-soft">
                    <span>{cat?.label ?? t.category}</span>
                    <span aria-hidden>·</span>
                    <StatusPill status={t.status} />
                  </div>
                </div>
                <Link
                  href={`/tools/${t.slug}`}
                  target="_blank"
                  className="hidden rounded-button border border-softborder bg-white px-2.5 py-1 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary sm:inline-flex"
                >
                  View ↗
                </Link>
                <button
                  type="button"
                  onClick={() => setEdit(t)}
                  className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
                >
                  Edit
                </button>
              </li>
            );
          })}
          {!filtered.length && (
            <li className="px-3 py-8 text-center text-sm text-navy-soft">
              No tools match your filters.
            </li>
          )}
        </ul>
      </Card>

      <Modal
        open={edit !== null}
        onClose={() => setEdit(null)}
        ariaLabel={edit ? `Edit ${edit.name}` : "Edit tool"}
        sizeClassName="max-w-2xl"
      >
        {edit && (
          <ToolEditor
            initial={edit}
            onClose={() => setEdit(null)}
            onSaved={() => {
              setEdit(null);
              setStatus("saved");
              router.refresh();
              setTimeout(() => setStatus("idle"), 1500);
            }}
            onStatus={setStatus}
            onError={setError}
          />
        )}
      </Modal>

      {orphans.length > 0 && <OrphanRecords records={orphans} />}

      {status === "saved" && !edit && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          Saved successfully.
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ToolStatus }) {
  const tone =
    status === "functional-client"
      ? "bg-green-50 text-green-700"
      : status === "functional-server"
      ? "bg-blue-50 text-blue-700"
      : status === "coming-soon-ai"
      ? "bg-pink-50 text-pink-700"
      : "bg-lavender text-navy-soft";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        tone,
      )}
    >
      {status === "functional-client"
        ? "Client"
        : status === "functional-server"
        ? "Server"
        : status === "coming-soon-ai"
        ? "AI Soon"
        : "Planned"}
    </span>
  );
}

function ToolIcon({ name }: { name: string }) {
  // Resolved through the same name-string pattern used in /components/ui/Icon,
  // which falls back to a square if the lucide name is missing.
  return <Icon name={name} size={16} strokeWidth={2.1} />;
}

/** Editor for one tool the code implements. There is no create mode. */
function ToolEditor({
  initial,
  onClose,
  onSaved,
  onStatus,
  onError,
}: {
  initial: Tool;
  onClose: () => void;
  onSaved: () => void;
  onStatus: (s: "idle" | "saving" | "saved" | "error") => void;
  onError: (e: string | null) => void;
}) {
  const [data, setData] = useState<Tool & { plannedReason?: string }>(initial);
  const [mimeDraft, setMimeDraft] = useState("");
  const [busy, setBusy] = useState(false);

  function patch<K extends keyof Tool>(k: K, v: Tool[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onStatus("saving");
    onError(null);
    try {
      const res = await fetch(`/api/admin/tools/${data.slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        onError(j.error ?? "Failed");
        onStatus("error");
        return;
      }
      onSaved();
    } catch {
      onError("Network error");
      onStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete "${initial.name}" override? This resets it to defaults.`)) return;
    setBusy(true);
    onStatus("saving");
    try {
      const res = await fetch(`/api/admin/tools/${initial.slug}`, {
        method: "DELETE",
      });
      if (res.ok) onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`Edit ${initial.name}`}
      description="Editorial fields overwrite the matching default in /data/tools.ts while the override is set. Availability and where the tool runs are read from the code and cannot be changed here."
      toolbar={
        <button
          type="button"
          onClick={onClose}
          aria-label="Close editor"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender"
        >
          <X size={16} />
        </button>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Slug" hint="kebab-case · used in /tools/[slug]">
            <input
              className={inputClass()}
              required
              pattern="[a-z0-9-]+"
              value={data.slug}
              disabled
              readOnly
            />
          </Field>
          <Field label="Name">
            <input
              className={inputClass()}
              required
              value={data.name}
              onChange={(e) => patch("name", e.target.value)}
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <textarea
              className={textareaClass() + " min-h-[80px]"}
              required
              value={data.description}
              onChange={(e) => patch("description", e.target.value)}
            />
          </Field>
          <Field label="Icon" hint="Lucide icon name">
            <input
              className={inputClass()}
              required
              value={data.icon}
              onChange={(e) => patch("icon", e.target.value)}
            />
          </Field>
          <Field label="Icon tone">
            <select
              className={inputClass()}
              value={data.iconTone}
              onChange={(e) => patch("iconTone", e.target.value as IconTone)}
            >
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              className={inputClass()}
              value={data.category}
              onChange={(e) => patch("category", e.target.value as ToolCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {/*
            Read-only, unconditionally. Every tool listed here is one the code
            implements, and the public merge takes `status` from the registry for
            exactly those (see data/admin/index.ts). An editable control would be
            a lever attached to nothing — worse than absent, because an admin
            would believe they had taken a tool offline while the catalog badge,
            the route and the job API all still said it works.
          */}
          <Field
            label="Status"
            hint="Set by the code that implements this tool. Not editable here."
          >
            <p className={inputClass("bg-lavender/30 text-navy-soft")}>
              {STATUSES.find((s) => s.id === data.status)?.label ?? data.status}
            </p>
          </Field>
          <Field label="Accept MIME types" className="sm:col-span-2">
            <ul className="space-y-2">
              {data.accept.map((m, i) => (
                <li key={i} className="flex items-center gap-2">
                  <code className="flex-1 rounded-button border border-softborder bg-white px-3 py-2 font-mono text-xs">
                    {m}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      patch(
                        "accept",
                        data.accept.filter((_, idx) => idx !== i),
                      )
                    }
                    aria-label="Remove MIME type"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <input
                className={inputClass()}
                placeholder="application/pdf"
                aria-label="Add a MIME type"
                value={mimeDraft}
                onChange={(e) => setMimeDraft(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const v = mimeDraft.trim();
                  if (!v) return;
                  patch("accept", [...data.accept, v]);
                  setMimeDraft("");
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
              >
                <Plus size={13} />
                Add
              </button>
            </div>
          </Field>
          <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
            <input
              type="checkbox"
              checked={data.multiple}
              onChange={(e) => patch("multiple", e.target.checked)}
            />
            Accepts multiple files
          </label>
          {data.status === "planned" && (
            <Field
              label="Planned reason"
              hint="Shown above the public coming-soon notice."
              className="sm:col-span-2"
            >
              <textarea
                className={textareaClass() + " min-h-[80px]"}
                value={data.plannedReason ?? ""}
                onChange={(e) =>
                  setData((d) => ({ ...d, plannedReason: e.target.value }))
                }
              />
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-softborder pt-4">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-button border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            <Trash2 size={13} />
            Reset to default
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary"
            >
              Cancel
            </button>
            <SaveButton busy={busy} status="idle" />
          </div>
        </div>
      </form>
    </Card>
  );
}

/**
 * Stored records whose slug the code does not implement.
 *
 * Normally empty. Such a record used to be a public tool; it is now inert — not
 * listed, not counted, no route, no sitemap entry — so this panel exists only so
 * an operator can see the leftover and clear it rather than wondering why an
 * entry they once created has vanished. Deleting is the store's own DELETE, which
 * is deliberately not slug-guarded so an unsupported record stays removable.
 */
function OrphanRecords({
  records,
}: {
  records: { slug: string; name?: string; status?: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function remove(slug: string) {
    if (!confirm(`Delete the stored record for "${slug}"? It is not a tool in this build.`))
      return;
    setBusy(slug);
    try {
      const res = await fetch(`/api/admin/tools/${slug}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={`Unsupported records (${records.length})`}
      description="Stored entries for slugs this build does not implement. They are not public tools: they are not listed, not counted, have no route and are refused by the processing API. Delete them, or leave them for a build that implements the slug."
    >
      <ul className="divide-y divide-softborder overflow-hidden rounded-xl border border-softborder bg-white">
        {records.map((r) => (
          <li key={r.slug} className="flex items-center gap-3 px-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-navy">{r.name ?? r.slug}</span>
                <span className="font-mono text-xs text-navy-soft">/{r.slug}</span>
              </div>
              <p className="mt-0.5 text-xs text-navy-soft">
                Stored status {r.status ?? "—"} · no implementation in this build
              </p>
            </div>
            <button
              type="button"
              onClick={() => remove(r.slug)}
              disabled={busy === r.slug}
              className="inline-flex items-center gap-1.5 rounded-button border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
            >
              <Trash2 size={13} />
              Delete record
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
