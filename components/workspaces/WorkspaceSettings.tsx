"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { AppCard, SectionHeader } from "@/components/app/primitives";

export interface WorkspaceSettingsProps {
  workspace: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    revision: number;
    lifecycleState: string;
  };
  organizationId: string;
  /**
   * Whether this actor may edit. The server re-checks on PATCH — this only
   * decides whether to render an editable form or a read-only one, so a viewer
   * is not handed controls whose every use will be rejected.
   */
  canEdit?: boolean;
}

const FIELD_CLASS =
  "mt-1.5 w-full rounded-control border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text transition-colors placeholder:text-app-muted focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:bg-app-subtle disabled:text-app-muted";
const LABEL_CLASS = "block text-[13px] font-semibold text-app-text";

/** Workspace name, slug and description. */
export function WorkspaceSettings({
  workspace,
  organizationId,
  canEdit = true,
}: WorkspaceSettingsProps) {
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [description, setDescription] = useState(workspace.description ?? "");
  // The optimistic-concurrency token. It advances on every accepted write, so a
  // second save in the same session must send the value the server returned
  // rather than the one this page was rendered with — otherwise the second save
  // is rejected as stale.
  const [revision, setRevision] = useState(workspace.revision);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, name, slug, description, revision }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        if (typeof data?.workspace?.revision === "number") setRevision(data.workspace.revision);
        setStatus("Settings saved.");
      } else {
        setStatus(data?.error?.message ?? "Save failed.");
      }
    } catch {
      setStatus("Save failed. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppCard as="section" className="p-0">
      <div className="border-b border-app-border px-4 py-3">
        <SectionHeader
          title="Workspace settings"
          subtitle={canEdit ? "Name, URL slug and description." : "Read-only for your role."}
        />
      </div>

      <form onSubmit={save} className="space-y-4 p-4">
        <label className={LABEL_CLASS}>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!canEdit}
            maxLength={120}
            className={FIELD_CLASS}
          />
        </label>

        <label className={LABEL_CLASS}>
          Slug
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            disabled={!canEdit}
            maxLength={80}
            className={FIELD_CLASS}
          />
        </label>

        <label className={LABEL_CLASS}>
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!canEdit}
            rows={4}
            maxLength={2000}
            className={FIELD_CLASS}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          {canEdit && (
            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-control bg-primary px-3.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <Save size={15} aria-hidden="true" />
              {saving ? "Saving…" : "Save settings"}
            </button>
          )}
          <p role="status" aria-live="polite" className="text-[13px] text-app-muted">
            {status}
          </p>
        </div>
      </form>
    </AppCard>
  );
}
