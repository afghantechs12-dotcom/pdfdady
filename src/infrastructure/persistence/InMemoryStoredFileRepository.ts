import type {
  StoredFile,
  StoredFileOwnerType,
} from "@/src/domain/entities/StoredFile";
import type {
  IFileMetadataRepository,
  StoredFileCreateInput,
} from "@/src/application/ports/storage/FileMetadataRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-file-${counter}`;
}

/**
 * In-memory FileMetadataRepository — for tests and as a zero-dependency
 * fallback. Implements the same interface as the Prisma adapter.
 */
export class InMemoryStoredFileRepository implements IFileMetadataRepository {
  private readonly files = new Map<string, StoredFile>();

  async create(input: StoredFileCreateInput): Promise<StoredFile> {
    const file: StoredFile = {
      id: uid(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key: input.key,
      sha256: input.sha256 ?? null,
      size: input.size,
      mimeType: input.mimeType,
      originalName: input.originalName ?? null,
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
    };
    this.files.set(file.id, file);
    return { ...file };
  }

  async get(id: string): Promise<StoredFile | null> {
    const f = this.files.get(id);
    return f ? { ...f } : null;
  }

  async findBySha256(
    ownerType: StoredFileOwnerType,
    ownerId: string,
    sha256: string,
  ): Promise<StoredFile | null> {
    const f = [...this.files.values()].find(
      (x) =>
        x.ownerType === ownerType &&
        x.ownerId === ownerId &&
        x.sha256 === sha256,
    );
    return f ? { ...f } : null;
  }

  async listByOwner(
    ownerType: StoredFileOwnerType,
    ownerId: string,
    limit = 100,
  ): Promise<StoredFile[]> {
    return [...this.files.values()]
      .filter((x) => x.ownerType === ownerType && x.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((x) => ({ ...x }));
  }

  async listExpired(now: Date = new Date(), limit = 100): Promise<StoredFile[]> {
    return [...this.files.values()]
      .filter((x) => x.expiresAt && x.expiresAt < now)
      .slice(0, limit)
      .map((x) => ({ ...x }));
  }

  async delete(id: string): Promise<void> {
    this.files.delete(id);
  }
}
