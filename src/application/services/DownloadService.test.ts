import { describe, expect, it } from "vitest";
import { DownloadService } from "./DownloadService";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { LocalSignedUrlService } from "@/src/infrastructure/storage/LocalSignedUrlService";

describe("DownloadService", () => {
  it("returns a signed URL for an existing file", async () => {
    const meta = new InMemoryStoredFileRepository();
    const file = await meta.create({
      ownerType: "anon",
      ownerId: "a",
      key: "ca/x",
      sha256: "x",
      size: 3,
      mimeType: "application/pdf",
      originalName: "f.pdf",
    });
    const svc = new DownloadService(
      meta,
      new LocalSignedUrlService("secret", "http://localhost:3000"),
    );
    const res = await svc.getUrl(file.id);
    expect(res).not.toBeNull();
    expect(res!.url).toContain("/api/storage/file");
    expect(res!.file.id).toBe(file.id);
    expect(res!.ttlSeconds).toBe(900);
  });

  it("returns null for a missing file", async () => {
    const meta = new InMemoryStoredFileRepository();
    const svc = new DownloadService(
      meta,
      new LocalSignedUrlService("secret", "http://localhost:3000"),
    );
    expect(await svc.getUrl("nope")).toBeNull();
  });
});
