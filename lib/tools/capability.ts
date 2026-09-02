import { isFunctional, tools as TOOLS, type Tool, type ToolCategory, type ToolStatus } from "@/data/tools";
import { getServerToolConfig } from "@/data/serverToolConfig";
import { MAX_SIZE } from "@/lib/validation/fileSchemas";
import {
  executionModeForStatus,
  REMOTE_JOB_TOOL_SLUGS,
  type ToolExecutionMode,
} from "./executionPolicy";
import {
  PROCESSING_MODE_COPY,
  processingModeForStatus,
  type ProcessingMode,
} from "./processingMode";

/**
 * The canonical product-capability model: one row per tool, every dimension a
 * public surface needs, all of it derived.
 *
 * ## Why this module exists on top of the registry
 *
 * `data/tools.ts` answers "does this tool exist and does it work". Marketing,
 * pricing, the catalog and the tool pages were each answering four further
 * questions from their own local knowledge — where it runs, what the wait looks
 * like, whether an account is needed, what the size ceiling is — and a fact
 * re-derived per surface is a fact that drifts. `ToolStatus` alone cannot answer
 * them: it collapses "runs on our servers" into one value with no model of what
 * the user is promised while waiting.
 *
 * ## The four dimensions kept deliberately apart
 *
 *  - **Execution location** — whose CPU does the work. A privacy claim.
 *  - **Processing lifecycle** — what the user is promised about waiting. A UX
 *    claim. A server tool must not inherit an async-job promise merely because
 *    it runs in the cloud, which is exactly what a single `remote_job` value
 *    invited.
 *  - **Build state** — what this repository implements (`status`, `pipelinePilot`).
 *  - **Environment state** — what this deployment has switched on. Deliberately
 *    NOT a field here: the unified-pipeline flag is read per request by
 *    `lib/server/processingPilot.ts`, and freezing it into a module-load
 *    constant is how a build-time snapshot comes to disagree with a route.
 *
 * Plan entitlement is a fifth axis and lives in `src/domain/metering` +
 * `src/domain/billing`; `planRequirement` below records only that no tool is
 * plan-gated today, which is a checkable claim rather than a hopeful one.
 *
 * Nothing here is hand-maintained per tool except the facts the code cannot
 * infer — `PIPELINE_PILOT_SLUGS`, `OUTPUT_EXCEPTIONS` and
 * `OPAQUE_PDF_OUTPUT_SLUGS` — and each is checked against the implementation it
 * describes by `capability.test.ts`. (An earlier version of this comment named a
 * `WORKSPACE_SUPPORTED` constant that never existed and a guard that was never
 * written; `workspaceSupported` was a bare `false` literal, and then a copy of
 * `editorOpenableOutput`. It is now `workspaceSaveableOutput`, derived from what
 * Workspace can ingest.)
 *
 * ## The two OUTPUT questions, deliberately apart
 *
 *  - `editorOpenableOutput` — can this editor PARSE and edit the bytes.
 *  - `workspaceSaveableOutput` — can a Workspace PERSIST the bytes and hand them
 *    back later as one logical document.
 *
 * They agreed for every tool, so one was written as a copy of the other, and the
 * agreement stopped being a fact about the product and became a fact about that
 * line: `protect-pdf` was refused a Workspace because pdf.js cannot open an
 * encrypted PDF, which Workspace ingestion never needed to do (it checks the
 * `%PDF-` signature and the checksum, and stores the bytes — see
 * `DocumentIngestionService.promote`). Each question is now answered from its own
 * side, and `capability.test.ts` proves the two answers really do differ.
 */

/** Whose machine runs the work. `none` = nothing runs, because nothing is built. */
export type ExecutionLocation = "browser" | "pdfdadi-server" | "none";

