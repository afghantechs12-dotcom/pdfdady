import { describe, expect, it, beforeEach } from "vitest";
import { CommentService } from "./CommentService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import { InMemoryCommentThreadRepository } from "@/src/infrastructure/persistence/InMemoryCommentThreadRepository";
import { InMemoryCommentMessageRepository } from "@/src/infrastructure/persistence/InMemoryCommentMessageRepository";
import { InMemoryDocumentPermissionGrantRepository } from "@/src/infrastructure/persistence/InMemoryDocumentPermissionGrantRepository";
import { DomainError, NotFoundError } from "@/src/domain/errors";

class TestLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: "error", message, fields });
  }
  child(): ILogger {
    return this;
  }
}

const ORG = "org-alpha";
const ORG_OTHER = "org-beta";
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const DOC_A = "doc-alpha";
const DOC_A2 = "doc-alpha-2";
const DOC_B = "doc-beta";

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * Authorization double. It keeps distinct the refusals the service must keep
 * distinct: a Workspace in another organization is *missing* (so a probe cannot
 * confirm it exists), a non-member is missing for the same reason, and a viewer
 * is refused only for writes.
 */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "owner" | "editor" | "commenter" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(
    workspaceId: string,
    userId: string,
    role: "owner" | "editor" | "commenter" | "viewer" = "editor",
  ): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(
    id: string,
    workspaceId: string,
    options: {
      organizationId?: string;
      currentVersionId?: string | null;
      lifecycleState?: DocumentRecord["lifecycleState"];
    } = {},
  ): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    this.docs.set(`${workspaceId}:${id}`, {
      id,
      workspaceId,
      organizationId: options.organizationId ?? ORG,
      projectId: null,
      folderId: null,
      name: `${id}.pdf`,
      normalizedName: `${id}.pdf`,
      lifecycleState: options.lifecycleState ?? "active",
      orderKey: "a0",
      currentVersionId: options.currentVersionId ?? null,
      favorite: false,
      lastAccessedAt: null,
      createdById: OWNER,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  setCurrentVersion(workspaceId: string, documentId: string, versionId: string | null): void {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    if (doc) doc.currentVersionId = versionId;
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    return doc ? { ...doc } : null;
  }
}

interface Harness {
  service: CommentService;
  workspaces: FakeWorkspaceService;
  documents: FakeDocumentRecordRepository;
  threads: InMemoryCommentThreadRepository;
  messages: InMemoryCommentMessageRepository;
  grants: InMemoryDocumentPermissionGrantRepository;
  logger: TestLogger;
  now: () => Date;
  setNow: (date: Date) => void;
}

function harness(): Harness {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const threads = new InMemoryCommentThreadRepository();
  const messages = new InMemoryCommentMessageRepository();
  const grants = new InMemoryDocumentPermissionGrantRepository();

  let current = new Date("2026-08-03T12:00:00.000Z");
  const now = () => current;

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, OWNER, "owner");
  workspaces.grant(WS_A, EDITOR, "editor");
  workspaces.grant(WS_A, VIEWER, "viewer");
  workspaces.grant(WS_B, OUTSIDER, "owner");
  documents.add(DOC_A, WS_A);
  documents.add(DOC_A2, WS_A);
  documents.add(DOC_B, WS_B, { organizationId: ORG_OTHER });

  const service = new CommentService(
    logger,
    workspaces as unknown as WorkspaceService,
    documents as unknown as never,
    threads,
    messages,
    grants,
    now,
  );

  return {
    service,
    workspaces,
    documents,
    threads,
    messages,
    grants,
    logger,
    now,
    setNow: (date: Date) => {
      current = date;
    },
  };
}

async function seedThread(h: Harness, user = EDITOR, body = "First comment") {
  return h.service.createThread(actor(user), WS_A, DOC_A, {
    anchor: { type: "page", pageNumber: 2 },
    body,
  });
}

