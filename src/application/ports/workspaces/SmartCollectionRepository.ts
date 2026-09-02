import type { SmartCollection } from "@/src/domain/entities/SmartCollection";

export interface CreateSmartCollectionInput {
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  /** Grammar version the definition was validated under. */
  queryVersion: number;
  /** Canonical serialized query definition. */
  queryJson: string;
  createdById: string;
}

export interface SmartCollectionListQuery {
  workspaceId: string;
  limit: number;
  /** Exclusive cursor: return collections ordered after this normalized name. */
  afterNormalizedName?: string;
}

export interface UpdateSmartCollectionInput {
  name?: string;
  normalizedName?: string;
  queryVersion?: number;
  queryJson?: string;
}

/**
 * Workspace-scoped smart collection persistence.
 *
 * There is deliberately no method for persisted document membership: a
 * collection's membership is evaluated from live DocumentRecord and
 * DocumentTag data on every read, and any stored member rows would make that
 * membership stale the moment a tag changed.
 */
export interface SmartCollectionRepository {
  create(input: CreateSmartCollectionInput): Promise<SmartCollection>;

  getById(workspaceId: string, collectionId: string): Promise<SmartCollection | null>;

  getByNormalizedName(workspaceId: string, normalizedName: string): Promise<SmartCollection | null>;

  /** Ordered by normalized name, bounded by the domain listing cap. */
  list(query: SmartCollectionListQuery): Promise<SmartCollection[]>;

  /**
   * Compare-and-swap on `revision`. Returns null when no row matched, which is
   * how a stale revision and a missing collection are reported without
   * distinguishing them to the caller.
   */
  update(
    workspaceId: string,
    collectionId: string,
    expectedRevision: number,
    data: UpdateSmartCollectionInput,
  ): Promise<SmartCollection | null>;

  /** Deletes a collection. Returns false when nothing matched in this Workspace. */
  delete(workspaceId: string, collectionId: string): Promise<boolean>;

  /** How many collections a Workspace holds. */
  countForWorkspace(workspaceId: string): Promise<number>;
}