/**
 * What the user is promised about waiting.
 *
 *  - `immediate-local` — runs in the page; no job, no queue, no network wait.
 *  - `sync-server` — one HTTP request that returns the finished bytes. The
 *    legacy `POST /api/tools/[slug]` route still implements this lifecycle; no
 *    tool's UI uses it (see PROCESSING_LIFECYCLE_NOTES), so no capability row
 *    claims it. Kept in the vocabulary because the route is reachable, and a
 *    lifecycle the codebase can perform but cannot name is a lifecycle a future
 *    surface will mislabel.
 *  - `async-job` — submitted as a job, returns an id, streams progress, can be
 *    cancelled.
 *  - `unavailable` — not executable.
 */
export type ProcessingLifecycle =
  | "immediate-local"
  | "sync-server"
  | "async-job"
  | "unavailable";

/** Whether using the tool needs an account. */
export type AccountRequirement = "none" | "account";

/** The lowest plan that may run the tool. `none` = no plan gate exists. */
export type PlanRequirement = "none" | "free" | "pro" | "business";

/**
 * What a successful run hands back.
 *
 * `none` is not "we do not know" — it is "nothing runs", which is the only honest
 * answer for a planned tool.
 */
export type OutputKind = "pdf" | "image" | "archive" | "office-document" | "none";

/**
 * The two facts about a tool's OUTPUT that the registry cannot infer.
 *
 * Everything else in this module is derived from `status`. These are not: the
 * output format is decided inside the processor (`lib/pdf/*` for browser tools,
 * `lib/server/toolProcessing.ts` for server ones), and `status` says nothing about
 * it. So they are written down once, here, and `capability.test.ts` checks each
 * entry against the processor that actually produces the bytes rather than
 * trusting this table.
 *
 * Absence means "a single PDF", which is what 29 of the 32 available tools
 * produce. Only the exceptions are listed, so a new PDF tool needs no entry and a
 * new CONVERSION cannot be forgotten silently — the test enumerates every server
 * processor's MIME type and fails on one that disagrees with this map.
 */
const OUTPUT_EXCEPTIONS: Readonly<Record<string, { kind: OutputKind; multi?: boolean }>> = {
  // One image for a one-page PDF, a zip of page images for anything longer.
  "pdf-to-jpg": { kind: "image", multi: true },
  "pdf-to-png": { kind: "image", multi: true },
  "pdf-to-word": { kind: "office-document" },
};

/**
 * Tools whose PDF output the editor cannot open.
 *
 * `protect-pdf` runs `qpdf --encrypt … 256`: the bytes are a valid PDF that
 * requires the user's password to parse. The result screen has the password the
 * user typed, but handing it onward to an editor session — and to whatever draft
 * or Workspace copy that session writes — is a bigger decision than a result
 * button, so the honest capability is "not openable here".
 */
const OPAQUE_PDF_OUTPUT_SLUGS: readonly string[] = ["protect-pdf"];

