import { describe, expect, it } from "vitest";
import { requireSameOrigin } from "./workspaceCsrf";

const BASE_URL = "https://example.com/api/workspaces";

describe("Workspace CSRF origin — valid same-origin mutations", () => {
  it("allows matching origin header", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { origin: "https://example.com" } }))
    ).toBeNull();
  });

  it("allows matching origin on PATCH", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "PATCH", headers: { origin: "https://example.com" } }))
    ).toBeNull();
  });

  it("allows a matching referer when origin is absent", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { referer: "https://example.com/workspaces" } }))
    ).toBeNull();
  });

  it("allows matching referer with path and query", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { referer: "https://example.com/workspaces/w1/settings?tab=members" } }))
    ).toBeNull();
  });
});

describe("Workspace CSRF origin — rejection cases", () => {
  it("rejects foreign origin", () => {
    const response = requireSameOrigin(
      new Request(BASE_URL, { method: "POST", headers: { origin: "https://evil.test" } })
    );
    expect(response?.status).toBe(403);
  });

  it("rejects cross-origin subdomain", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { origin: "https://sub.example.com" } }))?.status
    ).toBe(403);
  });

  it("rejects foreign referer", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { referer: "https://evil.test/workspaces" } }))?.status
    ).toBe(403);
  });

  it("rejects malformed referer", () => {
    expect(
      requireSameOrigin(new Request(BASE_URL, { method: "POST", headers: { referer: "not a url" } }))?.status
    ).toBe(403);
  });

  it("rejects missing origin and referer — authentication does not bypass CSRF", () => {
    // A request carrying a valid auth cookie but no origin/referer must still be rejected.
    // This ensures that even authenticated sessions cannot bypass the CSRF check.
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: {
        cookie: "pdfmaster_session=valid-session-token",
        // No origin or referer
      },
    });
    expect(requireSameOrigin(req)?.status).toBe(403);
  });

  it("rejects request with Authorization header but no origin/referer", () => {
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer sometoken",
        // No origin or referer
      },
    });
    expect(requireSameOrigin(req)?.status).toBe(403);
  });

  it("rejects spoofed Origin: null from sandboxed iframe", () => {
    // Sandboxed iframes send Origin: null — must be treated as foreign.
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: { origin: "null" },
    });
    const result = requireSameOrigin(req);
    expect(result?.status).toBe(403);
  });
});

describe("Workspace CSRF origin — error body structure", () => {
  it("returns CSRF_ORIGIN_REJECTED for mismatched origin", async () => {
    const response = requireSameOrigin(
      new Request(BASE_URL, { method: "POST", headers: { origin: "https://evil.test" } })
    )!;
    const body = await response.json();
    expect(body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });

  it("returns CSRF_ORIGIN_REQUIRED for missing origin and referer", async () => {
    const response = requireSameOrigin(new Request(BASE_URL, { method: "POST" }))!;
    const body = await response.json();
    expect(body.error.code).toBe("CSRF_ORIGIN_REQUIRED");
  });
});
