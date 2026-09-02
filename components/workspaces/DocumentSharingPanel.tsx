"use client";

import { useId, useState } from "react";
import { AlertCircle, ShieldOff, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  actionAnnouncement,
  canRevokeGrant,
  canSubmitGrant,
  emptyGrantDraft,
  grantRoleOptions,
  grantStatusLabel,
  validateGrantDraft,
  type GrantDraftState,
} from "./commentLogic";
import { COLLABORATION_LIMITS, type DocumentPermissionRole } from "@/src/domain/entities/Collaboration";

/** One share as the panel receives it from the API. */
export interface DocumentGrantView {
  id: string;
  granteeUserId: string;
  granteeName?: string;
  role: DocumentPermissionRole;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface DocumentSharingPanelProps {
  grants: DocumentGrantView[];
  loading?: boolean;
  error?: string | null;
  onShare: (draft: {
    granteeUserId: string;
    role: DocumentPermissionRole;
    expiresAt: string | null;
  }) => Promise<void> | void;
  onRevoke: (grant: DocumentGrantView) => Promise<void> | void;
}

/**
 * The M7.10 document sharing panel.
 *
 * Two things are deliberately explicit here. Each access level carries a
 * one-line description of what it actually permits, because "editor" alone does
 * not tell the person sharing whether the recipient can change the file. And a
 * revoked share stays listed with its revocation state rather than vanishing —
 * "who could see this, and until when" is the question this panel exists to
 * answer, and a row that disappears answers it wrongly.
 */
export function DocumentSharingPanel({
  grants,
  loading = false,
  error = null,
  onShare,
  onRevoke,
}: DocumentSharingPanelProps) {
  const [draft, setDraft] = useState<GrantDraftState>(emptyGrantDraft());
  const [localError, setLocalError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);

  const titleId = useId();
  const granteeId = useId();
  const roleId = useId();
  const expiryId = useId();

  const message = localError ?? error;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const check = validateGrantDraft(draft);
    if (!check.ok) {
      setLocalError(check.reason);
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await onShare(check.draft);
      setDraft(emptyGrantDraft());
      setAnnouncement(actionAnnouncement("shared"));
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "The share could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: DocumentGrantView) {
    setLocalError(null);
    setBusy(true);
    try {
      await onRevoke(grant);
      setAnnouncement(actionAnnouncement("revoked"));
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "The share could not be revoked.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <h2 id={titleId} className="text-base font-semibold">
        Sharing
      </h2>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {message !== null && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{message}</span>
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={granteeId} className="text-sm font-medium">
            Share with
          </label>
          <input
            id={granteeId}
            value={draft.granteeUserId}
            onChange={(event) => setDraft({ ...draft, granteeUserId: event.target.value })}
            maxLength={COLLABORATION_LIMITS.maxIdLength}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="User identifier"
          />
        </div>

        <fieldset className="flex flex-col gap-1">
          <label htmlFor={roleId} className="text-sm font-medium">
            Access level
          </label>
          <select
            id={roleId}
            value={draft.role}
            onChange={(event) => setDraft({ ...draft, role: event.target.value })}
            aria-describedby={`${roleId}-description`}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {grantRoleOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {/* What the level actually permits — "editor" alone does not say
              whether the recipient can change the file. */}
          <p id={`${roleId}-description`} className="text-xs text-muted-foreground">
            {grantRoleOptions().find((option) => option.value === draft.role)?.description ?? ""}
          </p>
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor={expiryId} className="text-sm font-medium">
            Expires
          </label>
          <input
            id={expiryId}
            type="datetime-local"
            value={draft.expiresAt}
            onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })}
            aria-describedby={`${expiryId}-hint`}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <p id={`${expiryId}-hint`} className="text-xs text-muted-foreground">
            Leave blank for no expiry. Access can be revoked at any time.
          </p>
        </div>

        <div>
          <Button type="submit" disabled={!canSubmitGrant(draft, busy)}>
            <UserPlus aria-hidden="true" className="mr-1 h-4 w-4" />
            Share
          </Button>
        </div>
      </form>

      {loading ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Loading shares…
        </p>
      ) : grants.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          This document has not been shared with anyone.
        </p>
      ) : (
        <ul role="list" className="flex flex-col gap-2">
          {grants.map((grant) => {
            const revoked = !canRevokeGrant(grant);
            return (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <span className="flex flex-col">
                  <span className="text-sm font-medium">
                    {grant.granteeName ?? grant.granteeUserId}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {grantRoleOptions().find((option) => option.value === grant.role)?.label ??
                      grant.role}
                    {" · "}
                    {grantStatusLabel(grant)}
                  </span>
                </span>
                {revoked ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ShieldOff aria-hidden="true" className="h-3 w-3" />
                    Revoked
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => revoke(grant)}
                    aria-label={`Revoke access for ${grant.granteeName ?? grant.granteeUserId}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