export interface ToolCapability {
  /** Registry identifier. */
  slug: string;
  /** The public route. */
  route: string;
  name: string;
  category: ToolCategory;
  /** What this repository implements. */
  implementationState: ToolStatus;
  /** True when a user can run it today. */
  available: boolean;
  executionLocation: ExecutionLocation;
  /** The user-facing privacy vocabulary, or null when nothing runs. */
  processingMode: ProcessingMode | null;
  processingLifecycle: ProcessingLifecycle;
  /** The execution vocabulary, or null when nothing runs. */
  executionMode: ToolExecutionMode | null;
  accountRequirement: AccountRequirement;
  /** What kind of file the tool hands back. */
  outputKind: OutputKind;
  /**
   * True when the result is a PDF this editor can actually open.
   *
   * Separate from `outputKind === "pdf"` because `protect-pdf` produces a real
   * PDF that is ENCRYPTED: pdf.js needs the password, which the result screen does
   * not have, so offering "Open in Editor" there would offer a failure.
   */
  editorOpenableOutput: boolean;
  /**
   * True when a Workspace can persist this output and later hand it back as one
   * logical document.
   *
   * NOT the same question as `editorOpenableOutput`, and not derived from it.
   * Workspace ingestion never parses the PDF — `WorkspaceAwareUploadService`
   * checks the `%PDF-` signature and the size, and `DocumentIngestionService`
   * verifies the checksum and re-sniffs the header — so an ENCRYPTED PDF stores,
   * gets an initial `import` version and downloads back byte-identically even
   * though no editor here can open it. `protect-pdf` is exactly that case: this
   * flag is true and `editorOpenableOutput` is false.
   */
  workspaceSaveableOutput: boolean;
  /**
   * True when the run can produce more than one file (collapsed into an archive
   * for download). A collection is not a Workspace document, and forcing one into
   * that shape is what "do not fake support" refers to.
   */
  multiOutput: boolean;
  planRequirement: PlanRequirement;
  /**
   * The upload ceiling this tool actually enforces, or null when nothing runs.
   * Per-tool for server tools; the shared client ceiling for browser tools. It
   * is not the plan ceiling — see `getUsagePresentation` consumers for that.
   */
  maxUploadBytes: number | null;
  /** True when the tool is listed publicly. Every tool is; unavailable ones are
   * listed as unavailable rather than hidden, which is the honest choice. */
  publiclyVisible: boolean;
  /**
   * Build state: a retry-capable unified-pipeline implementation exists for this
   * tool. Whether it is serving traffic is environment state, resolved per
   * request by `isProcessingPipelineEnabled`.
   */
  pipelinePilot: boolean;
}

/**
 * Tools with a unified-pipeline (retry-capable) implementation in this build.
 *
 * Mirrors `PILOT_TOOL_SLUG`, and asserted equal to it — imported as a literal
 * rather than from `lib/server/processingPilot.ts` because that module is
 * server-only and this one is read by client components.
 */
const PIPELINE_PILOT_SLUGS: readonly string[] = ["compress-pdf"];

/**
 * Why no capability row claims `sync-server`. Reported, not hidden.
 *
 * The route in question is the legacy `POST /api/tools/[slug]`; the pipeline the
 * 14 server tools actually use is `POST /api/jobs`. Neither path is written as a
 * literal below on purpose: this module is reachable from the browser-tool pages,
 * and `localToolRegression.test.ts` bans those strings from that module graph so
 * a local tool can never acquire a call site to either. A note is not a call
 * site, but the guard matches code and only excuses comments — so the paths stay
 * up here, where they are prose.
 */
export const PROCESSING_LIFECYCLE_NOTES = {
  "sync-server":
    "The legacy synchronous per-tool route still implements a request/response conversion, but no production UI calls it: all 14 server tools submit through the job API and stream SSE progress. No tool is therefore classified sync-server.",
} as const;

/**
 * The lifecycle a status implies.
 *
 * `functional-server` maps to `async-job` because every server tool route
 * renders `ServerToolRunner` or `PipelineToolRunner`, and both submit to
 * `POST /api/jobs`, stream `/progress` over SSE and offer cancel. That is a
 * claim about wiring, so `capability.test.ts` asserts the wiring rather than
 * trusting this line — and asserts no runner posts to the synchronous route.
 */
function lifecycleForStatus(status: ToolStatus): ProcessingLifecycle {
  switch (status) {
    case "functional-client":
      return "immediate-local";
    case "functional-server":
      return "async-job";
    case "planned":
    case "coming-soon-ai":
      return "unavailable";
  }
}

function locationForStatus(status: ToolStatus): ExecutionLocation {
  switch (status) {
    case "functional-client":
      return "browser";
    case "functional-server":
      return "pdfdadi-server";
    case "planned":
    case "coming-soon-ai":
      return "none";
  }
}

function maxUploadBytesFor(tool: Tool): number | null {
  switch (tool.status) {
    case "functional-client":
      return MAX_SIZE;
    case "functional-server":
      return getServerToolConfig(tool.slug)?.maxSizeBytes ?? null;
    case "planned":
    case "coming-soon-ai":
      return null;
  }
}

