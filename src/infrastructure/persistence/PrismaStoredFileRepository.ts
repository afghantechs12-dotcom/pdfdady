import { PrismaClient } from "@prisma/client";
import type {
  StoredFile,
  StoredFileOwnerType,
} from "@/src/domain/entities/StoredFile";
import type {
  IFileMetadataRepository,
  StoredFileCreateInput,
} from "@/src/application/ports/storage/FileMetadataRepository";

type StoredFileRow = {
  id: string;
  ownerType: string;
  ownerId: string;
  key: string;
  sha256: string | null;
  size: number;
  mimeType: string;
  originalName: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

function toDomain(row: StoredFileRow): StoredFile {
  return {
    id: row.id,
    ownerType: row.ownerType as StoredFileOwnerType,
    ownerId: row.ownerId,
    key: row.key,
    sha256: row.sha256,
    size: row.size,
    mimeType: row.mimeType,
    originalName: row.originalName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Prisma-backed FileMetadataRepository for the `stored_files` table. The bytes
 * live in object storage (IObjectStorage); this is the index that maps a
 * stored-file id → storage key, owner scope, sha256 (dedup), size, expiry.
 */
export class PrismaStoredFileRepository implements IFileMetadataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: StoredFileCreateInput): Promise<StoredFile> {
    const row = await this.prisma.storedFile.create({
      data: {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        key: input.key,
        sha256: input.sha256 ?? null,
        size: input.size,
        mimeType: input.mimeType,
        originalName: input.originalName ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return toDomain(row);
  }

  async get(id: string): Promise<StoredFile | null> {
    const row = await this.prisma.storedFile.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findBySha256(
    ownerType: StoredFileOwnerType,
    ownerId: string,
    sha256: string,
  ): Promise<StoredFile | null> {
    const row = await this.prisma.storedFile.findFirst({
      where: { ownerType, ownerId, sha256 },
    });
    return row ? toDomain(row) : null;
  }

  async existsByKey(key: string): Promise<boolean> {
    const row = await this.prisma.storedFile.findFirst({ where: { key }, select: { id: true } });
    return row !== null;
  }

  async listByOwner(
    ownerType: StoredFileOwnerType,
    ownerId: string,
    limit = 100,
  ): Promise<StoredFile[]> {
    const rows = await this.prisma.storedFile.findMany({
      where: { ownerType, ownerId },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDomain);
  }

  async listExpired(now: Date = new Date(), limit = 100): Promise<StoredFile[]> {
    const rows = await this.prisma.storedFile.findMany({
      where: { expiresAt: { not: null, lt: now } },
      take: limit,
      orderBy: { expiresAt: "asc" },
    });
    return rows.map(toDomain);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.storedFile.delete({ where: { id } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2025") throw err;
    }
  }
}
