/**
 * The editor's document-loading state machine and its polling policy.
 *
 * Extracted from the component for one reason: "the spinner must always end" is
 * a claim about state transitions, and a claim about state transitions should be
 * checkable without mounting React, faking timers or driving a canvas. Every
 * rule that decides whether the user sees a spinner, a processing notice or an
 * error lives here as a pure function.
 *
 * The states are deliberately explicit rather than a pair of booleans. A
 * `loading`/`error` boolean pair has four combinations, two of which are
 * nonsense, and it was exactly such a pair that allowed a document to sit in
 * "loading" with nothing left running to clear it.
 */

/** Where a document load currently is. */
export type LoadPhase =
  | "idle"
  | "loading-content"
  | "processing-upload"
  | "parsing-pdf"
  | "initializing-editor"
  | "ready"
  | "error";

/** Terminal phases: nothing further happens without a new intent. */
export const TERMINAL_PHASES: readonly LoadPhase[] = ["ready", "error"];

/** Whether a phase should render a spinner. */
export function isBusyPhase(phase: LoadPhase): boolean {
  return (
    phase === "loading-content" ||
    phase === "processing-upload" ||
    phase === "parsing-pdf" ||
    phase === "initializing-editor"
  );
}

/**
 * Bounds on waiting for an upload to be prepared.
 *
 * A cap exists because the alternative is an unbounded spinner: if the worker
 * never finishes — crashed, never started, queue misconfigured — the user must
 * still arrive at a state that explains itself and offers a retry.
 */
export const POLL_POLICY = {
  /** First wait, short enough that a fast ingestion feels immediate. */
  initialDelayMs: 700,
  /** Each subsequent wait grows by this factor. */
  backoffFactor: 1.6,
  /** No single wait exceeds this. */
  maxDelayMs: 4_000,
  /** Total time spent waiting before giving up and showing a message. */
  maxTotalWaitMs: 60_000,
  /** Hard cap on attempts, independent of timing. */
  maxAttempts: 24,
} as const;

/** The delay before attempt `attempt` (1-based), with exponential backoff. */
export function pollDelayMs(attempt: number): number {
  if (attempt <= 1) return POLL_POLICY.initialDelayMs;
  const raw = POLL_POLICY.initialDelayMs * POLL_POLICY.backoffFactor ** (attempt - 1);
  return Math.min(Math.round(raw), POLL_POLICY.maxDelayMs);
}

/**
 * Whether to wait and retry after a "still preparing" response.
 *
 * Both bounds are checked, not just the attempt count: with backoff, an attempt
 * cap alone would let the total wait drift far past what a user will sit
 * through, and a time cap alone would allow many attempts when delays are small.
 */
export function shouldKeepPolling(attempt: number, elapsedMs: number): boolean {
  if (attempt >= POLL_POLICY.maxAttempts) return false;
  return elapsedMs + pollDelayMs(attempt + 1) <= POLL_POLICY.maxTotalWaitMs;
}

/* ==========================================================================
 * Phase J — error classification and safe presentation
 * ========================================================================== */

/**
 * The distinguishable reasons a document load can fail.
 *
 * Bounded on purpose: each member is a state the application can actually tell
 * apart from evidence it really has. There is no "permission revoked" member,
 * for instance, because a 403 does not say *why* access was denied — inventing
 * that distinction would mean telling users something the server never claimed.
 */
export type LoadErrorKind =
  | "auth"
  | "forbidden"
  | "not-found"
  | "content-unavailable"
  | "invalid-pdf"
  | "network"
  | "timed-out"
  | "unknown";

/**
 * The evidence a failure carries, and nothing else.
 *
 * Note what is absent: the server's own `detail` string. Ingestion failure
 * reasons are bounded but infrastructure-flavoured ("The stored bytes do not
 * match the uploaded checksum"), and the shipped build rendered them straight
 * into the panel. Leaving `detail` out of the type the presentation layer
 * receives makes rendering it impossible rather than merely discouraged — the
 * diagnostic still goes to the console, where it belongs.
 */