/**
 * Resolves the output facts for one tool — the two eligibility questions answered
 * from their own side, not from each other.
 *
 * `editorOpenable` asks what pdf.js can parse: a PDF, and not one this build
 * knows is encrypted. `workspaceSaveable` asks what
 * `WorkspaceAwareUploadService` will accept and `DocumentIngestionService` will
 * promote: a single PDF by signature. Neither reads the other's answer.
 *
 * `multi` excludes a run from Workspace but not from the editor, because the two
 * refusals are for different reasons: a collection of page images is not one
 * logical document (there is nothing to be the document), while the editor's
 * refusal is about the bytes it was handed.
 */
function outputFor(tool: Tool): {
  kind: OutputKind;
  editorOpenable: boolean;
  workspaceSaveable: boolean;
  multi: boolean;
} {
  if (!isFunctional(tool)) {
    return { kind: "none", editorOpenable: false, workspaceSaveable: false, multi: false };
  }
  const exception = OUTPUT_EXCEPTIONS[tool.slug];
  const kind = exception?.kind ?? "pdf";
  const multi = exception?.multi ?? false;
  return {
    kind,
    editorOpenable: kind === "pdf" && !OPAQUE_PDF_OUTPUT_SLUGS.includes(tool.slug),
    workspaceSaveable: kind === "pdf" && !multi,
    multi,
  };
}

function capabilityFor(tool: Tool): ToolCapability {
  const status = tool.status;
  const output = outputFor(tool);
  return {
    slug: tool.slug,
    route: tool.href,
    name: tool.name,
    category: tool.category,
    implementationState: status,
    available: isFunctional(tool),
    executionLocation: locationForStatus(status),
    processingMode: processingModeForStatus(status),
    processingLifecycle: lifecycleForStatus(status),
    executionMode: executionModeForStatus(status),
    // No tool requires an account: `resolveJobActor` mints an anonymous owner
    // for a visitor with no session, and the guest plan carries a real
    // allowance. If a tool ever gates on sign-in, this stops being uniform.
    accountRequirement: "none",
    outputKind: output.kind,
    editorOpenableOutput: output.editorOpenable,
    // The Workspace question, answered by what Workspace ingests rather than by
    // what the editor can read. `ResultActions` and the job result panel both
    // read this, which is what keeps one tool from growing its own opinion about
    // the button.
    workspaceSaveableOutput: output.workspaceSaveable,
    multiOutput: output.multi,
    // No per-tool plan gate exists: admission in `lib/server/toolJobSubmit.ts`
    // meters by owner plan, never by slug.
    planRequirement: "none",
    maxUploadBytes: maxUploadBytesFor(tool),
    publiclyVisible: true,
    pipelinePilot: PIPELINE_PILOT_SLUGS.includes(tool.slug),
  };
}

/** The full capability matrix, derived from the registry at module load. */
export const TOOL_CAPABILITIES: readonly ToolCapability[] = TOOLS.map(capabilityFor);

const BY_SLUG: ReadonlyMap<string, ToolCapability> = new Map(
  TOOL_CAPABILITIES.map((c) => [c.slug, c]),
);

/** The capability row for a slug, or null when the slug is unknown. */
export function capabilityForSlug(slug: string): ToolCapability | null {
  return BY_SLUG.get(slug) ?? null;
}

/**
 * Whether this repository implements a tool identity for `slug`.
 *
 * The public inventory is this set and nothing else. The admin store can hold an
 * override entry under any key, and the merge used to append an unknown key as a
 * whole new tool: it was listed in the catalog, counted as available, put in the
 * sitemap when its own `status` said `functional-server`, and linked to a route
 * that 404s — because nothing here answers for it and `assertRemoteJobTool`
 * refuses it. Listing truth, route truth and execution truth disagreed, and the
 * count moved on a CMS edit. Both the merge (`getTools`) and the admin write
 * boundary (`/api/admin/tools`) now ask this question, so a record that cannot
 * be executed also cannot be advertised.
 */
export function isCanonicalToolSlug(slug: string): boolean {
  return BY_SLUG.has(slug);
}

