import { z } from "zod";
import { ConfigurationError } from "@/src/domain/errors";
import { INSECURE_DEV_SECRET } from "@/lib/admin/session";

/**
 * Application configuration, lazily validated on first access, and the home of
 * the production configuration gate (`productionProblems`).
 *
 * Validation runs at RUNTIME (first `getConfig()` call), never at module load,
 * so importing this module is always safe. In dev, `DATABASE_URL` defaults to a
 * local SQLite file so the app runs with zero external services.
 *
 * In production the gate runs before any value is handed out, so a deployment
 * missing genuinely required configuration refuses to serve rather than falling
 * back to something insecure. `instrumentation.ts` calls `getConfig()` at
 * process start so that refusal happens at boot instead of on the first
 * request. `next build` is exempt: it sets NODE_ENV=production too but has no
 * deployment secrets, and a build must stay hermetic (see `isBuildPhase`).
 *
 * This is the single source of typed config for the new (src/) architecture.
 * The pre-existing M1 code (lib/admin/session.ts, etc.) keeps reading
 * process.env directly — no conflict.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  isDev: boolean;
  adminSecret: string;
  allowInsecureDevSecret: boolean;
  siteUrl: string;
  databaseUrl: string;
  logLevel: LogLevel;
  toolsMaxConcurrency: number;
  toolsRateLimitPerMin: number;
  toolsMaxBodyBytes: number;
  upload: UploadGuardConfig;
  storage: StorageConfig;
  queue: QueueConfig;
  billing: BillingConfig;
}

/**
 * Pre-parse abuse control on the multipart upload routes.
 *
 * Every value is a REQUEST-COUNT budget, not a byte budget: the byte ceiling is
 * per request and enforced by the bounded reader, and these bound how many such
 * requests one caller may make. The two are independent on purpose — a byte cap
 * with no request cap is what let an unauthenticated caller ask for 25 MiB of
 * parsing as often as it liked.
 *
 * WHY THESE DEFAULTS:
 *
 *  - `userPerMin` 120. A Workspace upload is a human action or one file of a
 *    multi-file pick, and the picker uploads SEQUENTIALLY (NewMenu.onFilesPicked
 *    awaits each), so 120/min is above any legitimate session — a 50-file drop
 *    finishes inside it — while still bounding a stolen session's churn. Keyed by
 *    user id, which the caller cannot forge.
 *  - `anonPerMin` 20. Nothing legitimate reaches a private upload route without a
 *    session, so this bounds the cost of REFUSING traffic (a session lookup),
 *    not of serving it. Same figure as the public tool route, so one number is
 *    the "per-client upload budget" everywhere it can be honestly keyed.
 *  - `globalPerMin` 240. The unspoofable ceiling. Without a trusted proxy the
 *    per-client key is client-controlled, so a caller can rotate it; this is the
 *    bucket rotation cannot escape. 12x `anonPerMin` so it is far above the
 *    aggregate a single instance serves legitimately (four processing slots and
 *    one SQLite writer bound throughput long before 240 uploads/min).
 *  - `trustedProxySecret` null. There is no reverse proxy in this repo's
 *    deployment, so `X-Forwarded-For` is NOT read at all by default. Set this to
 *    the shared secret your proxy sends in `x-pdfdadi-proxy-secret` to make the
 *    forwarded chain trustworthy; a request that does not present the secret is
 *    keyed as untrusted no matter what forwarding headers it carries.
 */
export interface UploadGuardConfig {
  userPerMin: number;
  anonPerMin: number;
  globalPerMin: number;
  trustedProxySecret: string | null;
}

export type QueueProvider = "memory" | "redis";

export interface QueueConfig {
  provider: QueueProvider;
  redisUrl: string | null;
}

/**
 * Billing configuration.
 *
 * `enabled` is derived, never set: it is true only when a secret key, a webhook
 * secret AND at least one price are all present. A deployment with a secret key
 * and no configured price would otherwise be able to open a checkout session for
 * a price it invented, which is exactly the failure mode this slice refuses.
 *
 * Every value here is server-only. None is prefixed `NEXT_PUBLIC_`, so none can
 * reach a client bundle — a Stripe secret key or webhook secret shipped to a
 * browser is a full billing compromise, and the absence of the prefix is what
 * prevents it rather than a convention someone has to remember.
 */
