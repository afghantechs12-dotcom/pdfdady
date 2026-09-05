/**
 * The body-policy ledger: every route that can receive a request body, and the
 * policy assigned to it.
 *
 * ## Why a ledger and not just a class function
 *
 * `policy.mjs` decides a class from the path, so no route can be missing a
 * CEILING. What a path-shaped rule cannot notice is a NEW route arriving with
 * nobody having thought about it: whether it authenticates before it reads,
 * whether the ceiling it inherits is the right one for what it accepts, whether
 * it needs a tighter one of its own. This file is where that thought is
 * recorded, and `bodyRoutes.test.ts` fails when a route exists without an entry
 * or an entry exists without its route.
 *
 * ## Membership rule — every mutating route, not every body READER
 *
 * A route is listed if it exports POST/PUT/PATCH/DELETE, or if it reads a body
 * on any method. Deliberately wider than "calls `.json()`": `app/api/auth/
 * register/route.ts` is `export const POST = signupPost`, so a rule that looked
 * for a body read in the file itself would have missed it, and the next
 * delegating route would be missed the same way. Node parses a body on any
 * method, so "can receive" is the honest boundary. Seven listed routes read no
 * body at all; they are still listed, because the reason they are safe is
 * "reads nothing", which is a policy, and a later edit that adds a read should
 * not be silent.
 *
 * ## Fields
 *
 * `reads`     which body accessor(s) the route reaches for, or `none`.
 * `auth`      what must be true before the body is read. `session` = a workspace
 *             actor is resolved; `admin` = an admin session; `anonymous` = public
 *             by design.
 * `limit`     the route's OWN ceiling symbol, or `null` when it relies on the
 *             class ceiling in `policy.mjs`. Not a byte count: the number lives
 *             in one place, the source, and copying it here would be the second
 *             place to change.
 * `evidence`  strings that must still appear in the route source. This is what
 *             makes the ledger falsifiable rather than decorative: delete the
 *             `requireAdmin` call or rename `MAX_BODY_BYTES` and the test goes
 *             red instead of the ledger quietly describing a route that no
 *             longer does what it says.
 *
 * Class is NOT stored. It is computed from the path by `classifyPath`, so there
 * is one implementation of the class rule and the ledger cannot disagree with
 * the guard that enforces it.
 */
export const BODY_ROUTES = [
  { route: "/api/admin/ai-tools/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/blog/[slug]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/blog/author", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/faq/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/features/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/login", methods: ["POST"], reads: "json", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/admin/logout", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/admin/nav", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/pages/[key]", methods: ["PUT"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/password", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/pricing/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/reorder", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/seo", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/server-tools/[slug]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/setup", methods: ["POST"], reads: "json", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/admin/site", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/tool-categories/[id]", methods: ["PUT"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/tools/[slug]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/tools/bulk", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/tools", methods: ["POST"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/trust/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/admin/use-cases/[id]", methods: ["PUT", "DELETE"], reads: "json", auth: "admin", limit: null, evidence: ["requireAdmin"] },
  { route: "/api/analytics/events", methods: ["POST"], reads: "text", auth: "anonymous", limit: "MAX_BODY_BYTES", evidence: ["MAX_BODY_BYTES"] },
  { route: "/api/auth/login", methods: ["POST"], reads: "readBoundedJson", auth: "anonymous (credential endpoint)", limit: "MAX_AUTH_BODY_BYTES", evidence: ["readBoundedJson"] },
  { route: "/api/auth/logout", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/auth/register", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/auth/signup", methods: ["POST"], reads: "readBoundedJson", auth: "anonymous (credential endpoint)", limit: "MAX_AUTH_BODY_BYTES", evidence: ["readBoundedJson"] },
  { route: "/api/billing/checkout", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/billing/portal", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/billing/webhook", methods: ["POST"], reads: "json,text", auth: "stripe signature", limit: "MAX_WEBHOOK_BODY_BYTES", evidence: ["MAX_WEBHOOK_BODY_BYTES"] },
  { route: "/api/csp-report", methods: ["POST", "PUT", "PATCH", "DELETE"], reads: "text", auth: "anonymous", limit: "MAX_BODY_BYTES", evidence: ["MAX_BODY_BYTES"] },
  { route: "/api/jobs/[id]/cancel", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/jobs/[id]/retry", methods: ["POST"], reads: "none", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/jobs/[id]/save-to-workspace", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/jobs", methods: ["POST"], reads: "submitToolJob,submitProcessingJob", auth: "anonymous", limit: "TOOLS_MAX_BODY_BYTES", evidence: ["submitToolJob"] },
  { route: "/api/storage/multipart/[...segments]", methods: ["POST", "PUT", "DELETE"], reads: "arrayBuffer,json", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/storage/multipart", methods: ["POST"], reads: "json", auth: "anonymous", limit: null, evidence: [] },
  { route: "/api/tools/[slug]", methods: ["POST"], reads: "submitToolJob", auth: "anonymous", limit: "TOOLS_MAX_BODY_BYTES", evidence: ["submitToolJob"] },
  { route: "/api/workspaces/[workspaceId]/archive", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/commands", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/attachments/[attachmentId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/attachments", methods: ["POST"], reads: "workspaceUploadGate", auth: "session", limit: "workspaceUploadGate", evidence: ["getWorkspaceActor", "workspaceUploadGate"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/autosave/mark-saved", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/autosave/recover", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/autosave", methods: ["POST", "DELETE"], reads: "json", auth: "session", limit: "MAX_AUTOSAVE_BODY_BYTES", evidence: ["getWorkspaceActor", "rejectOversizedBody"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/bookmarks/[bookmarkId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/bookmarks", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/messages/[messageId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/messages", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/reopen", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/resolve", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comments", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comparisons/[comparisonId]/cancel", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comparisons/[comparisonId]/retry", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/comparisons", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/favorite", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/lifecycle", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/metadata", methods: ["PUT"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/opened", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/outline/[outlineItemId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/outline", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/permissions/[grantId]", methods: ["DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/permissions", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]", methods: ["PATCH"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/search-index/reindex", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/statistics", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/tags", methods: ["POST", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/versions/[versionNumber]/restore", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/versions", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload", methods: ["POST"], reads: "workspaceUploadGate", auth: "session", limit: "workspaceUploadGate", evidence: ["getWorkspaceActor", "workspaceUploadGate"] },
  { route: "/api/workspaces/[workspaceId]/documents/bulk", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/documents/upload", methods: ["POST"], reads: "workspaceUploadGate", auth: "session", limit: "workspaceUploadGate", evidence: ["getWorkspaceActor", "workspaceUploadGate"] },
  { route: "/api/workspaces/[workspaceId]/folders/[folderId]/lifecycle", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/folders/[folderId]", methods: ["PATCH"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/folders", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/members/[userId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/members", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/operations/[operationId]/cancel", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/operations/[operationId]/retry", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/projects/[projectId]/lifecycle", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/projects/[projectId]", methods: ["PATCH"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/projects", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/restore", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]", methods: ["PATCH"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/search", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/session", methods: ["POST", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/session/split", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/session/tabs/[tabId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/session/tabs", methods: ["POST", "PATCH"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/smart-collections/[collectionId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/smart-collections/preview", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/smart-collections", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/tags/[tagId]", methods: ["PATCH", "DELETE"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/tags/bulk", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/[workspaceId]/tags", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces/provision-default", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
  { route: "/api/workspaces", methods: ["POST"], reads: "json", auth: "session", limit: null, evidence: ["getWorkspaceActor"] },
];