/**
 * The refusal a CMS write gets when it names a tool identity the code does not
 * implement. One string, shared by the create and update boundaries, so the two
 * cannot describe the same policy differently.
 */
export const UNKNOWN_TOOL_IDENTITY_ERROR =
  "Tool identities are owned by the code that implements them. This slug has no implementation, so it cannot be created or edited here.";

// ---- shared product-claim selectors ---------------------------------------
//
// Every public surface reads a claim from here. The point is not tidiness: the
// homepage, the catalog header, the header menu footer and the pricing page were
// each free to count differently, and a page that says "32 tools" beside a page
// that says "31" is the kind of error nobody notices until a user does.
//
// Each selector takes the tool list, because the registry is admin-mergeable at
// runtime and a page renders the merged list, not the compiled one.

/** How many tools a visitor can run today. */
export function getAvailableToolCount(tools: readonly Tool[] = TOOLS): number {
  return tools.filter(isFunctional).length;
}

/** How many available tools run entirely in the browser. */
export function getBrowserToolCount(tools: readonly Tool[] = TOOLS): number {
  return tools.filter((t) => t.status === "functional-client").length;
}

/** How many available tools run as server jobs. */
export function getServerToolCount(tools: readonly Tool[] = TOOLS): number {
  return tools.filter((t) => t.status === "functional-server").length;
}

/** Conventional (non-AI) tools that are not built yet. */
export function getPlannedToolCount(tools: readonly Tool[] = TOOLS): number {
  return tools.filter((t) => t.status === "planned").length;
}

/** AI tools that are not built yet. */
export function getAiComingSoonCount(tools: readonly Tool[] = TOOLS): number {
  return tools.filter((t) => t.status === "coming-soon-ai").length;
}

/** Everything not runnable today, AI and conventional together. */
export function getUnavailableToolCount(tools: readonly Tool[] = TOOLS): number {
  return getPlannedToolCount(tools) + getAiComingSoonCount(tools);
}

/**
 * The two-part execution label: where it runs, and what waiting looks like.
 *
 * Returned as a pair rather than one pre-joined sentence so a badge can show the
 * privacy half alone — which is what `PROCESSING_MODE_COPY` already governs —
 * without the lifecycle half silently disappearing from the pages that need it.
 * `null` for a tool that cannot run: it has no execution to describe, and
 * inventing one is how an unavailable tool comes to look operational.
 */
export interface ToolExecutionLabel {
  /** "Browser" | "Secure cloud" — the existing privacy vocabulary, unchanged. */
  location: string;
  /** "Runs on your device" | "Processed as a background job you can watch". */
  lifecycle: string;
  /** The privacy sentence from PROCESSING_MODE_COPY. */
  privacy: string;
}

const LIFECYCLE_COPY: Record<ProcessingLifecycle, string> = {
  "immediate-local": "Runs on your device — no upload, no queue.",
  "sync-server": "Processed in a single request; the result comes back with it.",
  "async-job":
    "Processed as a background job: progress is reported and you can cancel it.",
  unavailable: "Not available yet.",
};

export function getToolExecutionLabel(
  tool: Pick<Tool, "slug" | "status">,
): ToolExecutionLabel | null {
  const mode = processingModeForStatus(tool.status);
  if (!mode) return null;
  const copy = PROCESSING_MODE_COPY[mode];
  return {
    location: copy.label,
    lifecycle: LIFECYCLE_COPY[lifecycleForStatus(tool.status)],
    privacy: copy.description,
  };
}

/**
 * The lifecycle sentence for a processing *mode*, for surfaces that know the
 * mode but not the slug — `PrivacyNote` takes a `variant`, and every one of its
 * call sites passes a literal.
 *
 * This is only sound while lifecycle is a function of mode, which is true today:
 * every `secure-cloud` tool is `async-job` and every `browser` tool is
 * `immediate-local`. `lifecycleCopyDisagreements()` fails the moment that stops
 * holding, and that failure is the instruction to plumb the slug through instead
 * of loosening this.
 *
 * ponytail: mode-level shortcut rather than slug plumbing through ~30 tool page
 * call sites; plumb the slug when the first sync-server tool ships a UI.
 */
