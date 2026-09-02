/* global process, console, fetch, setTimeout */
/**
 * PERMANENT runtime probe: paid entitlement can be granted ONLY by a
 * signature-verified provider webhook.
 *
 * WHY THIS EXISTS. Every claim in the billing slice is unit-tested against fakes,
 * and vitest here runs `environment: "node"` with hand-built request objects — so
 * a fully green suite is compatible with all of the following:
 *
 *   - a checkout route that answers 200 to an anonymous POST, because the real
 *     Next.js cookie plumbing resolves differently than the test's fake request
 *   - a webhook that reads `req.json()` in production while every test drives it
 *     through `req.text()`, so the body is parsed before it is verified
 *   - `?checkout=success` upgrading an account, because some page component that
 *     no test renders posts an "activate" call on mount
 *   - an idempotency claim that holds in memory and not against a real unique index
 *   - an entitlement provider that reads billing state correctly in isolation
 *     while the wired-up `/api/usage` still reports the legacy `plan` column
 *
 * So this walks the REAL production server, over HTTP, against a REAL SQLite
 * database, and reads the resulting plan back through `/api/usage` — the same
 * surface the product uses to decide what an account is allowed to do.
 *
 * WHAT IT PINS, stated as the mutations it was built against:
 *
 *   signature check bypassed or moved after parsing  → §5 grants Pro from an
 *     unsigned body, or stops answering 400
 *   client-chosen price honoured                     → §3 stops answering 400
 *   checkout or the success redirect granting Pro     → §3/§4 read plan `pro`
 *   webhook idempotency removed                      → §6 sees the redelivery's
 *     contradictory payload land (plan free, status canceled)
 *   unknown price mapped to Pro                      → §8 reads `pro`
 *   Business made purchasable, or a Business-shaped price granting Business
 *                                                    → §3 / §8
 *   ownership taken from webhook metadata            → §10, §16
 *   a fabricated display price                       → §18 finds an amount in a
 *     response whose provider price could not be read
 *   checkout offered where it cannot complete        → §18's A/B across the two
 *     deployments stops distinguishing them
 *   billing:manage widened past owner                → §19 reads anything but
 *     owner_only for an org ADMIN, or the POST stops answering 403
 *   an organization id from the query treated as an assertion → §21 leaks the
 *     target's plan, an identifier, or a permission over it
 *   the success query moving the OFFER (not just the plan) → §22
 *   a billing outage taken as an app outage          → §23's tool page, usage API
 *     or pricing copy stops surviving a deployment with no provider
 *   stale event allowed to overwrite newer state     → §7
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass: a dead server, an empty
 * database, or a build where every plan reads `free` would satisfy every "must
 * not be pro" assertion in here. Three defences:
 *
 *   1. The server is health-polled, and every fixture write is read back before a
 *      single negative claim is asserted.
 *   2. §5 REQUIRES a real grant — `/api/usage` must say `pro` — and §9 requires
 *      the grant again after two "grants nothing" sections. A build that can
 *      never say `pro` fails both. §20 requires a third: the SUMMARY must move
 *      from checkout/free to manage/pro, so a summary hard-wired to either end of
 *      that transition fails. §19 and §21 assert their fixtures (a real admin
 *      membership; a target organization that really does hold Pro and a customer)
 *      before asserting what the caller may not see.
 *   3. Every status assertion reports the status it actually saw, and every
 *      body-content assertion checks the body is non-empty first.
 *
 * SYNTHETIC SIGNED WEBHOOKS, NOT LIVE STRIPE. Events here are signed with this
 * file's own HMAC over Stripe's documented scheme (`t=<ts>,v1=<hmac>` over
 * `${ts}.${rawBody}`), computed independently of the app's verifier — so
 * agreement between the two is evidence rather than a tautology. What this does
 * NOT do is talk to Stripe: no live key is exercised, and the two operations that
 * need a Stripe round trip (a successful checkout URL, a successful portal URL)
 * are reported ENVIRONMENT-LIMITED rather than faked. Live Stripe E2E is a
 * separate exercise, and this probe is not evidence for it.
 *
 * RUN IT. The probe starts its own servers, so the only prerequisite is a build:
 *
 *   node scripts/next-build.js
 *   node scripts/billing-probe.mjs [--port 3141]
 *
 * Two servers, because "billing configured" and "billing absent" are different
 * deployments — each on its own throwaway SQLite database under the OS temp
 * directory. No repo file, no `.env` value and no real account is touched.
 *
 * HOW THE TWO DEPLOYMENTS ARE SERVED, and why it is not `next start` on
 * localhost. `next.config.ts` sets `output: "standalone"`, and the production
 * startup gate REFUSES to boot when `NEXT_PUBLIC_SITE_URL` names a loopback host,
 * because signed download URLs are built from it. So each server here is the
 * standalone artifact, configured with a NON-loopback public origin
 * (`http://probe-billing-<port>.test`, a name that resolves nowhere) while the
 * probe connects over loopback and presents that configured origin as its `Origin`
 * header — which is exactly what production CSRF trusts. `startServer` and
 * `probeOrigin` below do this; nothing about the gate is weakened for it.
 *
 * NO HTTPS TERMINATOR IS NEEDED HERE, unlike the browser probes. Session and
 * anonymous-owner cookies are `Secure` in production, so a real Chrome on a plain
 * `http://` origin silently drops them and every ownership check then resolves a
 * different actor. This probe is `fetch`-based with its own cookie jar
 * (`absorb`/`cookieHeader`), which stores what it is sent regardless of the
 * `Secure` attribute — so the plain-http origin is sound for THIS probe and would
 * not be for a browser one. See `scripts/processing-pilot-probe.mjs` for the
 * terminator recipe the browser probes need.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
// Imported rather than taken as a global: `URL` is ambient in Node, but the shared
// lint config does not declare it for scripts, and a probe that fails lint is a
// gate failure like any other.
import { URL } from "node:url";
import { PrismaClient } from "@prisma/client";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const PORT_ON = Number(arg("--port", "3141"));
const PORT_OFF = PORT_ON + 1;

/** Fake but well-formed. The shapes matter; none of these values reaches Stripe. */
const STRIPE_KEY = "sk_test_probe_not_a_real_key";
const WEBHOOK_SECRET = "whsec_probe_signing_secret";
const PRICE_PRO = "price_probe_pro";
/** Shaped exactly like a Business price. Must still grant nothing. */
const PRICE_BUSINESS_LIKE = "price_probe_business";
const PRICE_UNKNOWN = "price_probe_never_configured";
const CUSTOMER = "cus_probe_org1";
/** Planted in every unverified payload: it must never appear in a response. */
const CANARY = "PROBE_CANARY_UNVERIFIED_PAYLOAD";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const limits = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function environmentLimited(name, reason) {
  limits.push({ name, reason });
  console.log(`  n/a  ${name} — ${reason}`);
}
const section = (n, title) => console.log(`\n── ${n}. ${title}`);

