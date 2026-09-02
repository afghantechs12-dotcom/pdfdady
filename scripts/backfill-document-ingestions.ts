/**
 * One-time repair for uploads that were accepted before the ingestion pipeline
 * existed.
 *
 * Those uploads have durable bytes, a StoredFile, a DocumentRecord and a
 * `pending` ingestion — but no DocumentVersion, so `currentVersionId` is null
 * and the content route has nothing to serve. This promotes them through
 * exactly the same {@link DocumentIngestionService} the queue worker uses, so a
 * repaired document is indistinguishable from a normally-ingested one. A second
 * implementation here would be a second way to write a version, and the two
 * would drift.
 *
 * Safety model:
 *  - `--dry-run` (the default) performs no writes at all;
 *  - `--apply` requires `--expect=<n>` and refuses to run when the eligible set
 *    is not exactly that size, so an unexpected record can never be mutated by a
 *    script that was reviewed against a smaller plan;
 *  - eligibility is discovered from the database, never hardcoded;
 *  - storage keys, PDF bytes, tokens and signed URLs are never printed.
 *
 * Usage:
 *   npx tsx scripts/backfill-document-ingestions.ts --dry-run
 *   npx tsx scripts/backfill-document-ingestions.ts --apply --expect=3
 */

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { DocumentIngestionService } from "@/src/application/services/DocumentIngestionService";
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentVersionRepository } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";

/** How many candidates one run will consider. Bounded on purpose. */
const MAX_CANDIDATES = 100;

interface Candidate {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  ingestionId: string;
  storedFileId: string;
  status: string;
  byteSize: number;
  checksumMatches: boolean;
  objectPresent: boolean;
  eligible: boolean;
  reason: string;
}

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const expectArg = argv.find((a) => a.startsWith("--expect="));
  const expect = expectArg ? Number(expectArg.slice("--expect=".length)) : null;
  return { apply, expect };
}

/**
 * Finds uploads that are stranded without a durable version.
 *
 * Every claim printed later is verified here against the authoritative rows —
 * the ingestion, the StoredFile and the object store — rather than assumed from
 * the ingestion status alone.
 */
async function findCandidates(): Promise<Candidate[]> {
  const ingestions = appContainer.resolve<DocumentIngestionRepository>(
    Tokens.DocumentIngestionRepository,
  );
  const documents = appContainer.resolve<DocumentRecordRepository>(Tokens.DocumentRecordRepository);
  const versions = appContainer.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository);
  const files = appContainer.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository);
  const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);

  const unfinished = await ingestions.listUnfinished(MAX_CANDIDATES);
  const candidates: Candidate[] = [];

  for (const ingestion of unfinished) {
    const base = {
      organizationId: ingestion.organizationId,
      workspaceId: ingestion.workspaceId,
      documentId: ingestion.documentId,
      ingestionId: ingestion.id,
      storedFileId: ingestion.storedFileId,
      status: ingestion.status,
      byteSize: ingestion.byteSize,
      checksumMatches: false,
      objectPresent: false,
    };

    const document = await documents.getById(ingestion.workspaceId, ingestion.documentId);
    if (!document) {
      candidates.push({ ...base, eligible: false, reason: "document record missing" });
      continue;
    }
    if (document.organizationId !== ingestion.organizationId) {
      candidates.push({ ...base, eligible: false, reason: "tenant mismatch" });
      continue;
    }
    if (document.currentVersionId !== null) {
      candidates.push({ ...base, eligible: false, reason: "already has a current version" });
      continue;
    }

    const file = await files.get(ingestion.storedFileId);
    if (!file) {
      candidates.push({ ...base, eligible: false, reason: "stored file row missing" });
      continue;
    }
    if (file.ownerType !== "org" || file.ownerId !== ingestion.organizationId) {
      candidates.push({ ...base, eligible: false, reason: "stored file owned elsewhere" });
      continue;
    }

    const head = await storage.head(file.key);
    const checksumMatches = file.sha256 === ingestion.checksum;
    const sizeMatches = file.size === ingestion.byteSize;
    const withChecks = { ...base, checksumMatches, objectPresent: head.exists };

    if (!head.exists) {
      candidates.push({ ...withChecks, eligible: false, reason: "object missing from storage" });
      continue;
    }
    if (!checksumMatches) {
      candidates.push({ ...withChecks, eligible: false, reason: "checksum mismatch" });
      continue;
    }
    if (!sizeMatches) {
      candidates.push({ ...withChecks, eligible: false, reason: "byte-size mismatch" });
      continue;
    }

    const existing = await versions.getByNumber(ingestion.workspaceId, ingestion.documentId, 1);
    const reason = existing
      ? "eligible (adopts the existing import version)"
      : "eligible (creates an initial import version)";
    candidates.push({ ...withChecks, eligible: true, reason });
  }

  return candidates;
}

function report(candidates: Candidate[]): void {
  for (const c of candidates) {
    // Deliberately no storage key, no bytes, no token, no signed URL.
    console.log(
      [
        `${c.eligible ? "ELIGIBLE" : "SKIP    "}`,
        `org=${c.organizationId}`,
        `ws=${c.workspaceId}`,
        `doc=${c.documentId}`,
        `ingestion=${c.ingestionId}`,
        `file=${c.storedFileId}`,
        `status=${c.status}`,
        `bytes=${c.byteSize}`,
        `checksum=${c.checksumMatches ? "ok" : "unverified"}`,
        `object=${c.objectPresent ? "present" : "absent"}`,
        `— ${c.reason}`,
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const { apply, expect } = parseArgs(process.argv.slice(2));

  const candidates = await findCandidates();
  const eligible = candidates.filter((c) => c.eligible);

  console.log(`\nExamined ${candidates.length} unfinished ingestion(s).`);
  report(candidates);
  console.log(`\nEligible: ${eligible.length}`);

  if (!apply) {
    console.log("\nDry run — no changes were written. Re-run with --apply --expect=<n>.");
    return;
  }

  // The guard is the point of the whole script: an apply that was reviewed
  // against N records must not silently mutate N+1 when the data moved.
  if (expect === null || !Number.isInteger(expect)) {
    console.error("\nRefusing to apply: --apply requires --expect=<n>.");
    process.exitCode = 1;
    return;
  }
  if (eligible.length !== expect) {
    console.error(
      `\nRefusing to apply: expected exactly ${expect} eligible record(s) but found ${eligible.length}.`,
    );
    process.exitCode = 1;
    return;
  }

  const service = appContainer.resolve<DocumentIngestionService>(Tokens.DocumentIngestionService);
  let promoted = 0;
  let failed = 0;

  for (const c of eligible) {
    const outcome = await service.processIngestion(c.workspaceId, c.ingestionId);
    if (outcome.status === "completed") {
      promoted += 1;
      console.log(
        `REPAIRED doc=${c.documentId} version=${outcome.version.id} ` +
          `number=${outcome.version.versionNumber} ${outcome.created ? "created" : "adopted"}`,
      );
    } else if (outcome.status === "failed") {
      failed += 1;
      console.error(`FAILED   doc=${c.documentId} reason=${outcome.reason}`);
    } else {
      console.log(`SKIPPED  doc=${c.documentId} — ${outcome.detail}`);
    }
  }

  console.log(`\nApplied. promoted=${promoted} failed=${failed}`);
}

main()
  .catch((error) => {
    console.error("Backfill aborted:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    // The container owns the Prisma client; let the process settle rather than
    // forcing an exit that could interrupt an in-flight write.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