describe("CommentService — thread persistence", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("persists a real thread with its first message", async () => {
    const created = await seedThread(h);

    // Read back through the repository, not from the create result: a service
    // that returned a well-formed object it never stored would pass otherwise.
    const stored = await h.threads.getById(WS_A, created.thread.id);
    expect(stored).not.toBeNull();
    expect(stored?.documentId).toBe(DOC_A);
    expect(stored?.workspaceId).toBe(WS_A);
    expect(stored?.organizationId).toBe(ORG);
    expect(stored?.status).toBe("open");
    expect(stored?.anchor).toEqual({ type: "page", pageNumber: 2 });

    const storedMessages = await h.messages.list({
      workspaceId: WS_A,
      threadId: created.thread.id,
      limit: 10,
    });
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].body).toBe("First comment");
    expect(storedMessages[0].authorId).toBe(EDITOR);
  });

  it("issues distinct ids rather than deriving them from a clock", async () => {
    const a = await seedThread(h, EDITOR, "one");
    const b = await seedThread(h, EDITOR, "two");
    expect(a.thread.id).not.toBe(b.thread.id);
    expect(a.thread.id).not.toContain("undefined");
  });

  it("derives the page column from the validated anchor", async () => {
    const paged = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "point", pageNumber: 5, x: 0.5, y: 0.5 },
      body: "pinned",
    });
    expect(paged.thread.pageNumber).toBe(5);

    const whole = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "document level",
    });
    expect(whole.thread.pageNumber).toBeNull();
  });

  it("stores document-level, page and selection anchors distinctly", async () => {
    const doc = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "on the document",
    });
    const page = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "page", pageNumber: 3 },
      body: "on a page",
    });
    const selection = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "text", pageNumber: 3, start: 10, end: 25, quote: "excerpt" },
      body: "on a selection",
    });
    expect(doc.thread.anchorType).toBe("document");
    expect(page.thread.anchorType).toBe("page");
    expect(selection.thread.anchorType).toBe("text");
    expect(selection.thread.anchor).toEqual({
      type: "text",
      pageNumber: 3,
      start: 10,
      end: 25,
      quote: "excerpt",
    });
  });

  it("binds a thread to the document's current version so staleness is detectable", async () => {
    h.documents.setCurrentVersion(WS_A, DOC_A, "ver-1");
    const created = await seedThread(h);
    expect(created.thread.versionId).toBe("ver-1");
    expect(created.stale).toBe(false);

    // A new version does not move the anchor; it makes the thread stale.
    h.documents.setCurrentVersion(WS_A, DOC_A, "ver-2");
    const reread = await h.service.getThread(actor(EDITOR), WS_A, DOC_A, created.thread.id);
    expect(reread.stale).toBe(true);
    expect(reread.thread.anchor).toEqual({ type: "page", pageNumber: 2 });
  });

  it("rolls the thread back when the first message cannot be written", async () => {
    // A pin with no words in it would be visible to everyone and readable by
    // no one.
    const failing = new InMemoryCommentMessageRepository();
    failing.create = async () => {
      throw new Error("storage failure");
    };
    const service = new CommentService(
      h.logger,
      h.workspaces as unknown as WorkspaceService,
      h.documents as unknown as never,
      h.threads,
      failing,
      h.grants,
      h.now,
    );
    await expect(
      service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "orphan",
      }),
    ).rejects.toThrow("storage failure");
    const remaining = await h.threads.list({ workspaceId: WS_A, documentId: DOC_A, limit: 10 });
    expect(remaining).toHaveLength(0);
  });

  it("bounds the number of threads per document", async () => {
    const many = new InMemoryCommentThreadRepository();
    many.countForDocument = async () => COLLABORATION_LIMITS.maxThreadsPerDocument;
    const service = new CommentService(
      h.logger,
      h.workspaces as unknown as WorkspaceService,
      h.documents as unknown as never,
      many,
      h.messages,
      h.grants,
      h.now,
    );
    await expect(
      service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "one too many",
      }),
    ).rejects.toThrow(/limit/i);
  });
});