// ---------------------------------------------------------------------------
// Stripe signing, implemented from the documented scheme.
//
// Deliberately NOT imported from src/infrastructure/billing/stripeSignature.ts:
// a probe that signs with the code it verifies against proves only that the
// function agrees with itself. This is four lines, and the agreement of two
// independent implementations is the actual evidence.
// ---------------------------------------------------------------------------
function signed(rawBody, timestampSeconds, secret = WEBHOOK_SECRET) {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/** A subscription event, in the shape the real adapter parses. */
function subscriptionEvent({
  id,
  type = "customer.subscription.updated",
  createdSec,
  customerId = CUSTOMER,
  subscriptionId = "sub_probe_1",
  priceId = PRICE_PRO,
  status = "active",
  periodEndSec,
  cancelAtPeriodEnd = false,
  organizationIdMetadata = null,
  canary = false,
}) {
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2025-04-30.basil",
    created: createdSec,
    type,
    ...(canary ? { probe_note: CANARY } : {}),
    data: {
      object: {
        id: subscriptionId,
        object: "subscription",
        customer: customerId,
        status,
        cancel_at_period_end: cancelAtPeriodEnd,
        current_period_end: periodEndSec,
        items: {
          object: "list",
          data: [
            {
              id: "si_probe_1",
              object: "subscription_item",
              current_period_end: periodEndSec,
              price: { id: priceId, object: "price" },
            },
          ],
        },
        metadata: organizationIdMetadata ? { organizationId: organizationIdMetadata } : {},
      },
    },
  });
}

/** A completed checkout session that bought no subscription (a one-off payment). */
function oneOffCheckoutEvent({ id, createdSec }) {
  return JSON.stringify({
    id,
    object: "event",
    created: createdSec,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_probe_oneoff",
        object: "checkout.session",
        customer: CUSTOMER,
        mode: "payment",
        subscription: null,
        metadata: {},
      },
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP with an explicit cookie jar.
//
// Node's `fetch` carries no cookies of its own, which is what this needs: every
// identity below is stated at the call site, so "anonymous" is genuinely
// anonymous rather than a session that leaked in from an earlier request.
// ---------------------------------------------------------------------------
function jar() {
  return new Map();
}
function absorb(store, res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (store) => [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * A distinct forwarded-for address per request, by default.
 *
 * The billing endpoints allow six session creations per minute per client, and
 * this probe makes more than six calls to them. Presenting each logical caller as
 * its own client stops the limiter from turning a security assertion into a 429
 * that would read as a pass. Section 15 then exercises the limiter deliberately,
 * from one fixed address, so "no interference" never quietly becomes "the limiter
 * is dead".
 */
let callSeq = 0;
function nextIp() {
  callSeq += 1;
  return `10.55.${Math.floor(callSeq / 250)}.${callSeq % 250}`;
}

async function post(base, path, { body, store, origin, raw, headers = {}, ip } = {}) {
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Same-origin evidence is required by every state-changing route. The default
      // is the deployment's CONFIGURED origin — which is what production trusts,
      // and is not the loopback address this fetch is aimed at. A check that wants
      // it wrong, or wants none at all (a webhook), says so.
      ...(origin === null ? {} : { Origin: origin ?? probeOrigin(base) }),
      "X-Forwarded-For": ip ?? nextIp(),
      ...(store && store.size ? { Cookie: cookieHeader(store) } : {}),
      ...headers,
    },
    body: payload,
    redirect: "manual",
  });
  const text = await res.text();
  if (store) absorb(store, res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — `text` is the evidence */
  }
  return { status: res.status, text, json };
}

async function get(base, path, { store } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      "X-Forwarded-For": nextIp(),
      ...(store && store.size ? { Cookie: cookieHeader(store) } : {}),
    },
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
}

/** The plan the APPLICATION reports for a session — not the plan the row holds. */
async function planOf(base, store) {
  const usage = await get(base, "/api/usage", { store });
  return {
    plan: usage.json?.plan ?? null,
    mode: usage.json?.mode ?? null,
    status: usage.status,
  };
}

// ---------------------------------------------------------------------------
// Fixture and server lifecycle
// ---------------------------------------------------------------------------
const servers = [];

/** Kills a server and everything it forked. */
function killServer(entry) {
  try {
    process.kill(-entry.child.pid, "SIGKILL");
  } catch {
    // Already gone, or never became a group leader — fall back to the direct kill.
    try {
      entry.child.kill("SIGKILL");
    } catch {
      /* nothing left to kill */
    }
  }
}

function migrate(dbUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "ignore",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited ${code}`)),
    );
    child.on("error", reject);
  });
}

/**
 * Refuses to run against someone else's server.
 *
 * Without this, a leftover process from an earlier run answers the health poll,
 * this run's fixtures are never used, and the failures that follow look like
 * product bugs. Checked by binding rather than by requesting, because a port held
 * by something that is not an HTTP server is just as fatal.
 */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once("error", (err) =>
      reject(
        new Error(
          `port ${port} is already in use (${err.code}). Stop whatever is listening there — ` +
            "if it is a stray server from an earlier probe run, `lsof -ti :" +
            port +
            " | xargs kill -9`.",
        ),
      ),
    );
    tester.once("listening", () => tester.close(() => resolve()));
    tester.listen(port, "127.0.0.1");
  });
}

/**
 * The PUBLIC origin a deployment on `port` is configured with — deliberately not
 * the address this probe connects to.
 *
 * Derived from the base URL rather than threaded through every call site, because
 * `post` already has the base and a second parameter on ~40 call sites is how one
 * of them ends up sending the wrong origin and reading as a CSRF bug.
 *
 * Two production rules force a non-loopback name here: the startup gate refuses to
 * boot with a loopback `NEXT_PUBLIC_SITE_URL`, and `requireSameOrigin` trusts
 * exactly the configured origin in production, deriving nothing from the request.
 * A name that resolves nowhere is correct — nothing fetches it.
 */
function probeOrigin(base) {
  return `http://probe-billing-${new URL(base).port}.test`;
}

