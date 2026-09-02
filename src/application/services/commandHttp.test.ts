import { describe, expect, it } from "vitest";
import { toCommandResponse, toOperationResponse } from "./commandHttp";
import { requireSameOrigin } from "./workspaceCsrf";
import { COMMAND_LIMITS } from "@/src/domain/entities/CommandPalette";
import type {
  EvaluatedCommand,
  OperationDescriptor,
} from "@/src/domain/entities/CommandPalette";

const NOW = new Date("2026-08-04T12:00:00.000Z");

function command(overrides: Partial<EvaluatedCommand> = {}): EvaluatedCommand {
  return {
    id: "doc.save",
    label: "Save document",
    keywords: ["save", "commit"],
    category: "document",
    shortcut: "Ctrl+S",
    requirements: { document: true, write: true },
    enabled: true,
    disabledReason: null,
    ...overrides,
  };
}

function operation(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    id: "op-1",
    type: "export",
    workspaceId: "ws-1",
    documentId: "doc-1",
    label: "Exporting report",
    status: "running",
    progress: 40,
    error: null,
    resultRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("commandHttp — command serialization", () => {
  it("emits the display fields a palette needs", () => {
    const response = toCommandResponse(command());
    expect(response).toEqual({
      id: "doc.save",
      label: "Save document",
      category: "document",
      shortcut: "Ctrl+S",
      enabled: true,
      disabledReason: null,
    });
  });

  it("carries the disabled reason rather than hiding the command", () => {
    const response = toCommandResponse(
      command({ enabled: false, disabledReason: "Open a document first." }),
    );
    expect(response.enabled).toBe(false);
    expect(response.disabledReason).toBe("Open a document first.");
  });

  it("normalizes a missing shortcut to null", () => {
    expect(toCommandResponse(command({ shortcut: undefined })).shortcut).toBeNull();
  });

  it("does not emit the requirement declaration", () => {
    // Requirements drive server-side evaluation. Echoing them would tell a
    // client exactly which check to try to satisfy without adding anything it
    // can act on — `enabled` and the reason already say what it needs to know.
    expect(toCommandResponse(command())).not.toHaveProperty("requirements");
    expect(toCommandResponse(command())).not.toHaveProperty("keywords");
  });
});

describe("commandHttp — operation serialization", () => {
  it("emits the state a client renders", () => {
    const response = toOperationResponse(operation());
    expect(response.id).toBe("op-1");
    expect(response.status).toBe("running");
    expect(response.progress).toBe(40);
    expect(response.createdAt).toBe(NOW.toISOString());
  });

  it("never emits the internal result reference", () => {
    // resultRef is an internal handle — a storage key in some cases. A client
    // needs to know a result exists, not how the server addresses it.
    const response = toOperationResponse(
      operation({ status: "completed", progress: 100, resultRef: "workspace/ws-1/export-7.pdf" }),
    );
    expect(response).not.toHaveProperty("resultRef");
    expect(JSON.stringify(response)).not.toContain("workspace/ws-1");
    expect(response.hasResult).toBe(true);
  });

  it("does not claim a result when a completed operation carries none", () => {
    const response = toOperationResponse(
      operation({ status: "completed", progress: 100, resultRef: null }),
    );
    expect(response.hasResult).toBe(false);
  });

  it("does not emit the Workspace id back to a client that supplied it", () => {
    expect(toOperationResponse(operation())).not.toHaveProperty("workspaceId");
  });

  it("reports the controls that actually apply", () => {
    expect(toOperationResponse(operation({ status: "running" })).canCancel).toBe(true);
    expect(toOperationResponse(operation({ status: "running" })).canRetry).toBe(false);
    expect(toOperationResponse(operation({ status: "failed" })).canRetry).toBe(true);
    expect(toOperationResponse(operation({ status: "failed" })).canCancel).toBe(false);
  });

  it("bounds a label written by an older build", () => {
    const response = toOperationResponse(
      operation({ label: "x".repeat(COMMAND_LIMITS.maxLabelLength + 200) }),
    );
    expect([...response.label]).toHaveLength(COMMAND_LIMITS.maxLabelLength);
  });

  it("bounds an error written by an older build", () => {
    const response = toOperationResponse(
      operation({ status: "failed", error: "x".repeat(COMMAND_LIMITS.maxErrorLength + 200) }),
    );
    expect([...(response.error ?? "")]).toHaveLength(COMMAND_LIMITS.maxErrorLength);
  });
});

describe("commandHttp — CSRF on M7.14 mutations", () => {
  function request(url: string, headers: Record<string, string>): Request {
    return new Request(url, { method: "POST", headers });
  }

  const ROUTES = [
    "https://app.example.com/api/workspaces/ws-1/commands",
    "https://app.example.com/api/workspaces/ws-1/operations/op-1/cancel",
    "https://app.example.com/api/workspaces/ws-1/operations/op-1/retry",
  ];

  it("accepts a same-origin request on every M7.14 mutation", () => {
    for (const url of ROUTES) {
      expect(requireSameOrigin(request(url, { origin: "https://app.example.com" }))).toBeNull();
    }
  });

  it("rejects a cross-origin request on every M7.14 mutation", () => {
    for (const url of ROUTES) {
      const rejected = requireSameOrigin(request(url, { origin: "https://evil.example.com" }));
      expect(rejected?.status).toBe(403);
    }
  });

  it("rejects a request carrying no origin evidence at all", () => {
    for (const url of ROUTES) {
      expect(requireSameOrigin(request(url, {}))?.status).toBe(403);
    }
  });
});
