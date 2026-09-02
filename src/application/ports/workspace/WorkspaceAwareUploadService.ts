import type { UploadInput, UploadInputStream, UploadResult } from "@/src/application/ports/storage/UploadService";
import type { WorkspaceUploadResult } from "@/src/domain/entities/DocumentIngestion";
import type { ActorContext } from "@/src/application/services/WorkspaceService";

export interface IWorkspaceAwareUploadService {
  /**
   * Upload a file to a specific workspace with destination validation.
   * This is the main entry point for workspace-aware uploads.
   */
  uploadToWorkspace(
    actor: ActorContext,
    workspaceId: string,
    input: UploadInput & {
      folderId?: string | null;
      projectId?: string | null;
      name?: string;
    },
  ): Promise<WorkspaceUploadResult>;

  /**
   * Validate destination for upload
   */
  validateDestination(
    actor: ActorContext,
    workspaceId: string,
    folderId?: string | null,
    projectId?: string | null,
  ): Promise<boolean>;

  /**
   * Upload a file using the standard upload service
   */
  upload(input: UploadInput): Promise<UploadResult>;

  /**
   * Upload a stream using the standard upload service
   */
  uploadStream(input: UploadInputStream): Promise<UploadResult>;
}
