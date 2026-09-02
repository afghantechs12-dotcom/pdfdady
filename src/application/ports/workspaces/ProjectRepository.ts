import type { Project, ProjectLifecycleState } from "@/src/domain/entities/Project";

export interface ProjectListQuery {
  workspaceId: string;
  lifecycleState?: ProjectLifecycleState;
  cursor?: string;
  limit: number;
}

export interface CreateProjectInput {
  workspaceId: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  slug: string;
  normalizedSlug: string;
  description?: string | null;
  orderKey: string;
  createdById: string;
}

export interface ProjectRepository {
  list(query: ProjectListQuery): Promise<{ items: Project[]; nextCursor: string | null }>;
  getById(workspaceId: string, projectId: string): Promise<Project | null>;
  create(input: CreateProjectInput): Promise<Project>;
  update(
    workspaceId: string,
    projectId: string,
    data: Partial<Pick<Project, "name" | "normalizedName" | "slug" | "normalizedSlug" | "description" | "status" | "orderKey" | "revision">>,
  ): Promise<Project>;
  setLifecycle(workspaceId: string, projectId: string, state: ProjectLifecycleState, actorId: string): Promise<Project>;
  /** Highest orderKey currently used among active projects in the workspace, or null if empty. */
  maxOrderKey(workspaceId: string): Promise<string | null>;
}