export interface LoadErrorFacts {
  /** HTTP status, or null when no response was received. */
  status: number | null;
  /** The server's machine-readable error code, when it sent one. */
  code: string | null;
  /** The server's preparation state for the document's content. */
  preparation: "processing" | "failed" | "none";
  /** True when the request never reached a response (fetch rejection). */
  network: boolean;
  /** True when bytes arrived but PDF.js could not open them. */
  invalidPdf: boolean;
  /** True when the bounded preparation-polling budget was exhausted. */
  timedOut: boolean;
}

/** Facts for a failure that reported nothing useful about itself. */
export const NO_ERROR_FACTS: LoadErrorFacts = {
  status: null,
  code: null,
  preparation: "none",
  network: false,
  invalidPdf: false,
  timedOut: false,
};

/**
 * The server error code that means "this document has no servable bytes".
 *
 * Matched explicitly because status alone is not evidence: the content route
 * answers 409 for unavailable content, but `mapWorkspaceError` also answers 409
 * with `WORKSPACE_OPERATION_REJECTED` for any rejected domain operation. Reading
 * every 409 as "not ready yet" would tell a user their document is still being
 * prepared when the real problem had nothing to do with preparation.
 */
export const CONTENT_UNAVAILABLE_CODE = "CONTENT_UNAVAILABLE";

/**
 * Classifies a failure into one of the kinds the UI can speak about.
 *
 * Order encodes precedence, and two orderings matter:
 *
 * - `timed-out` outranks `content-unavailable`, because an exhausted polling
 *   budget arrives *with* preparation evidence attached. The user's problem at
 *   that point is the waiting, not the preparation state.
 * - `network` outranks status-based kinds, though in practice a network failure
 *   has no status to compete with.
 */
export function classifyLoadError(facts: LoadErrorFacts): LoadErrorKind {
  if (facts.network) return "network";
  if (facts.timedOut) return "timed-out";
  if (facts.invalidPdf) return "invalid-pdf";

  // 401 and 403 stay separate: one is a session the user can fix by signing in,
  // the other is an authorization decision that signing in again will not change.
  if (facts.status === 401) return "auth";
  if (facts.status === 403) return "forbidden";
  if (facts.status === 404) return "not-found";

  // Semantic evidence, not the bare status — see CONTENT_UNAVAILABLE_CODE.
  if (facts.code === CONTENT_UNAVAILABLE_CODE) return "content-unavailable";
  if (facts.preparation !== "none") return "content-unavailable";

  return "unknown";
}

/** Where the failed editor is mounted, which decides the recovery offered. */
export type LoadContext = "workspace" | "standalone";

/**
 * A recovery affordance. `kind` is the intent; the caller wires the behaviour.
 *
 * There is deliberately no `back` member. "Back to Workspace" is a real link
 * with a real href that only the host route knows, so it is passed to the panel
 * as a node rather than modelled here — an action this module emitted but no
 * caller could implement would be exactly the dead button Phase J forbids.
 */
export interface LoadErrorAction {
  kind: "retry" | "open-another" | "sign-in";
  label: string;
}

/** Bounded, user-facing copy plus the actions that are genuinely useful. */
export interface LoadErrorPresentation {
  kind: LoadErrorKind;
  /** Short heading. Safe to render. */
  heading: string;
  /** One or two sentences of guidance. Safe to render. */
  description: string;
  /** Primary action first. Empty only when nothing can honestly be offered. */
  actions: LoadErrorAction[];
}

/**
 * Whether retrying the same load could plausibly succeed.
 *
 * A Retry button on a 404 is a dead control: the document was not found, and
 * asking again will not find it. The same goes for a 403 and for a PDF whose
 * bytes are damaged — re-fetching identical bytes fails identically.
 */
export function canRetryKind(kind: LoadErrorKind): boolean {
  return (
    kind === "network" ||
    kind === "timed-out" ||
    kind === "content-unavailable" ||
    kind === "unknown"
  );
}