export interface BillingConfig {
  enabled: boolean;
  provider: "stripe";
  secretKey: string | null;
  webhookSecret: string | null;
  /** Plan → provider price id. Null means that plan is not purchasable here. */
  /** Pro only. Business billing is deferred; there is no Business price to set. */
  prices: { pro: string | null };
}

export type StorageProvider = "local" | "r2";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional public CDN base (for public-read objects); null for private-only. */
  publicBaseUrl: string | null;
}

export interface StorageConfig {
  provider: StorageProvider;
  localRoot: string;
  /** HMAC secret for signing local download URLs; defaults to ADMIN_SECRET. */
  signingSecret: string;
  r2: R2Config | null;
}

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  ADMIN_SECRET: z.string().default(""),
  PDFDADI_ALLOW_INSECURE_DEV_SECRET: z.string().default(""),
  NEXT_PUBLIC_SITE_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TOOLS_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  TOOLS_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  TOOLS_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(110 * 1024 * 1024),
  // Pre-parse upload abuse control. Invalid values fail the whole config parse
  // (ConfigurationError listing every problem) rather than silently falling back
  // to a default — an abuse control that quietly disables itself is worse than
  // none, because nothing announces that it is gone.
  UPLOAD_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  UPLOAD_ANON_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(240),
  // A short secret would be guessable, and guessing it buys the ability to name
  // your own rate-limit key — so a too-short value is a configuration error, not
  // a warning.
  TRUSTED_PROXY_SECRET: z.string().min(16).optional(),
  // The instance topology this deployment is being run under, declared rather
  // than assumed. One value is accepted, because one value is supported: the
  // upload rate limiter counts in process memory and prisma/schema.prisma is
  // SQLite, so two instances sharing a database serve twice the configured
  // upload budget and contend for a single writer (ADR-M7-009). Declaring
  // anything else is a parse error, not a warning — an operator who intends to
  // scale out needs PostgreSQL and a shared limiter first, and this refuses to
  // pretend otherwise.
  DEPLOYMENT_TOPOLOGY: z.enum(["single-instance"]).optional(),
  // Object storage (M2.2). All optional — when R2 creds are absent the app uses
  // the local filesystem adapter, so everything builds/runs with no cloud creds.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().optional(),
  STORAGE_LOCAL_ROOT: z.string().default(".storage/local"),
  // Admin store location. Optional with a working default in dev; the production
  // gate refuses the default's *shape* when it lands in a build output, because
  // that default is `<cwd>/data/admin` and in production `<cwd>` is the build
  // output (see data/admin/index.ts).
  ADMIN_STORE_DIR: z.string().optional(),
  STORAGE_SIGNING_SECRET: z.string().optional(),
  // Billing (Stripe). All optional — absent means billing is disabled and the
  // checkout/portal endpoints fail clearly instead of inventing a price.
  // Server-only by construction: no NEXT_PUBLIC_ prefix on any of them.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  // No STRIPE_PRICE_BUSINESS. Business billing is deferred, and the variable
  // existed only to make Business purchasable — see PURCHASABLE_PLAN_IDS in
  // src/domain/billing/subscription.ts. Setting it here would do nothing; the
  // price map has no slot for it.
  // Background job queue (M2.3). Optional — when REDIS_URL is unset the app uses
  // the in-memory queue adapter, so everything builds/runs with no Redis.
  REDIS_URL: z.string().optional(),
});

function buildQueueConfig(e: z.infer<typeof envSchema>): QueueConfig {
  return {
    provider: e.REDIS_URL ? "redis" : "memory",
    redisUrl: e.REDIS_URL ?? null,
  };
}

