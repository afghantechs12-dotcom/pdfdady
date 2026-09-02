"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { workspaceHref } from "@/components/app/appShellLogic";

export function WorkspaceCreateDialog({ organizationId }: { organizationId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Double-submit guard. `Button loading` only swaps in a spinner, it does not
    // disable, so a second Enter or a fast double-click used to POST twice and
    // race two creations for the same name. Both the guard and `disabled` below
    // are needed: the guard covers the submit that is already in flight, and the
    // server rejects a genuine duplicate name as a conflict either way.
    if (loading) return;
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Workspace creation failed.");
      setStatus("Workspace created.");
      setOpen(false);
      // Navigate with the id the successful server create returned — never a
      // name, a slug or a position in the picker's list. That id is exactly what
      // `WorkspaceService.get` accepts, and the owner membership was written in
      // the same transaction, so this URL is already openable.
      window.location.assign(workspaceHref(data.workspace.id, organizationId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Workspace creation failed.");
      setLoading(false);
    }
    // Deliberately no `finally`: on success the browser is already navigating
    // away, and clearing `loading` there re-enabled the button underneath the
    // in-flight navigation — another way to submit twice.
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create Workspace</Button>
      <Modal open={open} onClose={() => setOpen(false)} labelledById="create-workspace-title">
        <form onSubmit={submit} className="space-y-5 p-6">
          <div>
            <h2 id="create-workspace-title" className="text-xl font-bold text-navy">
              Create Workspace
            </h2>
            <p className="mt-1 text-sm text-navy-soft">
              Create a document workspace in this organization.
            </p>
          </div>
          <label className="block text-sm font-semibold text-navy">
            Name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              disabled={loading}
              className="mt-2 w-full rounded-button border border-softborder px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            />
          </label>
          <p role="status" aria-live="polite" className="text-sm text-navy-soft">
            {status}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} disabled={loading}>
              Create
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
