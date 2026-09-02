import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { MetadataService } from "./MetadataService";
import type { AttachmentRecord, DocumentMetadata, OutlineItem, WorkspaceBookmark } from "@/src/domain/entities/DocumentMetadata";

export function metadataService(): MetadataService {
  return appContainer.resolve<MetadataService>(Tokens.MetadataService);
}

export function toMetadataResponse(m: DocumentMetadata) {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    documentId: m.documentId,
    fields: m.fields,
    schemaVersion: m.schemaVersion,
    revision: m.revision,
    createdById: m.createdById,
    updatedById: m.updatedById,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function toBookmarkResponse(b: WorkspaceBookmark) {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    documentId: b.documentId,
    pageNumber: b.pageNumber,
    title: b.title,
    note: b.note,
    anchor: b.anchor,
    orderKey: b.orderKey,
    revision: b.revision,
    createdById: b.createdById,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export function toOutlineItemResponse(i: OutlineItem) {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    documentId: i.documentId,
    parentId: i.parentId,
    title: i.title,
    pageNumber: i.pageNumber,
    depth: i.depth,
    orderKey: i.orderKey,
    origin: i.origin,
    revision: i.revision,
    createdById: i.createdById,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function toAttachmentResponse(a: AttachmentRecord) {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    documentId: a.documentId,
    // `storedFileId` is deliberately not serialized: it is an internal
    // persistence handle, and the only thing a client needs to know is whether
    // bytes exist to fetch. An embedded attachment catalogued but never
    // extracted reports false, which is the honest state — the alternative is a
    // download button that can only fail.
    downloadable: a.storedFileId !== null,
    origin: a.origin,
    name: a.name,
    description: a.description,
    mimeType: a.mimeType,
    byteSize: a.byteSize,
    checksum: a.checksum,
    revision: a.revision,
    createdById: a.createdById,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
