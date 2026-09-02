import { describe, expect, it } from "vitest";
import {
  toCommentMessageResponse,
  toCommentThreadResponse,
  toDocumentPermissionGrantResponse,
} from "./commentHttp";
import { requireSameOrigin } from "./workspaceCsrf";
import type {
  CommentMessage,
  CommentThread,
  DocumentPermissionGrant,
} from "@/src/domain/entities/Collaboration";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "th-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    anchorType: "page",
    anchor: { type: "page", pageNumber: 4 },
    anchorSchemaVersion: 1,
    pageNumber: 4,
    status: "open",
    createdById: "user-1",
    resolvedById: null,
    resolvedAt: null,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function message(overrides: Partial<CommentMessage> = {}): CommentMessage {
  return {
    id: "msg-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    threadId: "th-1",
    documentId: "doc-1",
    authorId: "user-1",
    parentMessageId: null,
    body: "hello",
    revision: 1,
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function grant(overrides: Partial<DocumentPermissionGrant> = {}): DocumentPermissionGrant {
  return {
    id: "gr-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    documentId: "doc-1",
    granteeUserId: "user-2",
    role: "commenter",
    grantedById: "user-1",
    expiresAt: null,
    revokedAt: null,
    revokedById: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Comment thread serialization", () => {
  it("emits the anchor as structure plus a readable label", () => {
    const body = toCommentThreadResponse(thread());
    expect(body.anchor).toEqual({ type: "page", pageNumber: 4 });
    expect(body.anchorLabel).toBe("Page 4");
    expect(body.pageNumber).toBe(4);
  });

  it("does not leak the organization id", () => {
    // A tenant handle the client already knows from its session; echoing it on
    // every row only widens what a mis-scoped response could disclose.
    const body = toCommentThreadResponse(thread());
    expect(Object.keys(body)).not.toContain("organizationId");
    expect(JSON.stringify(body)).not.toContain("org-secret");
  });

  it("serializes timestamps as ISO strings", () => {
    const body = toCommentThreadResponse(
      thread({ resolvedAt: NOW, resolvedById: "user-9", status: "resolved" }),
    );
    expect(body.createdAt).toBe(NOW.toISOString());
    expect(body.resolvedAt).toBe(NOW.toISOString());
    expect(body.status).toBe("resolved");
  });

  it("reports staleness only when told", () => {
    expect(toCommentThreadResponse(thread()).stale).toBe(false);
    expect(toCommentThreadResponse(thread(), true).stale).toBe(true);
  });

  it("carries the revision a client needs for a conditional mutation", () => {
    expect(toCommentThreadResponse(thread()).revision).toBe(2);
  });
});

describe("Comment message serialization", () => {
  it("emits the body verbatim, never escaped", () => {
    // Escaping here would double-escape at render: the client emits a text node.
    const payload = "<script>alert(1)</script>";
    const body = toCommentMessageResponse(message({ body: payload }));
    expect(body.body).toBe(payload);
    expect(body.body).not.toContain("&lt;");
  });

  it("omits the body of a deleted message and marks it deleted", () => {
    const body = toCommentMessageResponse(
      message({ body: "leftover", deletedAt: NOW, deletedById: "user-2" }),
    );
    expect(body.deleted).toBe(true);
    expect(body.body).toBe("");
  });

  it("marks an edited message", () => {
    expect(toCommentMessageResponse(message()).edited).toBe(false);
    const edited = toCommentMessageResponse(message({ editedAt: NOW }));
    expect(edited.edited).toBe(true);
    expect(edited.editedAt).toBe(NOW.toISOString());
  });

  it("does not leak the organization id", () => {
    const body = toCommentMessageResponse(message());
    expect(Object.keys(body)).not.toContain("organizationId");
  });

  it("preserves the reply link", () => {
    expect(toCommentMessageResponse(message({ parentMessageId: "msg-0" })).parentMessageId).toBe(
      "msg-0",
    );
  });
});

describe("Permission grant serialization", () => {
  it("computes activity server-side rather than leaving it to the client", () => {
    // A client deciding for itself would show a share as live for as long as its
    // own clock was wrong.
    const active = toDocumentPermissionGrantResponse(grant(), NOW);
    expect(active.active).toBe(true);
    expect(active.expired).toBe(false);
  });

  it("reports an expired grant as inactive", () => {
    const body = toDocumentPermissionGrantResponse(
      grant({ expiresAt: new Date(NOW.getTime() - 1) }),
      NOW,
    );
    expect(body.expired).toBe(true);
    expect(body.active).toBe(false);
  });

  it("reports a revoked grant as inactive", () => {
    const body = toDocumentPermissionGrantResponse(grant({ revokedAt: NOW, revokedById: "u" }), NOW);
    expect(body.active).toBe(false);
    expect(body.revokedAt).toBe(NOW.toISOString());
  });

  it("treats the expiry instant itself as expired", () => {
    const body = toDocumentPermissionGrantResponse(grant({ expiresAt: NOW }), NOW);
    expect(body.expired).toBe(true);
  });

  it("does not leak the organization id", () => {
    const body = toDocumentPermissionGrantResponse(grant(), NOW);
    expect(Object.keys(body)).not.toContain("organizationId");
  });
});

/**
 * CSRF coverage for the M7.10 mutation surface.
 *
 * Every new state-changing route calls `requireSameOrigin` before it does
 * anything else. These cases assert the rule holds for each of those URL shapes,
 * including the nested message and grant paths where a missed call would be
 * easiest to overlook.
 */
describe("M7.10 mutation routes — same-origin enforcement", () => {
  const ORIGIN = "https://app.example.com";
  const paths = [
    "/api/workspaces/ws-1/documents/doc-1/comments",
    "/api/workspaces/ws-1/documents/doc-1/comments/th-1/messages",
    "/api/workspaces/ws-1/documents/doc-1/comments/th-1/messages/msg-1",
    "/api/workspaces/ws-1/documents/doc-1/comments/th-1/resolve",
    "/api/workspaces/ws-1/documents/doc-1/comments/th-1/reopen",
    "/api/workspaces/ws-1/documents/doc-1/permissions",
    "/api/workspaces/ws-1/documents/doc-1/permissions/gr-1",
  ];

  it("allows a same-origin mutation on every route", () => {
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { origin: ORIGIN },
      });
      expect(requireSameOrigin(request)).toBeNull();
    }
  });

  it("rejects a cross-origin mutation on every route", () => {
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { origin: "https://evil.test" },
      });
      expect(requireSameOrigin(request)?.status).toBe(403);
    }
  });

  it("rejects a mutation with no origin evidence at all", () => {
    // An authenticated session must not bypass the check.
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, { method: "DELETE" });
      expect(requireSameOrigin(request)?.status).toBe(403);
    }
  });

  it("accepts a same-origin referer when origin is absent", () => {
    const request = new Request(`${ORIGIN}${paths[0]}`, {
      method: "POST",
      headers: { referer: `${ORIGIN}/workspaces/ws-1` },
    });
    expect(requireSameOrigin(request)).toBeNull();
  });
});