/** Heading + description per kind. The presentation layer owns every string. */
const ERROR_COPY: Record<LoadErrorKind, { heading: string; description: string }> = {
  auth: {
    heading: "Your session has expired",
    description: "Sign in again to open this document.",
  },
  forbidden: {
    // Deliberately not "your permission was removed": the application cannot
    // distinguish a revoked role from one never granted, and guessing would be
    // both wrong and a disclosure.
    heading: "You don't have access to this document",
    description: "Ask a workspace owner or admin if you need access.",
  },
  "not-found": {
    heading: "Document not found",
    description: "It may have been moved or deleted.",
  },
  "content-unavailable": {
    heading: "This document isn't ready to open",
    description: "There's no saved version to open yet.",
  },
  "invalid-pdf": {
    heading: "We couldn't open this PDF",
    description:
      "The file may be damaged, unsupported, or outside the Editor's supported limits.",
  },
  network: {
    heading: "Connection problem",
    description: "We couldn't reach the server. Check your connection and try again.",
  },
  "timed-out": {
    heading: "This is taking longer than expected",
    description:
      "The document is still being prepared. Try again in a moment — it will open once preparation finishes.",
  },
  unknown: {
    heading: "Could not open this document",
    description: "Something went wrong. Try again, and let us know if it keeps happening.",
  },
};

/**
 * Refines the content-unavailable wording using the preparation state.
 *
 * These three cases are genuinely different situations for the user — one is
 * worth waiting for, one never resolves, one means nothing was ever saved — and
 * the server does report which is which.
 */
function contentUnavailableCopy(preparation: LoadErrorFacts["preparation"]): {
  heading: string;
  description: string;
} {
  if (preparation === "processing") {
    return {
      heading: "This document is still being prepared",
      description: "Its upload is still being processed. Try again in a moment.",
    };
  }
  if (preparation === "failed") {
    return {
      heading: "This document couldn't be prepared",
      description:
        "Its upload didn't finish successfully, so there's no version to open. Uploading the file again usually fixes this.",
    };
  }
  return ERROR_COPY["content-unavailable"];
}

/**
 * The full user-facing consequence of a failure.
 *
 * Every string returned here is authored in this module. Server-provided text is
 * never passed through: the content route's messages are bounded and safe, but
 * "safe" is not the same as "written for this panel", and the moment a message
 * is echoed verbatim the panel inherits whatever any future route decides to put
 * in it.
 */
export function presentLoadError(
  facts: LoadErrorFacts,
  options: { context: LoadContext } = { context: "workspace" },
): LoadErrorPresentation {
  const kind = classifyLoadError(facts);
  const copy =
    kind === "content-unavailable" ? contentUnavailableCopy(facts.preparation) : ERROR_COPY[kind];

  const actions: LoadErrorAction[] = [];
  if (kind === "auth") {
    actions.push({ kind: "sign-in", label: "Sign in" });
  } else if (canRetryKind(kind)) {
    actions.push({ kind: "retry", label: "Try again" });
  }

  // The standalone editor's universal fallback: whatever went wrong with this
  // file, opening a different one is always available and always meaningful.
  if (options.context === "standalone") {
    actions.push({ kind: "open-another", label: "Open another PDF" });
  }

  return { kind, heading: copy.heading, description: copy.description, actions };
}

/**
 * Reads failure evidence off a thrown value.
 *
 * Structural rather than an `instanceof WorkspaceDocumentLoadError` check, and
 * deliberately so: importing that class here would pull `loadPdf` and with it
 * pdfjs-dist into this module, and the whole value of this file is that its
 * rules are checkable in a plain Node test with no DOM and no PDF engine.
 *
 * Anything unrecognised becomes `unknown` rather than being guessed at.
 */
export function loadErrorFacts(
  error: unknown,
  options: { timedOut?: boolean } = {},
): LoadErrorFacts {
  const source = (error ?? {}) as Record<string, unknown>;
  const preparation = source.preparation;
  return {
    status: typeof source.status === "number" ? source.status : null,
    code: typeof source.code === "string" ? source.code : null,
    preparation:
      preparation === "processing" || preparation === "failed" ? preparation : "none",
    network: source.network === true,
    invalidPdf: source.invalidPdf === true,
    timedOut: options.timedOut === true,
  };
}

/** What the UI should say and offer for a given phase. */
export interface LoadPresentation {
  /** Short status line. Null when the editor should simply be shown. */
  message: string | null;
  /** True when a spinner belongs on screen. */
  spinner: boolean;
  /** True when a Retry affordance should be offered. */
  retry: boolean;
}