export function getLifecycleCopyForMode(mode: ProcessingMode): string | null {
  switch (mode) {
    case "browser":
      return LIFECYCLE_COPY["immediate-local"];
    case "secure-cloud":
      return LIFECYCLE_COPY["async-job"];
    case "workspace":
      // Not a tool execution: saving into a Workspace is a separate action.
      return null;
  }
}

/**
 * Tools whose real lifecycle contradicts the sentence `getLifecycleCopyForMode`
 * would show for their mode. Empty today; non-empty is a shipped lie.
 */
export function lifecycleCopyDisagreements(): string[] {
  const problems: string[] = [];
  for (const c of TOOL_CAPABILITIES) {
    if (!c.processingMode) continue;
    const byMode = getLifecycleCopyForMode(c.processingMode);
    const byTool = LIFECYCLE_COPY[c.processingLifecycle];
    if (byMode !== byTool) {
      problems.push(
        `${c.slug}: mode "${c.processingMode}" would show "${byMode}" but its lifecycle is "${c.processingLifecycle}"`,
      );
    }
  }
  return problems;
}

/** Who is asking, for `canUseTool`. No fields beyond what the answer needs. */
export interface ToolActor {
  signedIn: boolean;
  plan: PlanRequirement | "guest";
}

/** What the deployment has switched on. Environment state, passed in. */
export interface ToolEnvironment {
  /** True when server-side processing is reachable at all. */
  serverProcessingAvailable: boolean;
}

export type ToolUseRefusal =
  | "unknown-tool"
  | "not-implemented"
  | "server-processing-unavailable"
  | "account-required";

/**
 * Whether this actor can run this tool in this environment, and if not, why.
 *
 * Three refusal kinds rather than one boolean because they need different
 * answers on screen: an unimplemented tool needs a "coming later" page, a
 * server outage needs "try again", and neither is "sign in". The server boundary
 * keeps using `assertRemoteJobTool` — this is the presentation-side question,
 * and it deliberately cannot grant anything the boundary would refuse.
 */
export function canUseTool(
  slug: string,
  actor: ToolActor,
  environment: ToolEnvironment,
): { allowed: true } | { allowed: false; reason: ToolUseRefusal } {
  const cap = capabilityForSlug(slug);
  if (!cap) return { allowed: false, reason: "unknown-tool" };
  if (!cap.available) return { allowed: false, reason: "not-implemented" };
  if (cap.executionLocation === "pdfdadi-server" && !environment.serverProcessingAvailable) {
    return { allowed: false, reason: "server-processing-unavailable" };
  }
  if (cap.accountRequirement === "account" && !actor.signedIn) {
    return { allowed: false, reason: "account-required" };
  }
  return { allowed: true };
}

/**
 * Self-check: every way this model can contradict the modules it derives from.
 *
 * Exported rather than living in the test, so the invariants sit next to the
 * code they constrain — the idiom `executionPolicyDisagreements` and
 * `displayedMeterProblems` already establish here.
 */