function buildStorageConfig(e: z.infer<typeof envSchema>): StorageConfig {
  const hasR2 = !!(
    e.R2_ACCOUNT_ID &&
    e.R2_ACCESS_KEY_ID &&
    e.R2_SECRET_ACCESS_KEY &&
    e.R2_BUCKET
  );
  const r2: R2Config | null = hasR2
    ? {
        accountId: e.R2_ACCOUNT_ID!,
        accessKeyId: e.R2_ACCESS_KEY_ID!,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY!,
        bucket: e.R2_BUCKET!,
        publicBaseUrl: e.R2_PUBLIC_BASE_URL ?? null,
      }
    : null;
  return {
    provider: r2 ? "r2" : "local",
    localRoot: e.STORAGE_LOCAL_ROOT,
    signingSecret: e.STORAGE_SIGNING_SECRET || e.ADMIN_SECRET,
    r2,
  };
}

function buildBillingConfig(e: z.infer<typeof envSchema>): BillingConfig {
  const secretKey = e.STRIPE_SECRET_KEY?.trim() || null;
  const webhookSecret = e.STRIPE_WEBHOOK_SECRET?.trim() || null;
  const prices = {
    pro: e.STRIPE_PRICE_PRO?.trim() || null,
  };
  return {
    // A key without a webhook secret would take money it could never confirm; a
    // key without a Pro price has nothing to sell. Both are "not configured".
    enabled: !!secretKey && !!webhookSecret && !!prices.pro,
    provider: "stripe",
    secretKey,
    webhookSecret,
    prices,
  };
}

/**
 * Minimum length for a production HMAC secret. `lib/admin/session.ts` accepts 8
 * as a last-resort runtime floor; the boot gate is deliberately stricter, since
 * a short secret in production is almost always a placeholder someone meant to
 * replace. The documented generator produces 64 hex characters.
 */
const MIN_SECRET_LENGTH = 16;

/** Hostnames that mean "this machine" — never a valid public site origin. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * The only `DATABASE_URL` scheme this build can open, and the engine it selects.
 *
 * `prisma/schema.prisma` declares `provider = "sqlite"`. A Prisma datasource
 * accepts only its own provider's URLs, and it does not find out until it
 * connects — so a `postgresql://` value passes every check a gate could make
 * about *presence*, boots "healthy", and then fails every request that touches
 * the database. Turning that into a refusal is exactly this gate's job.
 *
 * The gate said the opposite until the pre-launch audit: its own message told the
 * operator to "point it at PostgreSQL", and `startupGate` then printed
 * `db=postgres` for the URL it had accepted — a derived label, never a fact about
 * the schema. Both are corrected here, in one place, because they are one claim.
 *
 * Changing the schema's provider means changing this. `env.test.ts` reads
 * `prisma/schema.prisma` and fails if the two disagree, so a provider swap cannot
 * leave the gate asserting the old engine.
 */
export const DATABASE_URL_PREFIX = "file:";
export const DATABASE_ENGINE = "sqlite";

/**
 * The engine label for the startup summary. A shared reader so the boot log
 * cannot describe a different database than the gate admitted.
 */
export function databaseEngineLabel(url: string): string {
  return url.startsWith(DATABASE_URL_PREFIX) ? DATABASE_ENGINE : "unsupported";
}

const R2_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

/**
 * True while `next build` is running.
 *
 * The build sets NODE_ENV=production too, but a build is not a deployment: it
 * has no access to deployment secrets and must stay hermetic so CI can compile
 * without production credentials. Only a serving process is held to the gate.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * The production configuration gate — the single authority on whether this
 * deployment is safe to serve traffic.
 *
 * Returns EVERY problem it finds instead of throwing on the first, so an
 * operator fixes the whole list in one restart rather than peeling problems off
 * one deploy at a time.
 *
 * Messages name variables and describe consequences. They never echo a value:
 * this text reaches logs and error trackers, and an error reading "ADMIN_SECRET
 * was <value>" would publish the secret to every log sink it touches.
 *
 * "Required" here means PDFDadi is unsafe or broken without it. Optional
 * features stay optional and are absent from this list by design: no Stripe
 * config disables billing, no R2 credentials selects local storage, and no
 * REDIS_URL selects the database queue. None of those blocks startup.
 */