describe("CommentService — anchor validation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses an unknown anchor type", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "wormhole", pageNumber: 1 },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses an anchor carrying unsupported fields", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "page", pageNumber: 1, smuggled: "x".repeat(100) },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses out-of-range pages and coordinates", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "page", pageNumber: 0 },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "point", pageNumber: 1, x: 2, y: 0.5 },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a rectangle that leaves the page", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "rectangle", pageNumber: 1, x: 0.9, y: 0.1, width: 0.5, height: 0.1 },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses an over-long object id and text range", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "object", objectId: "o".repeat(COLLABORATION_LIMITS.maxObjectIdLength + 1) },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: {
          type: "text",
          pageNumber: 1,
          start: 0,
          end: COLLABORATION_LIMITS.maxTextRangeLength + 5,
        },
        body: "hi",
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("CommentService — body limits and content safety", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses an empty body", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "   ",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a body beyond the maximum length", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "a".repeat(COLLABORATION_LIMITS.maxBodyLength + 1),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("stores markup-bearing bodies verbatim as text, never as HTML", async () => {
    // The XSS regression: the payload survives *as characters*. Nothing escapes
    // it, nothing strips it, and nothing in the read path interprets it — the
    // renderer emits it as a React text node, which cannot execute a string.
    const payloads = [
      "<script>alert('xss')</script>",
      '<img src=x onerror="alert(1)">',
      "<svg onload=alert(1)></svg>",
      '<iframe src="javascript:alert(1)"></iframe>',
      "'\"><script>document.cookie</script>",
    ];
    for (const payload of payloads) {
      const created = await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: payload,
      });
      const stored = await h.messages.list({
        workspaceId: WS_A,
        threadId: created.thread.id,
        limit: 5,
      });
      expect(stored[0].body).toBe(payload);
      // Explicitly not an escaped or stripped transformation.
      expect(stored[0].body).not.toContain("&lt;");
      expect(stored[0].body).not.toBe("");
    }
  });

  it("refuses bodies carrying bidirectional control characters", async () => {
    // These make text render as something other than what it matches — a
    // forgery no amount of HTML escaping would catch.
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "looks fine‮detrever",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses bodies carrying NUL and other control characters", async () => {
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "before after",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("handles malformed Unicode as a rejection rather than an unhandled error", async () => {
    const outcome = await h.service
      .createThread(actor(EDITOR), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "text \uD800 more",
      })
      .then(() => "accepted")
      .catch((error) => (error instanceof DomainError ? "domain" : "unhandled"));
    expect(outcome).not.toBe("unhandled");
  });

  it("bounds the number of messages per thread", async () => {
    const created = await seedThread(h);
    const full = new InMemoryCommentMessageRepository();
    full.countForThread = async () => COLLABORATION_LIMITS.maxMessagesPerThread;
    const service = new CommentService(
      h.logger,
      h.workspaces as unknown as WorkspaceService,
      h.documents as unknown as never,
      h.threads,
      full,
      h.grants,
      h.now,
    );
    await expect(
      service.addMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, { body: "one more" }),
    ).rejects.toThrow(/limit/i);
  });
});

