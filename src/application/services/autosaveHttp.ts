import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AutosaveService } from "./AutosaveService";
import { workspaceError } from "./workspaceHttp";
import type { AutosaveDraft } from "@/src/domain/entities/AutosaveDraft";
import { AUTOSAVE_DRAFT_LIMITS as L } from "@/src/domain/entities/AutosaveDraft";

export function autosaveService(): AutosaveService {
  return appContainer.resolve<AutosaveService>(Tokens.AutosaveService);
}

/**
 * Largest request body the autosave routes will read, with headroom over the
 * payload limit for the JSON envelope around it. Enforced from `content-length`
 * before the body is parsed, so an oversized upload is refused rather than
 * buffered.
 */
export const MAX_AUTOSAVE_BODY_BYTES = L.maxPayloadBytes + 8 * 1024;

export function rejectOversizedBody(request: NextRequest): NextResponse | null {
  const header = request.headers.get("content-length");
  if (!header) return null;
  const declared = Number(header);
  if (!Number.isFinite(declared) || declared <= MAX_AUTOSAVE_BODY_BYTES) return null;
  return workspaceError(request, "PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
}

/**
 * Client-facing shape of a draft.
 *
 * `snapshotKey` is deliberately withheld: it is an internal object-storage
 * location, and echoing it would tell a client where another tenant's bytes
 * would live. The generation is kept because clients use it to tell one save
 * apart from the next.
 */
export interface AutosaveDraftResponse {
  id: string;
  documentId: string;
  deviceId: string;
  baseVersion: number;
  expectedRevision: number;
  snapshotGeneration: number;
  checksum: string;
  byteSize: number;
  status: AutosaveDraft["status"];
  failureReason: string | null;
  leaseOwnerDeviceId: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toAutosaveResponse(draft: AutosaveDraft): AutosaveDraftResponse {
  return {
    id: draft.id,
    documentId: draft.documentId,
    deviceId: draft.deviceId,
    baseVersion: draft.baseVersion,
    expectedRevision: draft.expectedRevision,
    snapshotGeneration: draft.snapshotGeneration,
    checksum: draft.checksum,
    byteSize: draft.byteSize,
    status: draft.status,
    failureReason: draft.failureReason,
    leaseOwnerDeviceId: draft.leaseOwnerDeviceId,
    leaseExpiresAt: draft.leaseExpiresAt?.toISOString() ?? null,
    version: draft.version,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}
