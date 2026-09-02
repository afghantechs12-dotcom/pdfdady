"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FolderPlus, FolderKanban, PenTool, Plus, Upload } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { availableNewActions, type NewMenuAction } from "./dashboardLogic";

const ICONS: Record<string, typeof Upload> = {
  upload: Upload,
  folder: FolderPlus,
  project: FolderKanban,
  editor: PenTool,
};

export interface NewMenuProps {
  workspaceId: string;
  organizationId: string;
  canWrite: boolean;
  /** Notifies the page that content changed, so it can refresh its lists. */
  onChanged?: () => void;
}

/**
 * The Workspace "New" split button.
 *
 * Every entry performs a real operation against an endpoint that exists:
 * upload posts to the ingestion route, folder and project create through their
 * services, and the editor entry navigates to the editor. `availableNewActions`
 * filters by role so a viewer is not offered writes the server would reject —
 * the API re-checks regardless, since a client-side filter is a convenience,
 * not an authorization boundary.
 *
 * The menu is keyboard-operable: arrows move, Escape closes and returns focus
 * to the trigger, and an outside pointer press dismisses it.
 */
export function NewMenu({ workspaceId, organizationId, canWrite, onChanged }: NewMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dialog, setDialog] = useState<"folder" | "project" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const router = useRouter();

  const actions = availableNewActions(canWrite);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  function runAction(action: NewMenuAction) {
    setOpen(false);
    switch (action.id) {
      case "upload":
        fileInputRef.current?.click();
        break;
      case "folder":
        setDialog("folder");
        break;
      case "project":
        setDialog("project");
        break;
      case "editor":
        router.push("/editor");
        break;
    }
  }

  async function onFilesPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    setUploading(true);
    setStatus(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
    let failed = 0;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("organizationId", organizationId);
      form.append("name", file.name);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/upload`,
          { method: "POST", body: form, credentials: "same-origin" },
        );
        if (!response.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setUploading(false);
    // Partial failure is reported as such rather than as blanket success.
    setStatus(
      failed === 0
        ? `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}.`
        : `${files.length - failed} of ${files.length} uploaded; ${failed} failed.`,
    );
    onChanged?.();
    router.refresh();
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
          return;
        }
        if (!open) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % actions.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + actions.length) % actions.length);
        } else if (event.key === "Enter" || event.key === " ") {
          const action = actions[activeIndex];
          if (action) {
            event.preventDefault();
            runAction(action);
          }
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={uploading}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-control bg-primary px-3 text-sm font-semibold text-white shadow-appcard transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      >
        <Plus size={16} aria-hidden="true" />
        <span>{uploading ? "Uploading…" : "New"}</span>
        <ChevronDown size={14} aria-hidden="true" className="opacity-80" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Create"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-64 overflow-hidden rounded-controllg border border-app-border bg-white py-1 shadow-appmenu"
        >
          {actions.map((action, index) => {
            const Icon = ICONS[action.icon] ?? Plus;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runAction(action)}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
                  index === activeIndex ? "bg-lavender" : "hover:bg-lavender",
                )}
              >
                <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-app-text">{action.label}</span>
                  <span className="block text-xs text-app-muted">{action.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        multiple
        className="hidden"
        aria-hidden="true"
        onChange={onFilesPicked}
      />

      {/* Upload progress and results are announced, not shown in an alert(). */}
      <p role="status" aria-live="polite" className="sr-only">
        {status ?? ""}
      </p>

      {dialog && (
        <CreateContainerDialog
          kind={dialog}
          workspaceId={workspaceId}
          organizationId={organizationId}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            onChanged?.();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** Creates a folder or a project through its real endpoint. */
function CreateContainerDialog({
  kind,
  workspaceId,
  organizationId,
  onClose,
  onCreated,
}: {
  kind: "folder" | "project";
  workspaceId: string;
  organizationId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const titleId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/${kind === "folder" ? "folders" : "projects"}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, name: name.trim() }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // The server's wording is kept: it knows things the client cannot, such
        // as a name colliding with one created a moment ago.
        throw new Error(data.error?.message ?? `Could not create ${kind}.`);
      }
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not create ${kind}.`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledById={titleId}>
      <form onSubmit={submit} className="space-y-5 p-6">
        <h2 id={titleId} className="text-xl font-bold text-app-text">
          {kind === "folder" ? "New folder" : "New project"}
        </h2>
        <label className="block text-sm font-semibold text-app-text">
          Name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            className="mt-2 w-full rounded-control border border-app-border px-3 py-2 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </label>
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-red-600">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
