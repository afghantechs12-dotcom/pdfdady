import type { Workspace, WorkspaceLifecycleState } from "@/src/domain/entities/Workspace";

/**
 * A Workspace listing for one actor.
 *
 * `actorUserId` and `inheritedWorkspaceId` are not decoration: the listing must
 * return exactly the Workspaces this actor can also open. Listing every
 * Workspace in the organization is what let the picker advertise Workspaces that
 * `WorkspaceService.get` then refused.
 */
export interface WorkspaceListQuery {
  organizationId: string;
  /** The actor whose memberships decide visibility. */
  actorUserId: string;
  /**
   * The organization's default Workspace, which every organization member
   * reaches by inheritance rather than by an explicit membership row. Null when
   * the organization has no default.
   */
  inheritedWorkspaceId?: string | null;
  lifecycleState?: WorkspaceLifecycleState;
  cursor?: string;
  limit: number;
}

export interface CreateWorkspaceInput {
  organizationId: string;
  name: string;
  normalizedName: string;
  slug: string;
  normalizedSlug: string;
  description?: string | null;
  createdById: string;
}

export interface WorkspaceRepository {
  list(query: WorkspaceListQuery): Promise<{ items: Workspace[]; nextCursor: string | null }>;
  getById(organizationId: string, workspaceId: string): Promise<Workspace | null>;
  /**
   * Creates the Workspace **and its creator's owner membership as one atomic
   * operation**. A returned Workspace is therefore already openable by
   * `createdById`; there is no window in which it exists without an owner.
   *
   * Rejects a duplicate name/slug within the organization as a `DomainError`
   * rather than letting the unique-index violation surface as a 500.
   */
  create(input: CreateWorkspaceInput): Promise<Workspace>;
  update(organizationId: string, workspaceId: string, data: Partial<Pick<Workspace, "name" | "normalizedName" | "slug" | "normalizedSlug" | "description" | "revision">>): Promise<Workspace>;
  setLifecycle(organizationId: string, workspaceId: string, state: WorkspaceLifecycleState, actorId: string): Promise<Workspace>;
}
