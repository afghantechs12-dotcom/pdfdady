/**
 * DI tokens — symbols used to resolve services from the container. Using
 * symbols (not string keys) avoids naming collisions and keeps the wiring
 * type-checkable at the call site via `container.resolve<T>(Tokens.X)`.
 */
export const Tokens = {
  Config: Symbol("Config"),
  Logger: Symbol("Logger"),
  PrismaClient: Symbol("PrismaClient"),
  FeatureFlagRepository: Symbol("FeatureFlagRepository"),
  JobRepository: Symbol("JobRepository"),
  FeatureFlagService: Symbol("FeatureFlagService"),
  Queue: Symbol("Queue"),
  Worker: Symbol("Worker"),
  HealthChecks: Symbol("HealthChecks"),
  // Storage (M2.2)
  ObjectStorage: Symbol("ObjectStorage"),
  SignedUrlService: Symbol("SignedUrlService"),
  FileMetadataRepository: Symbol("FileMetadataRepository"),
  UploadService: Symbol("UploadService"),
  DownloadService: Symbol("DownloadService"),
  MultipartUpload: Symbol("MultipartUpload"),
  // Queue / scheduler / events (M2.3)
  JobScheduler: Symbol("JobScheduler"),
  JobEvents: Symbol("JobEvents"),
  // Auth (M2.4)
  UserProvider: Symbol("UserProvider"),
  SessionProvider: Symbol("SessionProvider"),
  OrganizationProvider: Symbol("OrganizationProvider"),
  RoleProvider: Symbol("RoleProvider"),
  AuditLogRepository: Symbol("AuditLogRepository"),
  WorkspaceRepository: Symbol("WorkspaceRepository"),
  WorkspaceMembershipRepository: Symbol("WorkspaceMembershipRepository"),
  WorkspaceAuthorizationResolver: Symbol("WorkspaceAuthorizationResolver"),
  WorkspaceService: Symbol("WorkspaceService"),
  WorkspaceMembershipService: Symbol("WorkspaceMembershipService"),
  ProjectRepository: Symbol("ProjectRepository"),
  ProjectService: Symbol("ProjectService"),
  FolderRepository: Symbol("FolderRepository"),
  FolderService: Symbol("FolderService"),
  DocumentRecordRepository: Symbol("DocumentRecordRepository"),
  DocumentRecordService: Symbol("DocumentRecordService"),
  AuthService: Symbol("AuthService"),
  // Workspace-aware upload service + M7.4 ingestion persistence
  DocumentIngestionRepository: Symbol("DocumentIngestionRepository"),
  WorkspaceAwareUploadService: Symbol("WorkspaceAwareUploadService"),
  /** Promotes a pending ingestion into a document's initial `import` version. */
  DocumentIngestionService: Symbol("DocumentIngestionService"),
  AutosaveDraftRepository: Symbol("AutosaveDraftRepository"),
  AutosaveService: Symbol("AutosaveService"),
  DocumentVersionRepository: Symbol("DocumentVersionRepository"),
  VersionService: Symbol("VersionService"),
  // M7.7 — tags, document tags, smart collections
  TagRepository: Symbol("TagRepository"),
  DocumentTagRepository: Symbol("DocumentTagRepository"),
  SmartCollectionRepository: Symbol("SmartCollectionRepository"),
  TagService: Symbol("TagService"),
  // M7.8 — search index
  SearchDocumentRepository: Symbol("SearchDocumentRepository"),
  SearchChunkRepository: Symbol("SearchChunkRepository"),
  SearchIndexPort: Symbol("SearchIndexPort"),
  SearchService: Symbol("SearchService"),
  // M7.9 — document metadata, bookmarks, outlines, attachments
  DocumentMetadataRepository: Symbol("DocumentMetadataRepository"),
  BookmarkRepository: Symbol("BookmarkRepository"),
  OutlineItemRepository: Symbol("OutlineItemRepository"),
  AttachmentRepository: Symbol("AttachmentRepository"),
  MetadataService: Symbol("MetadataService"),
  // M7.10 — comments, sharing and asynchronous collaboration
  CommentThreadRepository: Symbol("CommentThreadRepository"),
  CommentMessageRepository: Symbol("CommentMessageRepository"),
  DocumentPermissionGrantRepository: Symbol("DocumentPermissionGrantRepository"),
  CommentService: Symbol("CommentService"),
  // M7.11 — document statistics and version comparison
  DocumentStatisticsRepository: Symbol("DocumentStatisticsRepository"),
  ComparisonOperationRepository: Symbol("ComparisonOperationRepository"),
  ComparisonResultRepository: Symbol("ComparisonResultRepository"),
  StatisticsService: Symbol("StatisticsService"),
  // M7.12 — multi-document tabs and session restoration
  WorkspaceSessionRepository: Symbol("WorkspaceSessionRepository"),
  TabService: Symbol("TabService"),
  // M7.13 — split view and navigation
  SplitViewService: Symbol("SplitViewService"),
  // M7.14 — command palette and operation center
  CommandPaletteService: Symbol("CommandPaletteService"),
  OperationCenterService: Symbol("OperationCenterService"),
  // Observability (M2.5)
  Metrics: Symbol("Metrics"),
  Tracing: Symbol("Tracing"),
  Analytics: Symbol("Analytics"),
  ErrorReporter: Symbol("ErrorReporter"),
  // Tool jobs (M3.c) — drives server PDF tools through the queue + storage
  PdfToolJobService: Symbol("PdfToolJobService"),

  // ---- Unified processing pipeline -----------------------------------------
  // The application service every entry point (API route, worker) must go
  // through to touch a processing job, plus the processor registry the worker
  // dispatches on and the usage recorder that records each attempt.
  ProcessingJobService: Symbol("ProcessingJobService"),
  ToolProcessorRegistry: Symbol("ToolProcessorRegistry"),
  ProcessingUsageRecorder: Symbol("ProcessingUsageRecorder"),
  // Returns jobs abandoned by a dead worker to the queue. Type-agnostic, so it
  // covers the legacy pdf-tool types too: the stranding is a property of the
  // shared claim, not of one job type.
  StuckJobRecoveryService: Symbol("StuckJobRecoveryService"),
  // ---- Usage metering + entitlements ---------------------------------------
  // The counter/ledger substrate, the plan lookup billing will one day replace,
  // and the one service that admits and settles server-side usage. Nothing else
  // may write a counter.
  UsageRepository: Symbol("UsageRepository"),
  EntitlementProvider: Symbol("EntitlementProvider"),
  UsageMeteringService: Symbol("UsageMeteringService"),
  // The client-ingest half. Separate token from UsageMeteringService because it
  // is the half a browser can reach, and it must have no way to touch a counter.
  ProductAnalyticsService: Symbol("ProductAnalyticsService"),
  // The read half. A third token, for the same reason as the second: this one is
  // reachable from an admin page, and it must have no way to write anything.
  UsageAnalyticsReadService: Symbol("UsageAnalyticsReadService"),
  // ---- Billing / subscriptions ---------------------------------------------
  // The paid-entitlement substrate. `BillingProvider` is null when the deployment
  // has no Stripe credentials, and BillingService fails clearly rather than
  // inventing a price — so resolving these tokens is always safe.
  BillingRepository: Symbol("BillingRepository"),
  BillingProvider: Symbol("BillingProvider"),
  BillingService: Symbol("BillingService"),
  // Premium editor (M3.e) — headless editor foundation, its services, plugin
  // registry, and a factory that produces per-instance EditorDocumentService.
  EditorSelectionService: Symbol("EditorSelectionService"),
  EditorLayerService: Symbol("EditorLayerService"),
  EditorSerializer: Symbol("EditorSerializer"),
  EditorPluginRegistry: Symbol("EditorPluginRegistry"),
  EditorServiceFactory: Symbol("EditorServiceFactory"),
} as const;