export function capabilityInventoryProblems(): string[] {
  const problems: string[] = [];
  const seenSlugs = new Set<string>();
  const seenRoutes = new Set<string>();

  for (const cap of TOOL_CAPABILITIES) {
    if (seenSlugs.has(cap.slug)) problems.push(`${cap.slug}: duplicate slug`);
    seenSlugs.add(cap.slug);
    if (seenRoutes.has(cap.route)) problems.push(`${cap.slug}: duplicate route ${cap.route}`);
    seenRoutes.add(cap.route);
    if (cap.route !== `/tools/${cap.slug}`) {
      problems.push(`${cap.slug}: route ${cap.route} does not match slug`);
    }

    // Availability, execution location and lifecycle must agree in all three
    // directions — an available tool with nowhere to run, or an unavailable one
    // with a lifecycle, is a tool that renders an affordance it cannot honour.
    if (cap.available !== (cap.executionLocation !== "none")) {
      problems.push(
        `${cap.slug}: available=${cap.available} but executionLocation=${cap.executionLocation}`,
      );
    }
    if (cap.available === (cap.processingLifecycle === "unavailable")) {
      problems.push(
        `${cap.slug}: available=${cap.available} but lifecycle=${cap.processingLifecycle}`,
      );
    }
    if (cap.available !== (cap.processingMode !== null)) {
      problems.push(`${cap.slug}: available=${cap.available} but processingMode=${cap.processingMode}`);
    }
    if (cap.available !== (cap.executionMode !== null)) {
      problems.push(`${cap.slug}: available=${cap.available} but executionMode=${cap.executionMode}`);
    }

    // An available tool with no size ceiling would upload without a bound.
    if (cap.available && !(cap.maxUploadBytes && cap.maxUploadBytes > 0)) {
      problems.push(`${cap.slug}: available but maxUploadBytes=${cap.maxUploadBytes}`);
    }
    if (!cap.available && cap.maxUploadBytes !== null) {
      problems.push(`${cap.slug}: not available but declares maxUploadBytes`);
    }

    // A server tool that claims a job must be on the allowlist that admits jobs,
    // or the page promises a job the API refuses to create.
    if (cap.processingLifecycle === "async-job" && !REMOTE_JOB_TOOL_SLUGS.has(cap.slug)) {
      problems.push(`${cap.slug}: claims async-job but is not in REMOTE_JOB_TOOL_SLUGS`);
    }
    if (cap.executionLocation === "browser" && REMOTE_JOB_TOOL_SLUGS.has(cap.slug)) {
      problems.push(`${cap.slug}: browser tool is in the remote-job allowlist`);
    }
    if (cap.pipelinePilot && cap.processingLifecycle !== "async-job") {
      problems.push(`${cap.slug}: pipeline pilot on a non-job tool`);
    }

    // The two output-eligibility questions, each checked against its OWN rule.
    // Deliberately not checked against each other: the moment one is asserted to
    // imply the other, the copy that Phase 5 shipped comes back as a test.
    if (cap.editorOpenableOutput && cap.outputKind !== "pdf") {
      problems.push(`${cap.slug}: editor-openable output of kind ${cap.outputKind}`);
    }
    if (cap.workspaceSaveableOutput && cap.outputKind !== "pdf") {
      problems.push(`${cap.slug}: Workspace-saveable output of kind ${cap.outputKind}`);
    }
    if (cap.workspaceSaveableOutput && cap.multiOutput) {
      problems.push(`${cap.slug}: Workspace-saveable but produces more than one file`);
    }
    if (!cap.available && (cap.editorOpenableOutput || cap.workspaceSaveableOutput)) {
      problems.push(`${cap.slug}: unavailable tool claims an output capability`);
    }
  }

  for (const slug of OPAQUE_PDF_OUTPUT_SLUGS) {
    const cap = BY_SLUG.get(slug);
    if (!cap) {
      problems.push(`${slug}: opaque-output slug is not a tool`);
      continue;
    }
    // The whole point of the list: opaque to the EDITOR only. A slug that lands
    // here and loses its Workspace destination as well is the coupling returning.
    if (cap.editorOpenableOutput) problems.push(`${slug}: listed as opaque but editor-openable`);
    if (!cap.workspaceSaveableOutput) {
      problems.push(`${slug}: opaque to the editor must not also lose its Workspace`);
    }
  }

  for (const slug of PIPELINE_PILOT_SLUGS) {
    if (!BY_SLUG.has(slug)) problems.push(`${slug}: pipeline pilot slug is not a tool`);
  }
  for (const slug of REMOTE_JOB_TOOL_SLUGS) {
    if (!BY_SLUG.has(slug)) problems.push(`${slug}: remote-job slug is not a tool`);
  }

  return problems;
}