/**
 * The visible consequence of a load state.
 *
 * Note the invariant this encodes: `spinner` is true only for phases that have
 * something running behind them. A terminal error never spins, and offers a
 * retry exactly when retrying could work.
 *
 * There is deliberately no `message` input. The shipped build threaded the
 * server's string through here and rendered it, which is how ingestion
 * diagnostics reached the panel; removing the channel is what makes that
 * impossible rather than merely discouraged.
 */
export function presentLoad(state: {
  phase: LoadPhase;
  timedOut: boolean;
  /** Failure evidence, when the phase is `error`. */
  error?: LoadErrorFacts | null;
}): LoadPresentation {
  switch (state.phase) {
    case "loading-content":
      return { message: "Opening document…", spinner: true, retry: false };
    case "processing-upload":
      // The presentation owns this sentence rather than echoing the server's:
      // waiting is the same experience whichever bounded phrasing a route
      // happens to return.
      return { message: "This PDF is still being prepared.", spinner: true, retry: true };
    case "parsing-pdf":
      return { message: "Reading PDF…", spinner: true, retry: false };
    case "initializing-editor":
      return { message: "Preparing editor…", spinner: true, retry: false };
    case "error": {
      const shown = presentLoadError(
        { ...(state.error ?? NO_ERROR_FACTS), timedOut: state.timedOut || Boolean(state.error?.timedOut) },
        { context: "workspace" },
      );
      return {
        message: shown.heading,
        spinner: false,
        retry: shown.actions.some((action) => action.kind === "retry"),
      };
    }
    case "ready":
    case "idle":
    default:
      return { message: null, spinner: false, retry: false };
  }
}

/* ==========================================================================
 * Phase J — loading presentation geometry and announcements
 * ========================================================================== */

/** A4 portrait, the ratio to draw before the real page size is known. */
export const DEFAULT_PAGE_ASPECT = 297 / 210;

/**
 * The page-shaped skeleton's height/width ratio.
 *
 * Returns the default immediately when dimensions are unknown, because the
 * alternative — waiting to learn the real size before drawing anything — is how
 * a loading state ends up being a bare spinner. The clamp keeps a pathological
 * page (a 14400pt banner) from producing a skeleton taller than the viewport.
 */
export function loadingPageAspect(size: { width: number; height: number } | null): number {
  if (!size || !(size.width > 0) || !(size.height > 0)) return DEFAULT_PAGE_ASPECT;
  return Math.min(3, Math.max(0.4, size.height / size.width));
}

/**
 * How many placeholder thumbnails to draw while page count is unknown.
 *
 * Bounded because a skeleton per page is worse than no skeleton on a 200-page
 * document: it costs more layout than the real thumbnails and it lies about how
 * much is loading.
 */
export function placeholderThumbnailCount(knownPageCount: number | null): number {
  if (knownPageCount !== null) return 0;
  return 3;
}

/**
 * The one announcement a load transition should make, or null for silence.
 *
 * Only transitions a user needs to hear are announced. Poll attempts and
 * internal substages are deliberately silent: a live region that narrates every
 * retry is noise, and noise is how screen-reader users learn to ignore it.
 */
export function loadAnnouncement(phase: LoadPhase, error?: LoadErrorFacts | null): string | null {
  switch (phase) {
    case "loading-content":
      return "Opening document.";
    case "ready":
      return "Document loaded.";
    case "error":
      return `Could not open document. ${presentLoadError(error ?? NO_ERROR_FACTS, { context: "workspace" }).heading}.`;
    default:
      // processing-upload, parsing-pdf and initializing-editor are substages of
      // the "Opening document." already announced.
      return null;
  }
}

/**
 * Classifies a load failure into the next phase.
 *
 * A failure that is still being worked on becomes `processing-upload` — the only
 * phase from which polling continues. Everything else, including a *failed*
 * preparation, is terminal: a failed ingestion will not fix itself, and showing
 * it as "preparing" is precisely the endless-spinner bug.
 */
export function phaseForFailure(input: {
  preparation: "processing" | "failed" | "none";
  canKeepPolling: boolean;
}): LoadPhase {
  if (input.preparation === "processing" && input.canKeepPolling) return "processing-upload";
  return "error";
}