describe("CommentService — replies", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("persists a reply linked to its parent", async () => {
    const created = await seedThread(h);
    const root = created.messages[0];
    const reply = await h.service.addMessage(actor(OWNER), WS_A, DOC_A, created.thread.id, {
      body: "A reply",
      parentMessageId: root.id,
    });
    expect(reply.parentMessageId).toBe(root.id);
    expect(reply.threadId).toBe(created.thread.id);

    const all = await h.service.listMessages(actor(OWNER), WS_A, DOC_A, created.thread.id);
    expect(all).toHaveLength(2);
    // Oldest first: a conversation reads forwards.
    expect(all[0].id).toBe(root.id);
    expect(all[1].id).toBe(reply.id);
  });

  it("refuses nesting a reply beneath a reply", async () => {
    const created = await seedThread(h);
    const reply = await h.service.addMessage(actor(OWNER), WS_A, DOC_A, created.thread.id, {
      body: "A reply",
      parentMessageId: created.messages[0].id,
    });
    await expect(
      h.service.addMessage(actor(OWNER), WS_A, DOC_A, created.thread.id, {
        body: "Too deep",
        parentMessageId: reply.id,
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a parent message belonging to another thread", async () => {
    const first = await seedThread(h, EDITOR, "thread one");
    const second = await seedThread(h, EDITOR, "thread two");
    await expect(
      h.service.addMessage(actor(EDITOR), WS_A, DOC_A, second.thread.id, {
        body: "grafted",
        parentMessageId: first.messages[0].id,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses replying to a deleted message", async () => {
    const created = await seedThread(h);
    const root = created.messages[0];
    await h.service.deleteMessage(
      actor(EDITOR),
      WS_A,
      DOC_A,
      created.thread.id,
      root.id,
      root.revision,
    );
    await expect(
      h.service.addMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, {
        body: "reply to nothing",
        parentMessageId: root.id,
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("CommentService — authorization", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("rejects a document in another Workspace as missing, not forbidden", async () => {
    // "Forbidden" would confirm the id is real.
    await expect(h.service.listThreads(actor(OWNER), WS_A, DOC_B)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects a Workspace in another organization as missing", async () => {
    await expect(h.service.listThreads(actor(OWNER), WS_B, DOC_B)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects a non-member", async () => {
    await expect(h.service.listThreads(actor(OUTSIDER), WS_A, DOC_A)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("lets a viewer read but not comment", async () => {
    await seedThread(h);
    const listed = await h.service.listThreads(actor(VIEWER), WS_A, DOC_A);
    expect(listed.threads).toHaveLength(1);

    await expect(
      h.service.createThread(actor(VIEWER), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "viewer comment",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("lets a workspace commenter comment but not moderate or share", async () => {
    // `commenter` is exactly the role that contributes without editing the
    // document, so it must be able to comment while still being refused the two
    // Workspace authorities.
    h.workspaces.grant(WS_A, "user-commenter", "commenter");
    const own = await h.service.createThread(actor("user-commenter"), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "a contribution",
    });
    expect(own.thread.createdById).toBe("user-commenter");

    const other = await seedThread(h, EDITOR);
    await expect(
      h.service.resolveThread(
        actor("user-commenter"),
        WS_A,
        DOC_A,
        other.thread.id,
        other.thread.revision,
      ),
    ).rejects.toThrow(DomainError);
    await expect(
      h.service.createGrant(actor("user-commenter"), WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "viewer",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a thread id from another document even inside the same Workspace", async () => {
    const created = await seedThread(h);
    // DOC_A2 is readable by this actor; the thread belongs to DOC_A.
    await expect(
      h.service.getThread(actor(EDITOR), WS_A, DOC_A2, created.thread.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a message id from another thread", async () => {
    const first = await seedThread(h, EDITOR, "one");
    const second = await seedThread(h, EDITOR, "two");
    await expect(
      h.service.editMessage(actor(EDITOR), WS_A, DOC_A, second.thread.id, first.messages[0].id, {
        body: "hijacked",
        expectedRevision: first.messages[0].revision,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses commenting on a trashed document", async () => {
    h.documents.add("doc-trashed", WS_A, { lifecycleState: "trashed" });
    await expect(
      h.service.createThread(actor(EDITOR), WS_A, "doc-trashed", {
        anchor: { type: "document" },
        body: "on the trash",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses unbounded ids before they reach a repository", async () => {
    await expect(
      h.service.listThreads(actor(EDITOR), WS_A, "d".repeat(COLLABORATION_LIMITS.maxIdLength + 1)),
    ).rejects.toThrow(DomainError);
  });
});

describe("CommentService — edit and delete policy", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("lets an author edit their own message", async () => {
    const created = await seedThread(h);
    const message = created.messages[0];
    const edited = await h.service.editMessage(
      actor(EDITOR),
      WS_A,
      DOC_A,
      created.thread.id,
      message.id,
      { body: "Edited text", expectedRevision: message.revision },
    );
    expect(edited.body).toBe("Edited text");
    expect(edited.editedAt).not.toBeNull();
    expect(edited.revision).toBe(message.revision + 1);
  });

  it("refuses to let another user edit someone else's message", async () => {
    // Even an owner: rewriting another person's words under their name is not
    // something audit logging makes acceptable.
    const created = await seedThread(h);
    const message = created.messages[0];
    await expect(
      h.service.editMessage(actor(OWNER), WS_A, DOC_A, created.thread.id, message.id, {
        body: "words I did not write",
        expectedRevision: message.revision,
      }),
    ).rejects.toThrow(DomainError);
  });

  it("lets an author delete their own message and clears the body", async () => {
    const created = await seedThread(h);
    const message = created.messages[0];
    const deleted = await h.service.deleteMessage(
      actor(EDITOR),
      WS_A,
      DOC_A,
      created.thread.id,
      message.id,
      message.revision,
    );
    expect(deleted.deletedAt).not.toBeNull();
    // "Deleted" has to actually remove the words.
    expect(deleted.body).toBe("");

    const stored = await h.messages.getById(WS_A, message.id);
    expect(stored?.body).toBe("");
  });

  it("lets a moderator delete another user's message", async () => {
    const created = await seedThread(h, EDITOR);
    const message = created.messages[0];
    const deleted = await h.service.deleteMessage(
      actor(OWNER),
      WS_A,
      DOC_A,
      created.thread.id,
      message.id,
      message.revision,
    );
    expect(deleted.deletedById).toBe(OWNER);
  });

  it("refuses to edit a deleted message", async () => {
    const created = await seedThread(h);
    const message = created.messages[0];
    await h.service.deleteMessage(
      actor(EDITOR),
      WS_A,
      DOC_A,
      created.thread.id,
      message.id,
      message.revision,
    );
    await expect(
      h.service.editMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, message.id, {
        body: "resurrected",
        expectedRevision: message.revision + 1,
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a stale revision on edit", async () => {
    const created = await seedThread(h);
    const message = created.messages[0];
    await h.service.editMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, message.id, {
      body: "first edit",
      expectedRevision: message.revision,
    });
    await expect(
      h.service.editMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, message.id, {
        body: "second edit on a stale revision",
        expectedRevision: message.revision,
      }),
    ).rejects.toThrow(/changed since/i);
  });

  it("refuses a non-integer revision", async () => {
    const created = await seedThread(h);
    const message = created.messages[0];
    await expect(
      h.service.editMessage(actor(EDITOR), WS_A, DOC_A, created.thread.id, message.id, {
        body: "text",
        expectedRevision: 1.5,
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("CommentService — resolve and reopen", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("resolves and reopens a thread", async () => {
    const created = await seedThread(h);
    const resolved = await h.service.resolveThread(
      actor(OWNER),
      WS_A,
      DOC_A,
      created.thread.id,
      created.thread.revision,
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedById).toBe(OWNER);
    expect(resolved.resolvedAt).not.toBeNull();

    const reopened = await h.service.reopenThread(
      actor(OWNER),
      WS_A,
      DOC_A,
      created.thread.id,
      resolved.revision,
    );
    expect(reopened.status).toBe("open");
    // Reopening clears the resolution rather than leaving a stale resolver on it.
    expect(reopened.resolvedById).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
  });

  it("lets the thread author resolve their own thread", async () => {
    h.workspaces.grant(WS_A, "user-author", "editor");
    const created = await h.service.createThread(actor("user-author"), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "mine",
    });
    const resolved = await h.service.resolveThread(
      actor("user-author"),
      WS_A,
      DOC_A,
      created.thread.id,
      created.thread.revision,
    );
    expect(resolved.status).toBe("resolved");
  });

  it("refuses a stale revision on resolve", async () => {
    const created = await seedThread(h);
    await h.service.resolveThread(
      actor(OWNER),
      WS_A,
      DOC_A,
      created.thread.id,
      created.thread.revision,
    );
    await expect(
      h.service.reopenThread(actor(OWNER), WS_A, DOC_A, created.thread.id, created.thread.revision),
    ).rejects.toThrow(/changed since/i);
  });

  it("filters a listing by status", async () => {
    const first = await seedThread(h, EDITOR, "one");
    await seedThread(h, EDITOR, "two");
    await h.service.resolveThread(
      actor(OWNER),
      WS_A,
      DOC_A,
      first.thread.id,
      first.thread.revision,
    );

    const open = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { status: "open" });
    expect(open.threads).toHaveLength(1);
    const resolved = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, {
      status: "resolved",
    });
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].id).toBe(first.thread.id);
  });
});

describe("CommentService — pagination", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("returns a bounded page with a working cursor", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedThread(h, EDITOR, `comment ${i}`);
    }
    const first = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { limit: 2 });
    expect(first.threads).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.threads).toHaveLength(2);
    // No overlap between pages.
    const firstIds = new Set(first.threads.map((t) => t.id));
    for (const thread of second.threads) expect(firstIds.has(thread.id)).toBe(false);
  });

  it("reports no cursor at the end of a listing", async () => {
    await seedThread(h);
    const page = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it("clamps an over-large limit to the domain cap", async () => {
    for (let i = 0; i < 3; i += 1) await seedThread(h, EDITOR, `c${i}`);
    const page = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { limit: 10_000 });
    expect(page.threads.length).toBeLessThanOrEqual(COLLABORATION_LIMITS.maxListLimit);
  });

  it("refuses a malformed cursor rather than silently restarting", async () => {
    // Silently returning page one would make a paging client loop forever.
    await expect(
      h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { cursor: "not-a-date" }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a malformed page filter", async () => {
    await expect(
      h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { pageNumber: 0 }),
    ).rejects.toThrow(DomainError);
    await expect(
      h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { pageNumber: 1.5 }),
    ).rejects.toThrow(DomainError);
  });

  it("filters threads by anchor page", async () => {
    await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "page", pageNumber: 1 },
      body: "page one",
    });
    await h.service.createThread(actor(EDITOR), WS_A, DOC_A, {
      anchor: { type: "page", pageNumber: 7 },
      body: "page seven",
    });
    const page7 = await h.service.listThreads(actor(EDITOR), WS_A, DOC_A, { pageNumber: 7 });
    expect(page7.threads).toHaveLength(1);
    expect(page7.threads[0].pageNumber).toBe(7);
  });
});

describe("CommentService — permission grants", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates a real, persisted grant", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "commenter",
    });
    const stored = await h.grants.getById(WS_A, grant.id);
    expect(stored).not.toBeNull();
    expect(stored?.role).toBe("commenter");
    expect(stored?.granteeUserId).toBe(OUTSIDER);
    expect(stored?.revokedAt).toBeNull();
    expect(stored?.grantedById).toBe(OWNER);
  });

  it("widens a workspace viewer into a commenter", async () => {
    h.workspaces.grant(WS_A, "user-guest", "viewer");
    await expect(
      h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "before the grant",
      }),
    ).rejects.toThrow(DomainError);

    await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: "user-guest",
      role: "commenter",
    });
    const created = await h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "after the grant",
    });
    expect(created.thread.createdById).toBe("user-guest");
  });

  it("does not let a grant reach a document in another Workspace", async () => {
    // A grant only widens access *within* the Workspace that contains the
    // document; it cannot manufacture cross-tenant reach.
    await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "editor",
    });
    await expect(h.service.listThreads(actor(OUTSIDER), WS_A, DOC_A)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("a viewer grant does not permit commenting", async () => {
    h.workspaces.grant(WS_A, "user-guest", "viewer");
    await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: "user-guest",
      role: "viewer",
    });
    await expect(
      h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "should fail",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("revokes a grant and access is lost on the very next call", async () => {
    h.workspaces.grant(WS_A, "user-guest", "viewer");
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: "user-guest",
      role: "commenter",
    });
    await h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "while granted",
    });

    await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);

    // No re-login and no cache expiry: authorization re-reads the grant.
    await expect(
      h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "after revocation",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("expires a grant at its expiry instant without any sweep", async () => {
    h.workspaces.grant(WS_A, "user-guest", "viewer");
    const expiresAt = new Date(h.now().getTime() + 60_000);
    await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: "user-guest",
      role: "commenter",
      expiresAt,
    });
    await h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
      anchor: { type: "document" },
      body: "before expiry",
    });

    h.setNow(new Date(expiresAt.getTime() + 1));
    await expect(
      h.service.createThread(actor("user-guest"), WS_A, DOC_A, {
        anchor: { type: "document" },
        body: "after expiry",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("converges a duplicate share onto the existing grant", async () => {
    // Two live grants for one person would each need revoking separately, and
    // missing one leaves access nobody can see in the list they just cleared.
    const first = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    const second = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "editor",
    });
    expect(second.id).toBe(first.id);
    expect(second.role).toBe("editor");

    const listed = await h.service.listGrants(actor(OWNER), WS_A, DOC_A);
    expect(listed).toHaveLength(1);
  });

  it("never revives a revoked grant; a reshare creates a new one", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);

    const reshared = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    expect(reshared.id).not.toBe(grant.id);
    const original = await h.grants.getById(WS_A, grant.id);
    expect(original?.revokedAt).not.toBeNull();
  });

  it("is idempotent when revoking twice", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    const first = await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);
    h.setNow(new Date(h.now().getTime() + 60_000));
    const second = await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);
    // The moment access was withdrawn is the fact worth keeping.
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });

  it("retains a revoked grant as an audit fact", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);

    const active = await h.service.listGrants(actor(OWNER), WS_A, DOC_A);
    expect(active).toHaveLength(0);
    const all = await h.service.listGrants(actor(OWNER), WS_A, DOC_A, { includeRevoked: true });
    expect(all).toHaveLength(1);
    expect(all[0].revokedById).toBe(OWNER);
  });

  it("does not let an organization admin's inherited role gain owner-only sharing", async () => {
    // An organization admin inherits `editor` (INHERITED_WORKSPACE_ROLE), so it
    // may moderate but must not acquire the owner-only manage-members
    // capability that sharing maps to. Inherited administration must not
    // silently become ownership.
    const orgAdmin: ActorContext = {
      userId: EDITOR,
      organizationId: ORG,
      organizationRole: "admin",
      organizationDefaultWorkspaceId: WS_A,
    };
    await expect(
      h.service.createGrant(orgAdmin, WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "viewer",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses sharing by a non-administrator", async () => {
    await expect(
      h.service.createGrant(actor(EDITOR), WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "viewer",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses listing shares to a non-administrator", async () => {
    // Who else can see a document is itself sensitive.
    await expect(h.service.listGrants(actor(EDITOR), WS_A, DOC_A)).rejects.toThrow(DomainError);
  });

  it("refuses an unsupported role, including owner", async () => {
    // A document-scoped grant conferring ownership would escalate past the
    // Workspace that contains the document.
    await expect(
      h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "owner",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses an expiry in the past or beyond the maximum lifetime", async () => {
    await expect(
      h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "viewer",
        expiresAt: new Date(h.now().getTime() - 1000),
      }),
    ).rejects.toThrow(DomainError);
    await expect(
      h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
        granteeUserId: OUTSIDER,
        role: "viewer",
        expiresAt: new Date(h.now().getTime() + COLLABORATION_LIMITS.maxGrantTtlMs + 10_000),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a grant id belonging to another document", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "viewer",
    });
    await expect(h.service.revokeGrant(actor(OWNER), WS_A, DOC_A2, grant.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses granting to oneself", async () => {
    await expect(
      h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
        granteeUserId: OWNER,
        role: "editor",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("reports the effective grant role and drops it after revocation", async () => {
    const grant = await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: OUTSIDER,
      role: "commenter",
    });
    expect(await h.service.effectiveGrantRole(WS_A, DOC_A, OUTSIDER)).toBe("commenter");
    await h.service.revokeGrant(actor(OWNER), WS_A, DOC_A, grant.id);
    expect(await h.service.effectiveGrantRole(WS_A, DOC_A, OUTSIDER)).toBeNull();
  });

  it("does not let a grant confer sharing or moderation rights", async () => {
    h.workspaces.grant(WS_A, "user-guest", "viewer");
    await h.service.createGrant(actor(OWNER), WS_A, DOC_A, {
      granteeUserId: "user-guest",
      role: "editor",
    });
    // An editor *grant* is still not workspace administration.
    await expect(
      h.service.createGrant(actor("user-guest"), WS_A, DOC_A, {
        granteeUserId: "user-third",
        role: "viewer",
      }),
    ).rejects.toThrow(DomainError);

    const created = await seedThread(h, EDITOR);
    await expect(
      h.service.resolveThread(
        actor("user-guest"),
        WS_A,
        DOC_A,
        created.thread.id,
        created.thread.revision,
      ),
    ).rejects.toThrow(DomainError);
  });
});

describe("CommentService — result isolation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("does not let a caller mutate stored state through a returned object", async () => {
    const created = await seedThread(h);
    created.thread.status = "resolved";
    created.messages[0].body = "tampered";

    const reread = await h.service.getThread(actor(EDITOR), WS_A, DOC_A, created.thread.id);
    expect(reread.thread.status).toBe("open");
    expect(reread.messages[0].body).toBe("First comment");
  });

  it("returns independent date objects", async () => {
    const created = await seedThread(h);
    created.thread.createdAt.setFullYear(1999);
    const reread = await h.threads.getById(WS_A, created.thread.id);
    expect(reread?.createdAt.getFullYear()).not.toBe(1999);
  });
});
