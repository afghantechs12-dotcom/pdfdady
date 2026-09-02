import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SESSION_RESPONSE_SCHEMA,
  sessionBelongsToWorkspace,
  tabStateInputRejection,
  toSessionResponse,
  toTabResponse,
  toTabStateResponse,
} from "./sessionHttp";
import type {
  WorkspaceSession,
  WorkspaceSessionTab,
} from "@/src/domain/entities/WorkspaceSession";

function tab(overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab {
  return {
    id: "tab_1",
    documentId: "doc_1",
    versionId: "ver_1",
    title: "Contract.pdf",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    state: { lastAccessed: new Date("2026-01-02T00:00:00.000Z") },
    ...overrides,
  };
}

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: "sess_1",
    userId: "user_1",
    workspaceId: "ws_1",
    organizationId: "org_1",
    activeTabId: "tab_1",
    tabs: [tab()],
    version: 4,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toSessionResponse", () => {
  it("carries a schema version", () => {
    expect(toSessionResponse(session()).schema).toBe(WORKSPACE_SESSION_RESPONSE_SCHEMA);
  });

  it("carries the optimistic-concurrency counter", () => {
    expect(toSessionResponse(session()).version).toBe(4);
  });

  it("withholds the owner and tenant identifiers", () => {
    const response = toSessionResponse(session()) as unknown as Record<string, unknown>;
    expect(response.userId).toBeUndefined();
    expect(response.organizationId).toBeUndefined();
  });

  it("carries only logical tab references — no bytes or keys", () => {
    const serialized = JSON.stringify(toSessionResponse(session()));
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain("blob:");
    expect(serialized).toContain("doc_1");
    expect(serialized).toContain("ver_1");
  });

  it("serializes dates as ISO strings", () => {
    expect(toSessionResponse(session()).updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("toTabStateResponse", () => {
  it("reports absent optional state as explicit null, not as a missing key", () => {
    const state = toTabStateResponse({ lastAccessed: new Date("2026-01-02T00:00:00.000Z") });
    expect(state.activePage).toBeNull();
    expect(state.viewport).toBeNull();
    expect(state.tool).toBeNull();
    expect(state.selection).toBeNull();
    expect(state.paneId).toBeNull();
  });

  it("defaults the dirty and conflict flags to false rather than null", () => {
    const state = toTabStateResponse({ lastAccessed: new Date() });
    expect(state.dirty).toBe(false);
    expect(state.conflict).toBe(false);
  });

  it("passes through bounded view state", () => {
    const state = toTabStateResponse({
      activePage: 3,
      viewport: { scale: 1.5, offsetX: 10, offsetY: -20 },
      tool: "select",
      selection: { start: 2, end: 9 },
      dirty: true,
      conflict: true,
      paneId: "right",
      lastAccessed: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(state.activePage).toBe(3);
    expect(state.viewport).toEqual({ scale: 1.5, offsetX: 10, offsetY: -20 });
    expect(state.tool).toBe("select");
    expect(state.selection).toEqual({ start: 2, end: 9 });
    expect(state.dirty).toBe(true);
    expect(state.paneId).toBe("right");
  });
});

describe("toTabResponse", () => {
  it("exposes the logical reference and title only", () => {
    const response = toTabResponse(tab()) as unknown as Record<string, unknown>;
    expect(Object.keys(response).sort()).toEqual(
      ["createdAt", "documentId", "id", "state", "title", "updatedAt", "versionId"].sort(),
    );
  });
});

describe("sessionBelongsToWorkspace", () => {
  it("accepts a session from the addressed Workspace", () => {
    expect(sessionBelongsToWorkspace({ workspaceId: "ws_1" }, "ws_1")).toBe(true);
  });

  it("rejects a session from another Workspace the same user owns", () => {
    expect(sessionBelongsToWorkspace({ workspaceId: "ws_2" }, "ws_1")).toBe(false);
  });
});

describe("tabStateInputRejection", () => {
  it("accepts bounded view state", () => {
    expect(tabStateInputRejection({ activePage: 2, tool: "select", dirty: true })).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(tabStateInputRejection(null)).not.toBeNull();
    expect(tabStateInputRejection([1, 2])).not.toBeNull();
    expect(tabStateInputRejection("state")).not.toBeNull();
  });

  it("rejects a payload naming document content", () => {
    expect(tabStateInputRejection({ content: "…" })).not.toBeNull();
    expect(tabStateInputRejection({ bytes: [1, 2, 3] })).not.toBeNull();
    expect(tabStateInputRejection({ pdf: "…" })).not.toBeNull();
  });

  it("rejects a payload naming a storage key", () => {
    expect(tabStateInputRejection({ storageKey: "org/ws/doc.pdf" })).not.toBeNull();
    expect(tabStateInputRejection({ sourceKey: "org/ws/doc.pdf" })).not.toBeNull();
  });

  it("rejects page backgrounds and rendered images", () => {
    expect(tabStateInputRejection({ backgrounds: {} })).not.toBeNull();
    expect(tabStateInputRejection({ thumbnails: [] })).not.toBeNull();
  });

  it("rejects a data URL in any value", () => {
    expect(tabStateInputRejection({ tool: "data:application/pdf;base64,AAAA" })).not.toBeNull();
    expect(tabStateInputRejection({ tool: " blob:https://example.test/abc" })).not.toBeNull();
  });

  it("is case-insensitive about forbidden keys", () => {
    expect(tabStateInputRejection({ DataURL: "x" })).not.toBeNull();
    expect(tabStateInputRejection({ SourceKey: "x" })).not.toBeNull();
  });
});
