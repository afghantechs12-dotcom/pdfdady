import { beforeEach, describe, expect, it } from "vitest";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { toCommentMessageResponse, withCommentAuthors, withThreadAuthors } from "./commentHttp";
import type { CommentMessage } from "@/src/domain/entities/Collaboration";

/**
 * Comment authors must render as PEOPLE, not as database ids.
 *
 * The defect: `CommentsPanel` rendered `authorName ?? authorId`, and no comments
 * endpoint ever returned an `authorName` — so every comment was attributed to a
 * raw cuid. The fix resolves identities server-side, reusing
 * `memberDirectory`'s existing precedent (name → email → `Unknown user · {id}`)
 * rather than inventing a second display rule.
 *
 * The batching assertion is the important one: the natural-but-wrong
 * implementation looks up each message's author individually, so a 30-message
 * thread issues 30 queries. A counting stub is the only way to state "one query"
 * as a test rather than as a hope.
 */

/**
 * A single mutable Prisma stub, registered ONCE.
 *
 * The container caches singletons (`resolve` memoizes), so re-registering the
 * token per test silently keeps the first stub — an earlier version of this file
 * did exactly that and half its assertions were reading a stale fixture. One
 * stub whose behaviour is reassigned per test is the honest shape.
 */
interface FindManyCall {
  ids: string[];
  select: Record<string, boolean>;
}
let calls: FindManyCall[] = [];
let rows: Array<{ id: string; email: string | null; name: string | null }> = [];
let failing = false;

appContainer.register(Tokens.PrismaClient, () => ({
  user: {
    findMany: async (args: any) => {
      if (failing) throw new Error("db down");
      calls.push({ ids: args.where.id.in, select: args.select });
      return rows.filter((r) => args.where.id.in.includes(r.id));
    },
  },
}) as any);

function stubUsers(next: Array<{ id: string; email: string | null; name: string | null }>) {
  rows = next;
  failing = false;
  calls = [];
  return calls;
}

function msg(id: string, authorId: string): CommentMessage {
  const now = new Date("2026-08-17T10:00:00.000Z");
  return {
    id,
    organizationId: "org-1",
    workspaceId: "ws-1",
    threadId: "th-1",
    documentId: "doc-1",
    authorId,
    parentMessageId: null,
    body: "hello",
    editedAt: null,
    deletedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  } as CommentMessage;
}

const serialized = (id: string, authorId: string) => toCommentMessageResponse(msg(id, authorId));

describe("withCommentAuthors", () => {
  beforeEach(() => {
    // Reset the shared stub so one test's fixture cannot leak into the next.
    stubUsers([]);
  });

  it("prefers the display name", async () => {
    stubUsers([{ id: "u1", email: "ada@example.com", name: "Ada Lovelace" }]);
    const [out] = await withCommentAuthors([serialized("m1", "u1")]);
    expect(out.authorName).toBe("Ada Lovelace");
    expect(out.authorEmail).toBe("ada@example.com");
  });

  it("falls back to the email when the name is null", async () => {
    // `User.name` is nullable, which is what made this a real decision.
    stubUsers([{ id: "u1", email: "ada@example.com", name: null }]);
    const [out] = await withCommentAuthors([serialized("m1", "u1")]);
    expect(out.authorName).toBe("ada@example.com");
  });

  it("falls back to a shortened id when neither is known", async () => {
    // Never a fabricated identity, and never a full cuid in the primary UI.
    stubUsers([]);
    const [out] = await withCommentAuthors([serialized("m1", "user-abcdefghijkl")]);
    expect(out.authorName).toBe("Unknown user · user-abc");
    expect(out.authorEmail).toBeNull();
  });

  it("resolves ALL distinct authors in exactly one query", async () => {
    stubUsers([
      { id: "u1", email: "a@x.com", name: "A" },
      { id: "u2", email: "b@x.com", name: "B" },
    ]);
    const out = await withCommentAuthors([
      serialized("m1", "u1"),
      serialized("m2", "u2"),
      serialized("m3", "u1"),
      serialized("m4", "u2"),
      serialized("m5", "u1"),
    ]);
    expect(calls).toHaveLength(1);
    // Deduplicated: 5 messages, 2 distinct authors.
    expect(calls[0].ids.sort()).toEqual(["u1", "u2"]);
    expect(out.map((m) => m.authorName)).toEqual(["A", "B", "A", "B", "A"]);
  });

  it("never selects the password hash", async () => {
    stubUsers([{ id: "u1", email: "a@x.com", name: "A" }]);
    await withCommentAuthors([serialized("m1", "u1")]);
    expect(Object.keys(calls[0].select).sort()).toEqual(["email", "id", "name"]);
    expect(calls[0].select).not.toHaveProperty("passwordHash");
  });

  it("issues no query at all for an empty page", async () => {
    stubUsers([]);
    expect(await withCommentAuthors([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("degrades to ids instead of failing when the directory is unavailable", async () => {
    // A comment list that 500s because a display name could not be resolved is a
    // worse outcome than one showing ids.
    failing = true;
    const [out] = await withCommentAuthors([serialized("m1", "user-abcdefghijkl")]);
    expect(out.authorName).toBe("Unknown user · user-abc");
  });

  it("preserves every field of the original message", async () => {
    stubUsers([{ id: "u1", email: "a@x.com", name: "A" }]);
    const before = serialized("m1", "u1");
    const [after] = await withCommentAuthors([before]);
    for (const key of Object.keys(before)) {
      expect(after[key as keyof typeof after]).toEqual(before[key as keyof typeof before]);
    }
  });

  it("supplies avatar initials (H30)", async () => {
    stubUsers([{ id: "u1", email: "ada@example.com", name: "Ada Lovelace" }]);
    const [out] = await withCommentAuthors([serialized("m1", "u1")]);
    expect(out.authorInitials).toBe("AL");
  });
});

describe("withThreadAuthors", () => {
  beforeEach(() => stubUsers([]));

  it("names the thread creator with the same precedence", async () => {
    stubUsers([{ id: "u9", email: "grace@example.com", name: null }]);
    const [out] = await withThreadAuthors([{ createdById: "u9", id: "th-1" }]);
    expect(out.createdByName).toBe("grace@example.com");
    expect(out.createdByInitials).toBe("GR");
  });

  it("batches thread creators too", async () => {
    stubUsers([{ id: "u1", email: null, name: "A" }]);
    await withThreadAuthors([
      { createdById: "u1", id: "t1" },
      { createdById: "u1", id: "t2" },
      { createdById: "u1", id: "t3" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(["u1"]);
  });
});
