"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { AppCard, SectionHeader, StatusBadge } from "@/components/app/primitives";

export interface WorkspaceMemberRow {
  id: string;
  userId: string;
  role: string;
  revision: number;
  revokedAt: string | null;
  /** Resolved server-side; null when the user record could not be read. */
  email: string | null;
  name: string | null;
}

export interface WorkspaceMembersProps {
  workspaceId: string;
  organizationId: string;
  initial: WorkspaceMemberRow[];
  /**
   * Whether this actor may add members. Only an owner (or an Organization
   * admin) passes `WorkspaceMembershipService.add`; everyone else who can read
   * the list gets the list without the form.
   */
  canManage?: boolean;
}

const FIELD_CLASS =
  "mt-1.5 w-full rounded-control border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text transition-colors focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
const LABEL_CLASS = "block text-[13px] font-semibold text-app-text";

const ROLES = [
  { value: "viewer", label: "Viewer", hint: "Can open and read documents" },
  { value: "commenter", label: "Commenter", hint: "Can read and comment" },
  { value: "editor", label: "Editor", hint: "Can edit documents" },
  { value: "owner", label: "Owner", hint: "Full control, including members" },
] as const;

/** Display name: real name, then email, then a shortened id. */
function displayName(member: WorkspaceMemberRow): string {
  return member.name?.trim() || member.email?.trim() || `Unknown user · ${member.userId.slice(0, 8)}`;
}

function initials(member: WorkspaceMemberRow): string {
  const source = (member.name ?? member.email ?? "").trim();
  if (source === "") return member.userId.slice(0, 2).toUpperCase();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * The Workspace member list, with an add form for owners.
 *
 * Members are named by email, not by internal user id. The id is the domain's
 * key and still travels on the wire in the response, but it is not something a
 * person should ever have to know, type, or read — so it appears nowhere in
 * this UI except as a last-resort fallback when the user record is missing.
 */
export function WorkspaceMembers({
  workspaceId,
  organizationId,
  initial,
  canManage = false,
}: WorkspaceMembersProps) {
  const [members, setMembers] = useState<WorkspaceMemberRow[]>(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, email: email.trim(), role }),
        },
      );
      const data = await response.json().catch(() => null);
      if (response.ok && data?.membership) {
        const added = data.membership as {
          id: string;
          userId: string;
          role: string;
          revision: number;
          revokedAt: string | null;
        };
        const addedEmail = email.trim();
        setMembers((current) => [
          {
            id: added.id,
            userId: added.userId,
            role: added.role,
            revision: added.revision,
            revokedAt: added.revokedAt ?? null,
            // The response carries the membership, not the identity; the email
            // just entered is the accurate label until the next page load.
            email: addedEmail,
            name: current.find((item) => item.userId === added.userId)?.name ?? null,
          },
          ...current.filter((item) => item.id !== added.id),
        ]);
        setEmail("");
        setStatus({ tone: "ok", message: `${addedEmail} now has ${added.role} access.` });
      } else {
        setStatus({
          tone: "error",
          message: data?.error?.message ?? "Member update failed.",
        });
      }
    } catch {
      setStatus({
        tone: "error",
        message: "Member update failed. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppCard as="section" className="p-0">
      <div className="border-b border-app-border px-4 py-3">
        <SectionHeader
          title="Members"
          subtitle={
            canManage
              ? "Give someone in your organization access to this Workspace."
              : "You can view members but not change them."
          }
        />
      </div>

      {canManage && (
        <form onSubmit={add} className="grid gap-3 border-b border-app-border p-4 sm:grid-cols-[1fr_auto]">
          <label className={LABEL_CLASS}>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="name@example.com"
              className={FIELD_CLASS}
            />
          </label>
          <label className={LABEL_CLASS}>
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className={FIELD_CLASS}
            >
              {ROLES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <p className="text-[12px] leading-relaxed text-app-muted">
              {ROLES.find((item) => item.value === role)?.hint}. They must already
              have a PDFDadi account in your organization — this grants access, it
              does not send an invitation email.
            </p>
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-control bg-primary px-3.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <UserPlus size={15} aria-hidden="true" />
              {busy ? "Adding…" : "Add member"}
            </button>
            <p
              role="status"
              aria-live="polite"
              className={`text-[13px] ${
                status?.tone === "error" ? "text-red-600" : "text-app-muted"
              }`}
            >
              {status?.message ?? ""}
            </p>
          </div>
        </form>
      )}

      {members.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-app-muted">
          No explicit members. Access comes from Organization roles.
        </p>
      ) : (
        <ul className="divide-y divide-app-border">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-bold text-primary"
              >
                {initials(member)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-app-text">
                  {displayName(member)}
                </span>
                {member.email && member.name ? (
                  <span className="block truncate text-[12px] text-app-muted">
                    {member.email}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[12px] font-semibold capitalize text-app-muted">
                {member.role}
              </span>
              <StatusBadge tone={member.revokedAt ? "neutral" : "success"}>
                {member.revokedAt ? "Revoked" : "Active"}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </AppCard>
  );
}
