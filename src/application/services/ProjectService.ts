import type { Project, ProjectLifecycleState, ProjectStatus } from "@/src/domain/entities/Project";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { ActorContext } from "./WorkspaceService";
import type { WorkspaceService } from "./WorkspaceService";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "./workspaceNormalization";
import { generateOrderKeyBetween } from "./orderKey";

const MAX_PROJECT_LIMIT = 100;

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly workspaces: WorkspaceService,
  ) {}

  async list(actor: ActorContext, workspaceId: string, cursor?: string, limit = 25) {
    await this.workspaces.get(actor, workspaceId);
    return this.projects.list({
      workspaceId,
      lifecycleState: "active",
      cursor,
      limit: Math.min(Math.max(limit, 1), MAX_PROJECT_LIMIT),
    });
  }

  async get(actor: ActorContext, workspaceId: string, projectId: string): Promise<Project> {
    await this.workspaces.get(actor, workspaceId);
    const project = await this.projects.getById(workspaceId, projectId);
    if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Project not found.");
    return project;
  }

  async create(
    actor: ActorContext,
    workspaceId: string,
    input: { name: string; slug?: string; description?: string | null },
  ) {
    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    if (workspace.organizationId !== actor.organizationId) throw new DomainError("Cross-organization project creation is not permitted.");
    const name = input.name.trim();
    const normalizedName = normalizeWorkspaceName(name);
    const slug = input.slug?.trim() || name;
    const normalizedSlug = normalizeWorkspaceSlug(slug);
    if (!name || !normalizedName || !normalizedSlug) throw new DomainError("Project name is required.");

    const maxKey = await this.projects.maxOrderKey(workspaceId);
    const orderKey = generateOrderKeyBetween(maxKey, null);

    return this.projects.create({
      workspaceId,
      organizationId: actor.organizationId,
      name,
      normalizedName,
      slug,
      normalizedSlug,
      description: input.description ?? null,
      orderKey,
      createdById: actor.userId,
    });
  }

  async update(
    actor: ActorContext,
    workspaceId: string,
    projectId: string,
    input: { name?: string; slug?: string; description?: string | null; status?: ProjectStatus; revision: number },
  ) {
    await this.workspaces.get(actor, workspaceId, true);
    const project = await this.projects.getById(workspaceId, projectId);
    if (!project) throw new NotFoundError("Project not found.");
    const data: any = { revision: input.revision };
    if (input.name !== undefined) {
      data.name = input.name.trim();
      data.normalizedName = normalizeWorkspaceName(data.name);
    }
    if (input.slug !== undefined) {
      data.slug = input.slug.trim();
      data.normalizedSlug = normalizeWorkspaceSlug(data.slug);
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.status !== undefined) data.status = input.status;
    return this.projects.update(workspaceId, projectId, data);
  }

  async move(
    actor: ActorContext,
    workspaceId: string,
    projectId: string,
    input: { afterId?: string | null; beforeId?: string | null; revision: number },
  ) {
    await this.workspaces.get(actor, workspaceId, true);
    const project = await this.projects.getById(workspaceId, projectId);
    if (!project) throw new NotFoundError("Project not found.");

    let loKey: string | null = null;
    let hiKey: string | null = null;
    if (input.afterId) {
      const after = await this.projects.getById(workspaceId, input.afterId);
      if (!after || after.workspaceId !== workspaceId) throw new DomainError("Reference project not found in same workspace.");
      loKey = after.orderKey;
    }
    if (input.beforeId) {
      const before = await this.projects.getById(workspaceId, input.beforeId);
      if (!before || before.workspaceId !== workspaceId) throw new DomainError("Reference project not found in same workspace.");
      hiKey = before.orderKey;
    }
    if (!input.afterId && !input.beforeId) {
      const maxKey = await this.projects.maxOrderKey(workspaceId);
      loKey = maxKey;
    }
    const orderKey = generateOrderKeyBetween(loKey, hiKey);
    return this.projects.update(workspaceId, projectId, { orderKey, revision: input.revision });
  }

  async setLifecycle(actor: ActorContext, workspaceId: string, projectId: string, state: ProjectLifecycleState) {
    await this.workspaces.get(actor, workspaceId, true);
    const project = await this.projects.getById(workspaceId, projectId);
    if (!project) throw new NotFoundError("Project not found.");
    return this.projects.setLifecycle(workspaceId, projectId, state, actor.userId);
  }
}
