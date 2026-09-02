import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { PrismaClient } from "@prisma/client";

/**
 * Resolving a person to a user id for Workspace membership.
 *
 * The settings UI used to ask an owner to type an internal database id
 * (`cmg7x2k9b0001…`) to grant access. Nobody knows another person's cuid, so in
 * practice the feature was unusable — and putting internal identifiers in front
 * of normal users is not a collaboration interface.
 *
 * What this deliberately is NOT: an invitation system. There is no invitation
 * table, no token, no email delivery, and inventing one here would mean shipping
 * a button that claims to have sent something it never sent. This resolves an
 * email to a user who *already exists and is already in the Organization*, which
 * is exactly the set of people a Workspace membership can name today.
 *
 * The Organization constraint is the security boundary, not a convenience:
 * without it this endpoint would answer "does an account exist for this email?"
 * for any address on the internet. See {@link MEMBER_LOOKUP_FAILURE} — every
 * failure mode returns one indistinguishable result for that reason.
 */

/**
 * The single failure result. "No such account" and "not in this Organization"
 * are deliberately not distinguished: telling them apart would turn an
 * owner-authenticated form into an account-existence oracle.
 */
export const MEMBER_LOOKUP_FAILURE =
  "No member of this organization has that email address. They need an account here first.";

export type MemberLookup =
  | { ok: true; userId: string }
  | { ok: false; message: string };

/** A syntactic check only — the authority is whether the lookup resolves. */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * Resolves an email address to the id of a user in `organizationId`.
 *
 * Returns the same failure for an unknown address, a known address outside the
 * Organization, and an identity provider that cannot look up by email (Clerk
 * throws NOT_IMPLEMENTED) — the caller must not be able to tell which.
 */
export async function resolveOrganizationMemberByEmail(
  email: string,
  organizationId: string,
): Promise<MemberLookup> {
  if (!looksLikeEmail(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }

  let userId: string | null;
  try {
    const users = appContainer.resolve<IUserProvider>(Tokens.UserProvider);
    const user = await users.getByEmail(email.trim());
    userId = user?.id ?? null;
  } catch {
    // A provider that cannot resolve emails (Clerk) is indistinguishable from
    // "not found" here, on purpose.
    return { ok: false, message: MEMBER_LOOKUP_FAILURE };
  }

  if (userId === null) return { ok: false, message: MEMBER_LOOKUP_FAILURE };

  const organizations = appContainer.resolve<IOrganizationProvider>(Tokens.OrganizationProvider);
  const membership = await organizations.getMembership(organizationId, userId);
  if (!membership) return { ok: false, message: MEMBER_LOOKUP_FAILURE };

  return { ok: true, userId };
}

/** A member row decorated with the identity fields the UI actually shows. */
export interface MemberIdentity {
  userId: string;
  email: string | null;
  name: string | null;
}

/**
 * Looks up display identities for a page of members, in one query.
 *
 * Read directly through Prisma rather than N calls to `IUserProvider.getById`:
 * a 25-row member list would otherwise issue 25 sequential queries. Only the
 * three display fields are selected — never `passwordHash`.
 *
 * Best-effort: if the lookup fails the caller still renders the list, just
 * without names. A settings page that 500s because a display name could not be
 * resolved would be a worse outcome than one showing ids.
 */
export async function memberIdentities(userIds: string[]): Promise<Map<string, MemberIdentity>> {
  const unique = Array.from(new Set(userIds)).filter((id) => id.length > 0);
  const out = new Map<string, MemberIdentity>();
  if (unique.length === 0) return out;

  try {
    const prisma = appContainer.resolve<PrismaClient>(Tokens.PrismaClient);
    const users = await prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true, name: true },
    });
    for (const user of users) {
      out.set(user.id, { userId: user.id, email: user.email, name: user.name });
    }
  } catch {
    // Fall through to an empty map — the caller degrades to ids.
  }
  return out;
}

/**
 * What to show for a member: display name, else email, else a shortened id.
 *
 * The id fallback keeps a row meaningful when a membership outlives the user
 * record it points at, without putting a full cuid in the primary UI.
 */
export function memberDisplayName(identity: MemberIdentity | undefined, userId: string): string {
  const name = identity?.name?.trim();
  if (name) return name;
  const email = identity?.email?.trim();
  if (email) return email;
  return `Unknown user · ${userId.slice(0, 8)}`;
}

/**
 * Attaches display identities to a page of rows keyed by `createdById`, in one query.
 *
 * Extracted so every surface that names the person behind a row — comment
 * threads, version history — resolves them the same way. Two copies of this loop
 * would eventually disagree about the fallback order, and "who wrote this" is not
 * a question a product should answer differently in two panels.
 *
 * One batched {@link memberIdentities} call, then a pure decorate: a 25-row
 * version list issues one query, not 25. Best-effort by inheritance — a directory
 * outage degrades to the shortened-id fallback instead of failing the list.
 *
 * TENANT SAFETY: only ids already present on rows the caller was authorized to
 * read are looked up, so this cannot probe for users outside the caller's scope.
 */
export async function withCreatedByIdentities<T extends { createdById: string }>(
  rows: T[],
): Promise<Array<T & { createdByName: string; createdByInitials: string }>> {
  const identities = await memberIdentities(rows.map((row) => row.createdById));
  return rows.map((row) => {
    const identity = identities.get(row.createdById);
    return {
      ...row,
      createdByName: memberDisplayName(identity, row.createdById),
      createdByInitials: memberInitials(identity, row.createdById),
    };
  });
}

/** Initials for the member avatar. Mirrors the shell's avatar treatment. */
export function memberInitials(identity: MemberIdentity | undefined, userId: string): string {
  const source = (identity?.name ?? identity?.email ?? "").trim();
  if (source === "") return userId.slice(0, 2).toUpperCase();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}
