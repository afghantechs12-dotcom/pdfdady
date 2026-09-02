import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { TagService } from "./TagService";
import type { Tag } from "@/src/domain/entities/Tag";
import type { SmartCollection } from "@/src/domain/entities/SmartCollection";

export function tagService(): TagService {
  return appContainer.resolve<TagService>(Tokens.TagService);
}

/**
 * Client-facing shape of a tag.
 *
 * `organizationId` and `workspaceId` are withheld: the caller already addressed
 * the Workspace to reach this route, so echoing the tenancy columns adds nothing
 * a client needs and gives a probe a second place to compare identifiers.
 */
export interface TagResponse {
  id: string;
  name: string;
  normalizedName: string;
  color: string | null;
  createdById: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export function toTagResponse(tag: Tag): TagResponse {
  return {
    id: tag.id,
    name: tag.name,
    normalizedName: tag.normalizedName,
    color: tag.color,
    createdById: tag.createdById,
    revision: tag.revision,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

/**
 * Client-facing shape of a smart collection.
 *
 * The canonical query is returned because the builder has to render it back —
 * it is the client's own validated definition, not internal state. `degraded`
 * is surfaced rather than hidden so the UI can say the definition is unreadable
 * instead of silently presenting an empty collection as an accurate one.
 */
export interface SmartCollectionResponse {
  id: string;
  name: string;
  normalizedName: string;
  queryVersion: number;
  query: SmartCollection["query"];
  degraded: boolean;
  createdById: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export function toSmartCollectionResponse(collection: SmartCollection): SmartCollectionResponse {
  return {
    id: collection.id,
    name: collection.name,
    normalizedName: collection.normalizedName,
    queryVersion: collection.queryVersion,
    query: collection.query,
    degraded: collection.queryDegraded,
    createdById: collection.createdById,
    revision: collection.revision,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
}