export function productionProblems(e: z.infer<typeof envSchema>): string[] {
  const problems: string[] = [];

  const databaseUrl = e.DATABASE_URL?.trim();
  if (!databaseUrl) {
    problems.push(
      `DATABASE_URL is not set. Point it at a SQLite file on a persistent volume, e.g. ${DATABASE_URL_PREFIX}/app/data/db/pdfdadi.db. There is no production default on purpose: a relative path would silently put the live database inside the container's writable layer and delete it on the next deploy.`,
    );
  } else if (!databaseUrl.startsWith(DATABASE_URL_PREFIX)) {
    // Named, never echoed: a connection URL routinely carries a password.
    problems.push(
      `DATABASE_URL does not begin with "${DATABASE_URL_PREFIX}", but prisma/schema.prisma declares provider = "${DATABASE_ENGINE}". Prisma rejects a URL from another provider when it connects, not at startup, so this deployment would boot healthy and then fail every request that reads the database. Point it at a SQLite file on a persistent volume, or change the schema's provider and its migrations first.`,
    );
  } else if (!databaseUrl.slice(DATABASE_URL_PREFIX.length).startsWith("/")) {
    // Relative is the shape that loses data: `file:./prisma/dev.db` resolves
    // against the working directory, which in a container is the image layer.
    problems.push(
      `DATABASE_URL is a relative SQLite path. It resolves against the server's working directory, which in a container is the image's writable layer — the database would be deleted by the next deploy. Use an absolute path on a persistent volume, e.g. ${DATABASE_URL_PREFIX}/app/data/db/pdfdadi.db.`,
    );
  }

  // ADMIN_SECRET signs admin session cookies AND — unless STORAGE_SIGNING_SECRET
  // overrides it — the local storage download URLs. Missing, it is the empty
  // string: both signatures become forgeable by anyone (admin takeover with no
  // password and no rate limit, plus arbitrary reads of any stored file).
  const adminSecret = e.ADMIN_SECRET.trim();
  if (!adminSecret) {
    problems.push(
      "ADMIN_SECRET is not set. It signs admin session cookies and local storage download URLs, so without it both are forgeable: admin takeover with no password, and arbitrary reads of any stored file.",
    );
  } else if (adminSecret === INSECURE_DEV_SECRET) {
    problems.push(
      "ADMIN_SECRET is set to the public development fallback, which ships in this repository and is therefore known to everyone. Generate a real one.",
    );
  } else if (adminSecret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `ADMIN_SECRET is shorter than ${MIN_SECRET_LENGTH} characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  if (e.PDFDADI_ALLOW_INSECURE_DEV_SECRET === "1") {
    problems.push(
      "PDFDADI_ALLOW_INSECURE_DEV_SECRET=1 is set. That flag exists only to permit the public dev fallback secret during `next dev` on a developer's own machine. Unset it in production.",
    );
  }

  const signingSecret = e.STORAGE_SIGNING_SECRET?.trim();
  if (signingSecret && signingSecret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `STORAGE_SIGNING_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. Either unset it, in which case it falls back to ADMIN_SECRET, or give it a long random value.`,
    );
  }

  // The site URL is not cosmetic. LocalSignedUrlService and LocalMultipartUpload
  // build download and upload URLs from it, so a loopback value in production
  // hands clients links that resolve to their own machine.
  let siteHost: string | null = null;
  try {
    const u = new URL(e.NEXT_PUBLIC_SITE_URL.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      problems.push(
        "NEXT_PUBLIC_SITE_URL must be an absolute http(s) URL, e.g. https://pdfdadi.com.",
      );
    } else {
      siteHost = u.hostname;
    }
  } catch {
    problems.push(
      "NEXT_PUBLIC_SITE_URL is not a valid absolute URL. Set it to the public origin, e.g. https://pdfdadi.com.",
    );
  }
  if (siteHost !== null && LOOPBACK_HOSTS.has(siteHost)) {
    problems.push(
      "NEXT_PUBLIC_SITE_URL points at a loopback host — either it was left at the development default or set to localhost. Signed download and multipart-upload URLs are built from it, so clients would receive links pointing at their own machine. Set it to the public origin, e.g. https://pdfdadi.com.",
    );
  }

  // Upload abuse control is per-process, and so is the SQLite writer. Neither
  // fact is visible from the outside, and neither is enforced by anything but
  // this line: nothing else in the stack notices a second instance. So the
  // topology is DECLARED, at boot, by whoever runs the deployment — the same
  // shape as every other required production value here, and the reason the
  // limits documented in SERVER_SETUP.md can be stated as absolute numbers.
  if (e.DEPLOYMENT_TOPOLOGY !== "single-instance") {
    problems.push(
      `DEPLOYMENT_TOPOLOGY is not set to "single-instance". PDFDadi's upload rate limits (UPLOAD_RATE_LIMIT_PER_MIN=${e.UPLOAD_RATE_LIMIT_PER_MIN}, UPLOAD_ANON_RATE_LIMIT_PER_MIN=${e.UPLOAD_ANON_RATE_LIMIT_PER_MIN}, UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN=${e.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN}) are counted in process memory, so N instances behind one address admit N times those budgets — the global ceiling stops being a ceiling. The same deployment is also limited to one writable instance by SQLite (see docs/adr/ADR-M7-009-sqlite-operations.md). Set DEPLOYMENT_TOPOLOGY=single-instance to confirm exactly one instance serves this database. Scaling out requires PostgreSQL and a shared rate-limit store first; there is no supported multi-instance value.`,
    );
  }

  // Half-configured object storage silently selects the local filesystem
  // adapter (see buildStorageConfig). In production that means uploads land on
  // an ephemeral container disk and vanish on redeploy — which presents as data
  // loss rather than as a config error, so refuse the ambiguous state outright.
  const r2Present = R2_KEYS.filter((k) => !!e[k]?.trim());
  if (r2Present.length > 0 && r2Present.length < R2_KEYS.length) {
    const missing = R2_KEYS.filter((k) => !e[k]?.trim());
    problems.push(
      `Object storage is half-configured: ${r2Present.length} of ${R2_KEYS.length} R2 variables are set and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. PDFDadi would fall back to local-disk storage and lose uploads on redeploy. Set all four, or none to use local storage deliberately.`,
    );
  }

  // Local storage is a supported production choice, but only onto a persistent
  // volume. `LocalFileStorage` does `path.resolve(rootDir)`, so the default
  // `.storage/local` — and any other relative value — resolves against the
  // server's working directory: `/app/.storage/local` in the image, i.e. the
  // writable layer, deleted by the next deploy. That is the same failure the
  // DATABASE_URL check above refuses, one directory over, and it presents the
  // same way: every stored document gone, with the app reporting healthy.
  // docker-compose.yml sets an absolute root onto a volume; a deployment that is
  // not this compose file (raw `docker run`, a PaaS, systemd) gets no such help,
  // so the gate asks rather than assuming. An empty value is caught by the same
  // branch: it resolves to the working directory itself.
  if (r2Present.length < R2_KEYS.length) {
    const localRoot = e.STORAGE_LOCAL_ROOT.trim();
    if (!localRoot.startsWith("/")) {
      problems.push(
        `STORAGE_LOCAL_ROOT is ${localRoot ? "a relative path" : "empty"} and object storage is local, so uploaded documents would be written under the server's working directory — the container's writable layer — and deleted by the next deploy. Point it at a persistent volume, e.g. STORAGE_LOCAL_ROOT=/app/data/storage, or configure all ${R2_KEYS.length} R2 variables to store objects remotely.`,
      );
    }
  }

  // The admin store is the admin password hash plus all CMS content, and its
  // default location is `<working directory>/data/admin` — which in production is
  // inside the build output, because `.next/standalone/server.js` chdirs into its
  // own directory before app modules load. That is the DATABASE_URL and
  // STORAGE_LOCAL_ROOT failure a third time, with a worse consequence: the next
  // build takes the password hash with it, `isAdminPasswordSet()` goes false, and
  // `/admin/setup` re-opens to an unauthenticated visitor.
  //
  // The image is safe by construction (standalone assembled at /app, /app/data/admin
  // mounted), so the check is on the shape rather than on the variable being set:
  // absent-and-absolute-and-outside-.next is exactly the container's situation and
  // must not be refused, while a relative value or a `.next` path segment is the
  // shape that loses the password. `process.cwd()` is read here deliberately — the
  // gate runs in the serving process, after the chdir, so it sees the true path.
  const storeDir = e.ADMIN_STORE_DIR?.trim() || `${process.cwd()}/data/admin`;
  const inBuildOutput = storeDir.split("/").includes(".next");
  if (!storeDir.startsWith("/") || inBuildOutput) {
    problems.push(
      `The admin store would be written to ${storeDir}/store.json, ${
        inBuildOutput
          ? "inside the .next build output"
          : "under the server's working directory"
      } — a directory the next build or deploy replaces. It holds the admin password hash, so losing it re-opens /admin/setup to an unauthenticated visitor, and it holds every CMS edit. Point ADMIN_STORE_DIR at a persistent volume, e.g. ADMIN_STORE_DIR=/app/data/admin.`,
    );
  }

  return problems;
}

