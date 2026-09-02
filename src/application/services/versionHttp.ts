import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { VersionService } from "./VersionService";
import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";

export function versionService(): VersionService {
  return appContainer.resolve<VersionService>(Tokens.VersionService);
}

/**
 * Client-facing shape of a version.
 *
 * The artifact *keys* are deliberately withheld. They are internal
 * object-storage locations, and echoing them would tell a client where bytes
 * live — including, by their shape, where another tenant's bytes would live.
 * Checksums, sizes and page counts are kept: a client needs them to verify what
 * it downloaded and to render history, and none of them disclose a location.
 */
export interface DocumentVersionResponse {
  id: string;
  documentId: string;
  versionNumber: number;
  revision: number;
  origin: DocumentVersion["origin"];
  restoredFromVersionId: string | null;
  label: string | null;
  manifestDegraded: boolean;
  checksum: string;
  sourceChecksum: string;
  sourceByteSize: number;
  pageCount: number | null;
  thumbnailCount: number;
  hasEditorState: boolean;
  hasOutput: boolean;
  createdById: string;
  createdAt: string;
}

export function toVersionResponse(version: DocumentVersion): DocumentVersionResponse {
  return {
    id: version.id,
    documentId: version.documentId,
    versionNumber: version.versionNumber,
    revision: version.revision,
    origin: version.origin,
    restoredFromVersionId: version.restoredFromVersionId,
    label: version.label,
    manifestDegraded: version.manifestDegraded,
    checksum: version.checksum,
    sourceChecksum: version.manifest.sourceChecksum,
    sourceByteSize: version.manifest.sourceByteSize,
    pageCount: version.manifest.pageCount,
    thumbnailCount: version.manifest.thumbnailKeys.length,
    hasEditorState: version.manifest.editorStateKey !== null,
    hasOutput: version.manifest.outputKey !== null,
    createdById: version.createdById,
    createdAt: version.createdAt.toISOString(),
  };
}