async function startServer({ port, dbUrl, storageRoot, billing }) {
  await assertPortFree(port);
  const base = `http://localhost:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    ADMIN_SECRET: `probe-admin-${randomBytes(8).toString("hex")}`,
    // The configured public origin, which the probe echoes as `Origin`. Not `base`:
    // the gate refuses a loopback site URL under NODE_ENV=production, and it is
    // production's own behaviour that is under test here.
    NEXT_PUBLIC_SITE_URL: probeOrigin(base),
    STORAGE_LOCAL_ROOT: storageRoot,
    // Deliberately absent, so the probe observes the DEFAULT rather than a value
    // it supplied: unset must resolve to observe, not enforce.
    USAGE_LIMIT_MODE: undefined,
    ...(billing
      ? {
          STRIPE_SECRET_KEY: STRIPE_KEY,
          STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
          STRIPE_PRICE_PRO: PRICE_PRO,
          // Left set on purpose: this variable must do nothing at all.
          STRIPE_PRICE_BUSINESS: PRICE_BUSINESS_LIKE,
        }
      : {
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: undefined,
          STRIPE_PRICE_PRO: undefined,
        }),
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

  // `detached` makes the child a process-group leader, so the kill below reaches
  // the actual next-server it forks. Killing only `npx` leaves that server alive,
  // holding the port — which is how a later run ends up health-polling a stale
  // process attached to a database that no longer exists.
  // The standalone artifact, not `next start`: `output: "standalone"` is what
  // production runs, and it is the runtime whose request-URL handling and env
  // reading are under test. `HOSTNAME` binds it to loopback so only this probe can
  // reach it.
  const child = spawn("node", ["server.js"], {
    cwd: join(process.cwd(), ".next", "standalone"),
    env: { ...env, HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  servers.push({ child, port, tail: () => log.slice(-3000) });

  // Health-polled rather than slept: a fixed wait is either slow or, on a loaded
  // machine, an ECONNREFUSED that reads as "the application is broken".
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(500);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`server on ${port} never became healthy:\n${log.slice(-2000)}`);
}

async function signup(base, store, email) {
  const res = await post(base, "/api/auth/signup", {
    store,
    body: {
      name: "Billing Probe",
      email,
      password: "probe-password-123456",
      confirmPassword: "probe-password-123456",
    },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${res.text.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const root = mkdtempSync(join(tmpdir(), `pdfdadi-billing-probe-${process.pid}-`));
  const dbOn = `file:${join(root, "billing-on.db")}`;
  const dbOff = `file:${join(root, "billing-off.db")}`;

  section(0, "Isolated fixtures and two production deployments");
  await migrate(dbOn);
  await migrate(dbOff);
  check("two throwaway databases migrated outside the repo", true, root);

  const on = await startServer({
    port: PORT_ON,
    dbUrl: dbOn,
    storageRoot: join(root, "storage-on"),
    billing: true,
  });
  const off = await startServer({
    port: PORT_OFF,
    dbUrl: dbOff,
    storageRoot: join(root, "storage-off"),
    billing: false,
  });
  check("billing-configured production server is healthy", true, on);
  check("billing-absent production server is healthy", true, off);

  const db = new PrismaClient({ datasourceUrl: dbOn });
  const dbNoBilling = new PrismaClient({ datasourceUrl: dbOff });

  try {
    // ---- 1. Accounts and the stored provider customer ----------------------
    section(1, "Accounts, and the customer row a real checkout would have written");
    const owner = jar();
    const other = jar();
    const stamp = Date.now();
    await signup(on, owner, `probe-owner-${stamp}@pdfdadi.test`);
    await signup(on, other, `probe-other-${stamp}@pdfdadi.test`);
    check("two accounts signed up through the real server", owner.size > 0 && other.size > 0);

    const users = await db.user.findMany();
    const ownerUser = users.find((u) => u.email === `probe-owner-${stamp}@pdfdadi.test`);
    const otherUser = users.find((u) => u.email === `probe-other-${stamp}@pdfdadi.test`);
    const memberships = await db.organizationMembership.findMany();
    const orgOwner = memberships.find((m) => m.userId === ownerUser?.id);
    const orgOther = memberships.find((m) => m.userId === otherUser?.id);
    check(
      "each account owns its own organization",
      orgOwner?.role === "owner" &&
        orgOther?.role === "owner" &&
        orgOwner.organizationId !== orgOther.organizationId,
      `${orgOwner?.role} / ${orgOther?.role}`,
    );

    // The row `linkCustomer` writes on a first checkout. Seeded directly because
    // creating it for real needs a Stripe API call; everything the webhook path
    // then does with it runs through the real repository.
    await db.billingSubscription.create({
      data: {
        organizationId: orgOwner.organizationId,
        provider: "stripe",
        providerCustomerId: CUSTOMER,
      },
    });
    const seeded = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "the customer row starts with no subscription and no paid plan",
      seeded?.providerCustomerId === CUSTOMER &&
        seeded?.planId === "free" &&
        seeded?.status === "incomplete" &&
        seeded?.providerSubscriptionId === null &&
        seeded?.lastEventAt === null,
      `plan=${seeded?.planId} status=${seeded?.status}`,
    );

    const baseline = await planOf(on, owner);
    check(
      "the owner starts on free, with limits observed rather than enforced",
      baseline.plan === "free" && baseline.mode === "observe",
      `plan=${baseline.plan} mode=${baseline.mode}`,
    );

    // ---- 2. Session and origin ---------------------------------------------
    section(2, "Checkout requires a session and a same-origin request");
    const anon = await post(on, "/api/billing/checkout", { body: { plan: "pro" } });
    check(
      "an anonymous checkout is refused with 401",
      anon.status === 401 && anon.json?.error?.code === "UNAUTHORIZED",
      `status ${anon.status} ${anon.text.slice(0, 120)}`,
    );
    check(
      "the refusal carries no URL of any kind",
      anon.text.length > 0 && !/https?:\/\//.test(anon.text),
      anon.text.slice(0, 120),
    );

    const crossOrigin = await post(on, "/api/billing/checkout", {
      body: { plan: "pro" },
      store: owner,
      origin: "https://evil.example",
    });
    check(
      "a cross-origin checkout is refused with 403, before the session is read",
      crossOrigin.status === 403 && crossOrigin.json?.error?.code === "CSRF_ORIGIN_REJECTED",
      `status ${crossOrigin.status}`,
    );

    // ---- 3. What a client may ask to buy -----------------------------------
    section(3, "Pro is the only purchasable plan, and the client never names a price");
    const business = await post(on, "/api/billing/checkout", {
      body: { plan: "business" },
      store: owner,
    });
    check(
      "a Business checkout is refused with 400",
      business.status === 400 && business.json?.error?.code === "INVALID_INPUT",
      `status ${business.status} ${business.text.slice(0, 140)}`,
    );

    const forged = await post(on, "/api/billing/checkout", {
      body: {
        plan: PRICE_BUSINESS_LIKE,
        priceId: PRICE_BUSINESS_LIKE,
        price: PRICE_BUSINESS_LIKE,
        amount: 1,
        successUrl: "https://evil.example/win",
        customerId: "cus_attacker",
        userId: otherUser?.id,
      },
      store: owner,
    });
    check(
      "an arbitrary provider price id is refused with 400",
      forged.status === 400 && forged.json?.error?.code === "INVALID_INPUT",
      `status ${forged.status}`,
    );
    check(
      "the refusal echoes back neither the price, the customer nor the return URL",
      forged.text.length > 0 &&
        !forged.text.includes(PRICE_BUSINESS_LIKE) &&
        !forged.text.includes("cus_attacker") &&
        !forged.text.includes("evil.example"),
      forged.text.slice(0, 160),
    );

    const afterRefusals = await planOf(on, owner);
    const rowAfterRefusals = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "no refused checkout wrote billing state",
      afterRefusals.plan === "free" &&
        rowAfterRefusals?.planId === "free" &&
        rowAfterRefusals?.providerSubscriptionId === null,
      `app=${afterRefusals.plan} db=${rowAfterRefusals?.planId}`,
    );
    environmentLimited(
      "a successful Pro checkout returns a provider-hosted URL",
      "needs a live Stripe API call",
    );

    // ---- 4. Coming back from the provider ----------------------------------
    section(4, "Returning from the provider grants nothing");
    const successPage = await get(on, "/pricing?checkout=success", { store: owner });
    check(
      "/pricing?checkout=success renders for the signed-in owner",
      successPage.status === 200 && successPage.text.length > 500,
      `status ${successPage.status} bytes ${successPage.text.length}`,
    );
    const afterSuccess = await planOf(on, owner);
    const rowAfterSuccess = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "the success query upgrades nobody, in the application or in the database",
      afterSuccess.plan === "free" && rowAfterSuccess?.planId === "free",
      `app=${afterSuccess.plan} db=${rowAfterSuccess?.planId}`,
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const periodEnd = nowSec + 30 * 24 * 3600;

    const oneOffBody = oneOffCheckoutEvent({ id: "evt_probe_oneoff", createdSec: nowSec - 120 });
    const oneOff = await post(on, "/api/billing/webhook", {
      raw: oneOffBody,
      origin: null,
      headers: { "stripe-signature": signed(oneOffBody, nowSec) },
    });
    const rowAfterOneOff = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "a completed checkout that bought no subscription grants no plan",
      oneOff.status === 200 &&
        oneOff.json?.applied === false &&
        oneOff.json?.reason === "no_subscription" &&
        rowAfterOneOff?.planId === "free",
      `status ${oneOff.status} reason=${oneOff.json?.reason} db=${rowAfterOneOff?.planId}`,
    );

    // ---- 5. Signature verification, then a real grant ----------------------
    section(5, "The webhook verifies its signature first, then grants Pro");
    const eventsBeforeGrant = await db.billingEvent.count();
    const grantBody = subscriptionEvent({
      id: "evt_probe_grant",
      type: "customer.subscription.created",
      createdSec: nowSec - 60,
      periodEndSec: periodEnd,
      canary: true,
    });

    const unsigned = await post(on, "/api/billing/webhook", { raw: grantBody, origin: null });
    check(
      "an unsigned delivery is refused with 400",
      unsigned.status === 400 && unsigned.json?.error?.code === "INVALID_SIGNATURE",
      `status ${unsigned.status}`,
    );

    const wrongSecret = await post(on, "/api/billing/webhook", {
      raw: grantBody,
      origin: null,
      headers: { "stripe-signature": signed(grantBody, nowSec, "whsec_not_the_secret") },
    });
    check(
      "a delivery signed with the wrong secret is refused with 400",
      wrongSecret.status === 400 && wrongSecret.json?.error?.code === "INVALID_SIGNATURE",
      `status ${wrongSecret.status}`,
    );

    const altered = await post(on, "/api/billing/webhook", {
      raw: `${grantBody} `,
      origin: null,
      headers: { "stripe-signature": signed(grantBody, nowSec) },
    });
    check(
      "a body altered by one byte after signing is refused with 400",
      altered.status === 400,
      `status ${altered.status}`,
    );

    const expiredSignature = await post(on, "/api/billing/webhook", {
      raw: grantBody,
      origin: null,
      headers: { "stripe-signature": signed(grantBody, nowSec - 3600) },
    });
    check(
      "a correctly signed replay from outside the tolerance window is refused with 400",
      expiredSignature.status === 400,
      `status ${expiredSignature.status}`,
    );

    check(
      "no refusal echoed the unverified payload",
      ![unsigned, wrongSecret, altered, expiredSignature].some((r) => r.text.includes(CANARY)),
    );
    const refusedPlan = await planOf(on, owner);
    check(
      "four refused deliveries granted nothing and claimed no event id",
      refusedPlan.plan === "free" && (await db.billingEvent.count()) === eventsBeforeGrant,
      `plan=${refusedPlan.plan}`,
    );

    const grant = await post(on, "/api/billing/webhook", {
      raw: grantBody,
      origin: null,
      headers: { "stripe-signature": signed(grantBody, nowSec) },
    });
    check(
      "the same body, validly signed, is accepted and applied",
      grant.status === 200 && grant.json?.received === true && grant.json?.applied === true,
      `status ${grant.status} ${grant.text.slice(0, 160)}`,
    );

    const granted = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "the real repository stored an active Pro subscription",
      granted?.planId === "pro" &&
        granted?.status === "active" &&
        granted?.providerPriceId === PRICE_PRO &&
        granted?.providerSubscriptionId === "sub_probe_1" &&
        granted?.lastEventAt !== null,
      `plan=${granted?.planId} status=${granted?.status}`,
    );

    const proPlan = await planOf(on, owner);
    check("the application now reports plan=pro", proPlan.plan === "pro", `plan=${proPlan.plan}`);
    check(
      "granting Pro did not switch limits into enforcement",
      proPlan.mode === "observe",
      `mode=${proPlan.mode}`,
    );

    // ---- 6. Idempotency ----------------------------------------------------
    section(6, "A redelivered event applies exactly once");
    // Same event id, contradictory payload. If idempotency is keyed on anything
    // weaker than the event id, this cancellation lands.
    const eventsBeforeDuplicate = await db.billingEvent.count();
    const duplicateBody = subscriptionEvent({
      id: "evt_probe_grant",
      createdSec: nowSec + 5,
      status: "canceled",
      priceId: PRICE_BUSINESS_LIKE,
      periodEndSec: periodEnd,
    });
    const duplicate = await post(on, "/api/billing/webhook", {
      raw: duplicateBody,
      origin: null,
      headers: { "stripe-signature": signed(duplicateBody, nowSec) },
    });
    check(
      "the redelivery answers 200 with reason=duplicate, so the provider stops retrying",
      duplicate.status === 200 &&
        duplicate.json?.applied === false &&
        duplicate.json?.reason === "duplicate",
      `status ${duplicate.status} ${duplicate.text.slice(0, 140)}`,
    );
    const afterDuplicate = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    check(
      "the redelivery's contradictory payload was not applied",
      afterDuplicate?.planId === "pro" &&
        afterDuplicate?.status === "active" &&
        afterDuplicate?.providerPriceId === PRICE_PRO,
      `plan=${afterDuplicate?.planId} status=${afterDuplicate?.status} price=${afterDuplicate?.providerPriceId}`,
    );
    check(
      "the second delivery added no event row",
      (await db.billingEvent.count()) === eventsBeforeDuplicate,
      `events=${eventsBeforeDuplicate}`,
    );

    // ---- 7. Ordering -------------------------------------------------------
    section(7, "A stale event cannot overwrite newer state");
    const staleBody = subscriptionEvent({
      id: "evt_probe_stale",
      createdSec: nowSec - 3600,
      status: "canceled",
      periodEndSec: periodEnd,
    });
    const stale = await post(on, "/api/billing/webhook", {
      raw: staleBody,
      origin: null,
      headers: { "stripe-signature": signed(staleBody, nowSec) },
    });
    check(
      "an out-of-order cancellation is dropped as stale, with a final 200",
      stale.status === 200 && stale.json?.applied === false && stale.json?.reason === "stale",
      `status ${stale.status} ${stale.text.slice(0, 140)}`,
    );
    const afterStale = await planOf(on, owner);
    check(
      "the newer Pro state survived the stale cancellation",
      afterStale.plan === "pro",
      `plan=${afterStale.plan}`,
    );

    // ---- 8. Price mapping --------------------------------------------------
    section(8, "An unmapped price grants no paid plan, and no price grants Business");
    const unknownBody = subscriptionEvent({
      id: "evt_probe_unknown_price",
      createdSec: nowSec + 100,
      priceId: PRICE_UNKNOWN,
      periodEndSec: periodEnd,
    });
    const unknown = await post(on, "/api/billing/webhook", {
      raw: unknownBody,
      origin: null,
      headers: { "stripe-signature": signed(unknownBody, nowSec) },
    });
    const unknownRow = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    const unknownPlan = await planOf(on, owner);
    check(
      "an active subscription on an unmapped price is recorded but grants nothing",
      unknown.status === 200 &&
        unknown.json?.applied === true &&
        unknown.json?.reason === "unmapped_price" &&
        unknownRow?.planId === "free" &&
        unknownRow?.providerPriceId === PRICE_UNKNOWN &&
        unknownPlan.plan === "free",
      `reason=${unknown.json?.reason} db=${unknownRow?.planId} app=${unknownPlan.plan}`,
    );

    const businessBody = subscriptionEvent({
      id: "evt_probe_business_price",
      createdSec: nowSec + 200,
      priceId: PRICE_BUSINESS_LIKE,
      periodEndSec: periodEnd,
      organizationIdMetadata: orgOwner.organizationId,
    });
    const businessPrice = await post(on, "/api/billing/webhook", {
      raw: businessBody,
      origin: null,
      headers: { "stripe-signature": signed(businessBody, nowSec) },
    });
    const businessRow = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    const businessPlan = await planOf(on, owner);
    check(
      "a Business-shaped price on an active subscription grants neither Business nor Pro",
      businessPrice.status === 200 &&
        businessRow?.planId === "free" &&
        businessPlan.plan !== "business" &&
        businessPlan.plan !== "pro",
      `db=${businessRow?.planId} app=${businessPlan.plan}`,
    );
    check(
      "STRIPE_PRICE_BUSINESS, set in this deployment's environment, bought nothing",
      businessRow?.planId !== "business" && businessPlan.plan !== "business",
      `db=${businessRow?.planId}`,
    );

    // ---- 9. Anti-vacuity ---------------------------------------------------
    section(9, "Pro can still be granted — the two sections above were real refusals");
    const regrantBody = subscriptionEvent({
      id: "evt_probe_regrant",
      createdSec: nowSec + 300,
      periodEndSec: periodEnd,
    });
    const regrant = await post(on, "/api/billing/webhook", {
      raw: regrantBody,
      origin: null,
      headers: { "stripe-signature": signed(regrantBody, nowSec) },
    });
    const regrantPlan = await planOf(on, owner);
    check(
      "a newer event on the configured Pro price restores plan=pro",
      regrant.status === 200 && regrant.json?.applied === true && regrantPlan.plan === "pro",
      `status ${regrant.status} app=${regrantPlan.plan}`,
    );

    // ---- 10. Ownership -----------------------------------------------------
    section(10, "Ownership comes from the stored customer, never from the payload");
    const spoofBody = subscriptionEvent({
      id: "evt_probe_metadata_spoof",
      createdSec: nowSec + 400,
      status: "canceled",
      periodEndSec: periodEnd,
      organizationIdMetadata: orgOther.organizationId,
    });
    const spoof = await post(on, "/api/billing/webhook", {
      raw: spoofBody,
      origin: null,
      headers: { "stripe-signature": signed(spoofBody, nowSec) },
    });
    const spoofTarget = await db.billingSubscription.findUnique({
      where: { organizationId: orgOther.organizationId },
    });
    const spoofOwnerPlan = await planOf(on, owner);
    check(
      "an event whose metadata names a different organization is refused, and mints no row for it",
      spoof.status === 200 &&
        spoof.json?.applied === false &&
        spoof.json?.reason === "ownership_mismatch" &&
        spoofTarget === null &&
        spoofOwnerPlan.plan === "pro",
      `reason=${spoof.json?.reason} other=${spoofTarget === null ? "no row" : "ROW CREATED"} owner=${spoofOwnerPlan.plan}`,
    );

    const strangerBody = subscriptionEvent({
      id: "evt_probe_unknown_customer",
      createdSec: nowSec + 500,
      customerId: "cus_never_issued_by_us",
      subscriptionId: "sub_probe_forged",
      organizationIdMetadata: orgOther.organizationId,
    });
    const stranger = await post(on, "/api/billing/webhook", {
      raw: strangerBody,
      origin: null,
      headers: { "stripe-signature": signed(strangerBody, nowSec) },
    });
    const otherPlan = await planOf(on, other);
    check(
      "a signed event for a customer we never issued mints no entitlement",
      stranger.status === 200 &&
        stranger.json?.applied === false &&
        stranger.json?.reason === "unknown_customer" &&
        otherPlan.plan === "free" &&
        (await db.billingSubscription.count()) === 1,
      `reason=${stranger.json?.reason} other=${otherPlan.plan}`,
    );

    // ---- 11. Cancellation --------------------------------------------------
    section(11, "Cancellation removes Pro");
    const deleteBody = subscriptionEvent({
      id: "evt_probe_deleted",
      type: "customer.subscription.deleted",
      createdSec: nowSec + 600,
      status: "active",
      periodEndSec: periodEnd,
    });
    const deleted = await post(on, "/api/billing/webhook", {
      raw: deleteBody,
      origin: null,
      headers: { "stripe-signature": signed(deleteBody, nowSec) },
    });
    const deletedRow = await db.billingSubscription.findUnique({
      where: { organizationId: orgOwner.organizationId },
    });
    const cancelledPlan = await planOf(on, owner);
    check(
      "subscription.deleted removes the paid plan even though the object still said active",
      deleted.status === 200 &&
        deleted.json?.applied === true &&
        deletedRow?.planId === "free" &&
        deletedRow?.status === "canceled" &&
        cancelledPlan.plan === "free",
      `db=${deletedRow?.planId}/${deletedRow?.status} app=${cancelledPlan.plan}`,
    );

    // ---- 12. Portal --------------------------------------------------------
    section(12, "The portal uses the stored customer and nothing from the request");
    const portalNoCustomer = await post(on, "/api/billing/portal", {
      store: other,
      body: { customerId: CUSTOMER, organizationId: orgOther.organizationId },
    });
    check(
      "an organization with no stored customer gets 409, not a portal for the id it sent",
      portalNoCustomer.status === 409 &&
        portalNoCustomer.json?.error?.code === "NO_BILLING_CUSTOMER" &&
        !portalNoCustomer.text.includes(CUSTOMER),
      `status ${portalNoCustomer.status} ${portalNoCustomer.text.slice(0, 140)}`,
    );

    const portalForged = await post(on, "/api/billing/portal", {
      store: owner,
      body: { customerId: "cus_attacker_controlled" },
    });
    check(
      "a client-supplied customer id yields no URL and is never echoed",
      portalForged.status !== 200 &&
        !portalForged.text.includes("cus_attacker_controlled") &&
        !/"url"\s*:\s*"http/.test(portalForged.text),
      `status ${portalForged.status} ${portalForged.text.slice(0, 140)}`,
    );
    environmentLimited(
      "a successful portal session returns a provider-hosted URL",
      "needs a live Stripe API call",
    );

    // ---- 13. No provider configured ----------------------------------------
    section(13, "A deployment with no provider credentials fails safely");
    const offOwner = jar();
    await signup(off, offOwner, `probe-off-${stamp}@pdfdadi.test`);

    const offAnon = await post(off, "/api/billing/portal", { body: {} });
    check(
      "an anonymous portal request is refused with 401",
      offAnon.status === 401,
      `status ${offAnon.status}`,
    );

    const offCheckout = await post(off, "/api/billing/checkout", {
      store: offOwner,
      body: { plan: "pro" },
    });
    check(
      "checkout answers 503 BILLING_NOT_CONFIGURED rather than half-working",
      offCheckout.status === 503 && offCheckout.json?.error?.code === "BILLING_NOT_CONFIGURED",
      `status ${offCheckout.status} ${offCheckout.text.slice(0, 140)}`,
    );

    const offWebhookBody = subscriptionEvent({
      id: "evt_probe_off",
      createdSec: nowSec,
      periodEndSec: periodEnd,
    });
    const offWebhook = await post(off, "/api/billing/webhook", {
      raw: offWebhookBody,
      origin: null,
      headers: { "stripe-signature": signed(offWebhookBody, nowSec) },
    });
    check(
      "the webhook refuses with no provider and writes nothing",
      offWebhook.status === 503 && (await dbNoBilling.billingSubscription.count()) === 0,
      `status ${offWebhook.status}`,
    );

    const offPlan = await planOf(off, offOwner);
    check(
      "the account on that deployment is free, with limits observed",
      offPlan.plan === "free" && offPlan.mode === "observe",
      `plan=${offPlan.plan} mode=${offPlan.mode}`,
    );

    // ---- 14. Usage mode ----------------------------------------------------
    section(14, "Usage limits stayed observe-only throughout");
    const finalMode = await planOf(on, owner);
    check(
      "USAGE_LIMIT_MODE was never set, and resolves to observe on both deployments",
      finalMode.mode === "observe" && offPlan.mode === "observe",
      `configured=${finalMode.mode} absent=${offPlan.mode}`,
    );

    // ---- 15. The per-client limit is real ----------------------------------
    section(15, "Billing session creation is rate limited per client");
    // Every check above presented its own client address, so the limiter never
    // interfered. This proves that was headroom rather than a dead limiter.
    const burstIp = "10.99.99.1";
    let limitedAt = null;
    for (let attempt = 1; attempt <= 8 && limitedAt === null; attempt += 1) {
      const res = await post(on, "/api/billing/checkout", { body: { plan: "pro" }, ip: burstIp });
      if (res.status === 429) limitedAt = attempt;
    }
    check(
      "a burst from one address is eventually rejected with 429",
      limitedAt !== null && limitedAt > 1,
      limitedAt === null ? "never limited in 8 attempts" : `limited on attempt ${limitedAt}`,
    );

    // ---- 16. Ownership when BOTH tenants have a billing row ----------------
    section(16, "Metadata cannot move a subscription onto a second billing tenant");
    // Section 10 proved metadata naming an org with *no* row mints nothing. That
    // check is satisfied even by a resolver that looks the metadata id up first and
    // happens to find nothing — mutation testing caught exactly that escape. Here
    // the named organization DOES have a billing row, so a metadata-trusting
    // resolver would find it, agree with its own hint, and grant Pro to the wrong
    // tenant. Runs last because section 12 needs this organization to have no
    // customer of its own.
    await db.billingSubscription.create({
      data: {
        organizationId: orgOther.organizationId,
        provider: "stripe",
        providerCustomerId: "cus_probe_org2",
      },
    });
    const crossBody = subscriptionEvent({
      id: "evt_probe_cross_tenant",
      createdSec: nowSec + 900,
      status: "active",
      periodEndSec: periodEnd,
      organizationIdMetadata: orgOther.organizationId,
    });
    const cross = await post(on, "/api/billing/webhook", {
      raw: crossBody,
      origin: null,
      headers: { "stripe-signature": signed(crossBody, nowSec) },
    });
    const crossTarget = await db.billingSubscription.findUnique({
      where: { organizationId: orgOther.organizationId },
    });
    const crossPlan = await planOf(on, other);
    check(
      "a signed event whose metadata names another billing tenant grants that tenant nothing",
      cross.status === 200 &&
        cross.json?.applied === false &&
        cross.json?.reason === "ownership_mismatch" &&
        crossTarget?.planId === "free" &&
        crossTarget?.providerSubscriptionId === null &&
        crossTarget?.providerCustomerId === "cus_probe_org2" &&
        crossPlan.plan === "free",
      `reason=${cross.json?.reason} target=${crossTarget?.planId}/${crossTarget?.providerSubscriptionId ?? "no sub"} app=${crossPlan.plan}`,
    );

    // ---- 17. The public summary --------------------------------------------
    section(17, "The public summary is anonymous-safe and names nothing");
    const anonSummary = await get(on, "/api/billing/summary");
    // Fixture first: the whole section is about what a CONFIGURED deployment tells
    // a visitor, and every assertion below would also hold on a deployment that
    // simply cannot sell anything. Prove it can.
    check(
      "the summary endpoint answers an anonymous GET on a configured deployment",
      anonSummary.status === 200 &&
        anonSummary.json !== null &&
        anonSummary.json?.configured === true,
      `status ${anonSummary.status} configured=${anonSummary.json?.configured}`,
    );
    check(
      "an anonymous visitor is guest, not signed in, and is offered sign-in",
      anonSummary.json?.signedIn === false &&
        anonSummary.json?.plan === "guest" &&
        anonSummary.json?.action === "sign_in" &&
        typeof anonSummary.json?.actionLabel === "string" &&
        anonSummary.json.actionLabel.length > 0,
      `signedIn=${anonSummary.json?.signedIn} plan=${anonSummary.json?.plan} action=${anonSummary.json?.action}`,
    );
    // Enumerated, not sampled: a field added to this response later has to be
    // added here too, which is the only way "it leaks nothing" survives the next
    // change to the endpoint.
    check(
      "the response carries exactly the rendering fields and no others",
      Object.keys(anonSummary.json ?? {}).sort().join(",") ===
        "action,actionLabel,configured,note,plan,priceLabel,pricePeriod,signedIn",
      Object.keys(anonSummary.json ?? {}).sort().join(","),
    );
    const secretShapes = [
      ["a provider customer id", CUSTOMER],
      ["the second tenant's customer id", "cus_probe_org2"],
      ["a provider subscription id", "sub_probe_1"],
      ["the configured Pro price id", PRICE_PRO],
      ["the Business price id", PRICE_BUSINESS_LIKE],
      ["the Stripe secret key", STRIPE_KEY],
      ["the webhook signing secret", WEBHOOK_SECRET],
      ["the owner's organization id", orgOwner.organizationId],
      ["the owner's user id", ownerUser.id],
    ];
    const anonLeaks = secretShapes.filter(([, value]) => anonSummary.text.includes(value));
    check(
      "no provider id, owner id, price id or secret appears in the anonymous body",
      anonSummary.text.length > 0 && anonLeaks.length === 0,
      anonLeaks.length ? anonLeaks.map(([name]) => name).join(", ") : anonSummary.text.slice(0, 200),
    );
    check(
      "the response is marked private so a shared cache cannot serve one visitor's offer to the next",
      /private/.test(
        (await fetch(`${on}/api/billing/summary`)).headers.get("cache-control") ?? "",
      ),
      (await fetch(`${on}/api/billing/summary`)).headers.get("cache-control") ?? "absent",
    );

    // ---- 18. Checkout is offered only where it can complete ----------------
    section(18, "Checkout is offered only on a deployment that can actually sell Pro");
    // The owner is on free here: section 11 cancelled the subscription, and
    // section 16 wrote nothing to this organization.
    const freeOwnerSummary = await get(on, "/api/billing/summary", { store: owner });
    const freeOwnerPlan = await planOf(on, owner);
    check(
      "the free owner's own summary offers checkout, matching the plan the app reports",
      freeOwnerSummary.status === 200 &&
        freeOwnerSummary.json?.signedIn === true &&
        freeOwnerSummary.json?.plan === "free" &&
        freeOwnerSummary.json?.action === "checkout" &&
        freeOwnerPlan.plan === "free",
      `action=${freeOwnerSummary.json?.action} summaryPlan=${freeOwnerSummary.json?.plan} appPlan=${freeOwnerPlan.plan}`,
    );
    // The A/B that makes the claim mean something: the same request, by an owner in
    // the same role, against a deployment with no provider credentials.
    const offSummaryOwner = jar();
    await signup(off, offSummaryOwner, `probe-off-summary-${stamp}@pdfdadi.test`);
    const offSummary = await get(off, "/api/billing/summary", { store: offSummaryOwner });
    check(
      "an owner on the billing-absent deployment is offered no purchase at all",
      offSummary.status === 200 &&
        offSummary.json?.configured === false &&
        offSummary.json?.signedIn === true &&
        offSummary.json?.action === "unavailable" &&
        offSummary.json?.priceLabel === null,
      `configured=${offSummary.json?.configured} action=${offSummary.json?.action} price=${offSummary.json?.priceLabel}`,
    );
    // ...and it refuses the POST too, so the button state and the endpoint agree.
    const offOwnerCheckout = await post(off, "/api/billing/checkout", {
      store: offSummaryOwner,
      body: { plan: "pro" },
    });
    check(
      "that deployment also refuses the checkout POST, so no state disagrees with the button",
      offOwnerCheckout.status === 503,
      `status ${offOwnerCheckout.status}`,
    );

    // Display price. The provider credential here is a well-formed fake, so the
    // price read fails — which is exactly the degraded case worth pinning: the
    // response must stay structurally valid and carry NO amount.
    const priceBodies = [anonSummary, freeOwnerSummary, offSummary];
    check(
      "with an unreadable provider price, priceLabel is null on every caller's summary",
      priceBodies.every((r) => r.json?.priceLabel === null && r.json?.pricePeriod === null),
      priceBodies.map((r) => String(r.json?.priceLabel)).join(" / "),
    );
    check(
      "and no currency amount is fabricated anywhere in those responses",
      priceBodies.every(
        (r) => r.text.length > 0 && !/[$€£¥]\s?\d|\d+[.,]\d\d/.test(r.text),
      ),
      priceBodies.map((r) => r.text.slice(0, 90)).join(" | "),
    );
    check(
      "the checkout state is still truthful with no price to show",
      freeOwnerSummary.json?.action === "checkout" && offSummary.json?.action === "unavailable",
      `configured=${freeOwnerSummary.json?.action} absent=${offSummary.json?.action}`,
    );
    environmentLimited(
      "a real configured Stripe price is read and rendered as a display amount",
      "needs live Stripe test credentials — see scripts/stripe-testmode-probe.mjs",
    );

    // ---- 19. A member who may not buy --------------------------------------
    section(19, "A non-owner member is told it is owner-only, and cannot buy");
    const member = jar();
    await signup(on, member, `probe-member-${stamp}@pdfdadi.test`);
    const memberUser = (await db.user.findMany()).find(
      (u) => u.email === `probe-member-${stamp}@pdfdadi.test`,
    );
    // `admin` on purpose, not `viewer`: admin carries org:manage and every other
    // privileged permission EXCEPT billing:manage, so this proves the gate is the
    // billing permission rather than "any elevated role".
    await db.organizationMembership.create({
      data: { organizationId: orgOwner.organizationId, userId: memberUser.id, role: "admin" },
    });
    const memberRow = await db.organizationMembership.findFirst({
      where: { organizationId: orgOwner.organizationId, userId: memberUser.id },
    });
    check(
      "the fixture exists: a real admin membership in the owner's organization",
      memberRow?.role === "admin" && memberRow.organizationId === orgOwner.organizationId,
      `role=${memberRow?.role}`,
    );
    const memberSummary = await get(
      on,
      `/api/billing/summary?organizationId=${encodeURIComponent(orgOwner.organizationId)}`,
      { store: member },
    );
    check(
      "the admin's summary for that organization says owner-only and offers no purchase",
      memberSummary.status === 200 &&
        memberSummary.json?.signedIn === true &&
        memberSummary.json?.action === "owner_only" &&
        memberSummary.json?.plan === "free",
      `action=${memberSummary.json?.action} plan=${memberSummary.json?.plan}`,
    );
    const memberCheckout = await post(on, "/api/billing/checkout", {
      store: member,
      body: { plan: "pro", organizationId: orgOwner.organizationId },
    });
    check(
      "and the endpoint refuses them, so the button state is not a lie in either direction",
      memberCheckout.status === 403 &&
        memberCheckout.json?.error?.code === "FORBIDDEN" &&
        !/"url"/.test(memberCheckout.text),
      `status ${memberCheckout.status} code=${memberCheckout.json?.error?.code}`,
    );

    // ---- 20. Trusted state is what turns the card into "manage" -------------
    section(20, "Only trusted billing state makes the summary say Pro");
    const beforeTrusted = await get(on, "/api/billing/summary", { store: owner });
    const proBody = subscriptionEvent({
      id: "evt_probe_summary_pro",
      createdSec: nowSec + 1800,
      periodEndSec: periodEnd,
    });
    const proGrant = await post(on, "/api/billing/webhook", {
      raw: proBody,
      origin: null,
      headers: { "stripe-signature": signed(proBody, nowSec) },
    });
    const trustedSummary = await get(on, "/api/billing/summary", { store: owner });
    const trustedPlan = await planOf(on, owner);
    check(
      "the signed event was applied — the transition below is a real one",
      proGrant.status === 200 && proGrant.json?.applied === true,
      `status ${proGrant.status} applied=${proGrant.json?.applied}`,
    );
    check(
      "the same caller went from checkout to manage only after trusted state changed",
      beforeTrusted.json?.action === "checkout" &&
        beforeTrusted.json?.plan === "free" &&
        trustedSummary.json?.action === "manage" &&
        trustedSummary.json?.plan === "pro",
      `before=${beforeTrusted.json?.plan}/${beforeTrusted.json?.action} after=${trustedSummary.json?.plan}/${trustedSummary.json?.action}`,
    );
    check(
      "the application agrees: /api/usage reports pro for the same session",
      trustedPlan.plan === "pro" && trustedPlan.mode === "observe",
      `plan=${trustedPlan.plan} mode=${trustedPlan.mode}`,
    );
    check(
      "the paid summary still names no customer, subscription or price id",
      trustedSummary.text.length > 0 &&
        !secretShapes.some(([, value]) => trustedSummary.text.includes(value)),
      trustedSummary.text.slice(0, 200),
    );

    // ---- 21. A foreign organization selector --------------------------------
    section(21, "Selecting another tenant's organization gains nothing");
    // Runs after the grant above on purpose: there is now real Pro state, a real
    // customer and a real subscription attached to the owner's organization, so
    // "the foreign caller learns nothing" is a claim about state that exists.
    const foreignSummary = await get(
      on,
      `/api/billing/summary?organizationId=${encodeURIComponent(orgOwner.organizationId)}`,
      { store: other },
    );
    check(
      "the foreign caller is not given the target's plan, and is offered no purchase for it",
      foreignSummary.status === 200 &&
        foreignSummary.json?.plan !== "pro" &&
        foreignSummary.json?.action !== "manage" &&
        foreignSummary.json?.action !== "checkout",
      `plan=${foreignSummary.json?.plan} action=${foreignSummary.json?.action}`,
    );
    check(
      "and the response carries no identifier belonging to the foreign organization",
      foreignSummary.text.length > 0 &&
        !secretShapes.some(([, value]) => foreignSummary.text.includes(value)),
      foreignSummary.text.slice(0, 200),
    );
    const foreignCheckout = await post(on, "/api/billing/checkout", {
      store: other,
      body: { plan: "pro", organizationId: orgOwner.organizationId },
    });
    const foreignPortal = await post(on, "/api/billing/portal", {
      store: other,
      body: { organizationId: orgOwner.organizationId },
    });
    check(
      "no purchase permission is derived from the foreign selector, on either endpoint",
      foreignCheckout.status === 403 &&
        foreignPortal.status === 403 &&
        !/"url"/.test(foreignCheckout.text) &&
        !/"url"/.test(foreignPortal.text),
      `checkout ${foreignCheckout.status} portal ${foreignPortal.status}`,
    );
    const ownerStillPro = await planOf(on, owner);
    check(
      "the target organization's own state was not disturbed by any of it",
      ownerStillPro.plan === "pro",
      `owner=${ownerStillPro.plan}`,
    );

    // ---- 22. The checkout return, at the summary level ----------------------
    section(22, "The checkout success query is not entitlement, at any layer");
    // A caller who has never paid, whose ONLY organization is its own free one.
    // Deliberately a fresh account rather than the admin from section 19: that one
    // is a member of the owner's now-Pro organization, so it legitimately reads
    // `pro` on its default tenant and would prove nothing here.
    const payer = jar();
    await signup(on, payer, `probe-payer-${stamp}@pdfdadi.test`);
    const payerUser = (await db.user.findMany()).find(
      (u) => u.email === `probe-payer-${stamp}@pdfdadi.test`,
    );
    const payerOrgs = await db.organizationMembership.findMany({
      where: { userId: payerUser.id },
    });
    check(
      "the fixture is unambiguous: the caller owns exactly one organization",
      payerOrgs.length === 1 && payerOrgs[0].role === "owner",
      `orgs=${payerOrgs.length} role=${payerOrgs[0]?.role}`,
    );
    const payerBefore = await get(on, "/api/billing/summary", { store: payer });
    const successVisit = await get(on, "/pricing?checkout=success", { store: payer });
    const payerAfter = await get(on, "/api/billing/summary", { store: payer });
    const payerPlan = await planOf(on, payer);
    const payerRow = await db.billingSubscription.findUnique({
      where: { organizationId: payerOrgs[0].organizationId },
    });
    check(
      "the success page renders for them, so the query really was delivered",
      successVisit.status === 200 && successVisit.text.length > 500,
      `status ${successVisit.status} bytes ${successVisit.text.length}`,
    );
    check(
      "their offer was a purchase before the visit and is the same purchase after it",
      payerBefore.json?.action === "checkout" &&
        payerAfter.json?.action === "checkout" &&
        payerAfter.json?.plan === "free" &&
        payerPlan.plan === "free",
      `before=${payerBefore.json?.action} after=${payerAfter.json?.action}/${payerAfter.json?.plan} app=${payerPlan.plan}`,
    );
    check(
      "and no billing row was created for their organization by visiting it",
      payerRow === null,
      payerRow === null ? "no row" : `ROW CREATED plan=${payerRow.planId}`,
    );
    // The page must not be able to finish the job itself, whatever it renders.
    check(
      "the returned page ships no endpoint that could confirm a checkout",
      successVisit.text.length > 0 &&
        !/\/api\/billing\/(confirm|activate|sync|grant)/.test(successVisit.text),
      `bytes ${successVisit.text.length}`,
    );

    // ---- 23. A billing failure is contained --------------------------------
    section(23, "A deployment that cannot bill still runs the product");
    const offPricing = await get(off, "/pricing", { store: offSummaryOwner });
    check(
      "the pricing page renders in full where billing is unavailable",
      offPricing.status === 200 && offPricing.text.length > 500,
      `status ${offPricing.status} bytes ${offPricing.text.length}`,
    );
    // Two removals before looking for money, both necessary and neither weakening
    // the claim. `<script>` holds Next's RSC flight payload, whose element
    // references are literally `"$1"`, `"$8"` — 12 of them on this page, none of
    // them currency. And the free plan's approved price really is "$0". What is
    // left is what the page SHOWS, where an invented amount would have to appear.
    const offPricingMoney = offPricing.text
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/\$0\b/g, "");
    check(
      "it keeps the approved Pro copy and shows no amount the deployment never configured",
      offPricing.text.includes("Not yet available") && !/[$€£¥]\s?\d/.test(offPricingMoney),
      offPricing.text.includes("Not yet available")
        ? `approved copy present; ${(offPricingMoney.match(/[$€£¥]\s?\d[\d.,]*/g) ?? []).join(",") || "no amount"}`
        : "APPROVED COPY GONE",
    );
    const offUsage = await get(off, "/api/usage", { store: offSummaryOwner });
    const offTool = await get(off, "/tools/merge-pdf");
    check(
      "the usage API and a tool page are unaffected by billing being absent",
      offUsage.status === 200 &&
        offUsage.json?.plan === "free" &&
        offTool.status === 200 &&
        offTool.text.length > 500,
      `usage ${offUsage.status}/${offUsage.json?.plan} tool ${offTool.status} bytes ${offTool.text.length}`,
    );
  } finally {
    await db.$disconnect().catch(() => {});
    await dbNoBilling.$disconnect().catch(() => {});
    for (const entry of servers) killServer(entry);
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const l of limits) console.log(`  ENVIRONMENT-LIMITED: ${l.name} — ${l.reason}`);
  console.log(
    "Live Stripe E2E: NOT COVERED HERE — this probe signs its own events. Run " +
      "`node scripts/stripe-testmode-probe.mjs` for real Stripe TEST-MODE verification.",
  );
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nPROBE ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  // The application's own log is the only place a 500 explains itself, and the
  // servers are about to be killed, so print it before they go.
  for (const entry of servers) {
    console.error(`\n--- server :${entry.port} log tail ---\n${entry.tail()}`);
    killServer(entry);
  }
  process.exit(2);
});