/**
 * Non-fatal configuration warnings, surfaced once at boot.
 *
 * Separate from `productionProblems` on purpose: a problem refuses to serve, a
 * warning serves anyway. Half-configured billing belongs here because billing is
 * optional by design and must never block startup — but a partial Stripe setup is
 * silently disabled, which to whoever set the keys looks like "payments are
 * broken" rather than "you are three of three short".
 *
 * The message names variables, so it lives HERE rather than in the startup hook:
 * `billingSecretConfig.test.ts` requires that every Stripe variable name appear in
 * exactly one source file, and one reader means one thing to audit. Derived from
 * the built config rather than from `process.env` for the same reason.
 */
export function configWarnings(cfg: AppConfig): string[] {
  const { secretKey, webhookSecret, prices } = cfg.billing;
  const present = [secretKey, webhookSecret, prices.pro].filter(Boolean).length;
  if (present === 0 || present === 3) return [];
  return [
    `Billing is DISABLED: ${present} of 3 Stripe variables are set. All of ` +
      "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_PRO are required " +
      "together — a key without a webhook secret could take money it can never " +
      "confirm, and a key without a price has nothing to sell. Checkout and portal " +
      "will answer 503 BILLING_NOT_CONFIGURED until all three are set.",
  ];
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";
  const isDev = !isProduction;

  // The production gate is the one authority on required configuration. It runs
  // before anything reads the config, so a misconfigured deployment fails with
  // the complete list instead of surfacing one broken subsystem at a time.
  if (isProduction && !isBuildPhase()) {
    const problems = productionProblems(e);
    if (problems.length > 0) {
      throw new ConfigurationError(
        `Refusing to start: ${problems.length} production configuration problem${
          problems.length === 1 ? "" : "s"
        }.\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      );
    }
  }

  // Dev default: a local SQLite file, so the app runs with no external DB. In
  // production DATABASE_URL is required by the gate above, so this fallback is
  // unreachable there.
  const databaseUrl = e.DATABASE_URL?.trim() || "file:./prisma/dev.db";

  cached = {
    nodeEnv: e.NODE_ENV,
    isProduction,
    isDev,
    adminSecret: e.ADMIN_SECRET,
    allowInsecureDevSecret: e.PDFDADI_ALLOW_INSECURE_DEV_SECRET === "1",
    siteUrl: e.NEXT_PUBLIC_SITE_URL,
    databaseUrl,
    logLevel: e.LOG_LEVEL,
    toolsMaxConcurrency: e.TOOLS_MAX_CONCURRENCY,
    toolsRateLimitPerMin: e.TOOLS_RATE_LIMIT_PER_MIN,
    toolsMaxBodyBytes: e.TOOLS_MAX_BODY_BYTES,
    upload: {
      userPerMin: e.UPLOAD_RATE_LIMIT_PER_MIN,
      anonPerMin: e.UPLOAD_ANON_RATE_LIMIT_PER_MIN,
      globalPerMin: e.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN,
      trustedProxySecret: e.TRUSTED_PROXY_SECRET?.trim() || null,
    },
    storage: buildStorageConfig(e),
    queue: buildQueueConfig(e),
    billing: buildBillingConfig(e),
  };
  return cached;
}

/** Test-only: resets the cached config so env changes take effect. */
export function _resetConfigForTests(): void {
  cached = null;
}
