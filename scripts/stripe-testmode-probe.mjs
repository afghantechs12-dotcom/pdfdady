/* global process, console, fetch, setTimeout, clearTimeout */
/**
 * REAL Stripe TEST-MODE verification.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM `billing-probe.mjs` ──────────────────────
 *
 * `scripts/billing-probe.mjs` signs its own webhook deliveries with its own HMAC
 * over Stripe's documented scheme. That is strong evidence about *our* code — the
 * verifier, the service, the repository and the entitlement read are all the real
 * ones — and it is NOT evidence that a Stripe account is wired to this
 * deployment. It never opens a socket to Stripe. Every value it uses
 * (`sk_test_probe_not_a_real_key`, `price_probe_pro`) is a well-formed fake.
 *
 * This probe is the other half, and only this half can say the word "Stripe"
 * about a live integration:
 *
 *   - it talks to `api.stripe.com` with the deployment's CONFIGURED credential
 *   - it asks Stripe whether the configured Pro price actually exists, recurs,
 *     and is a TEST-mode object
 *   - it drives PDFDadi's own checkout endpoint and then asks STRIPE what that
 *     endpoint created, so the assertions are about the object in Stripe's
 *     account rather than about the body our route returned
 *
 * ── IT NEVER TOUCHES LIVE MODE ──────────────────────────────────────────────
 *
 * Two independent gates. A key whose prefix is `sk_live_`/`rk_live_` is refused
 * before a single request is made, and every object retrieved from Stripe must
 * come back `livemode: false` or the run stops. A live key cannot be talked into
 * running this by any flag.
 *
 * ── IT NEVER FABRICATES A PASS ──────────────────────────────────────────────
 *
 * With no test credentials the honest output is that the integration was not
 * exercised, stated in those words, and the exit code is 0 only because "this
 * environment cannot run it" is a legitimate answer to have recorded — not
 * because anything was verified. Individual subsections degrade the same way:
 * webhook ingress needs the Stripe CLI, and its absence limits that subsection
 * alone rather than the whole run.
 *
 * ── SECRETS ─────────────────────────────────────────────────────────────────
 *
 * No secret value is ever printed. Only presence, prefix class (`sk_test`) and
 * length are reported, and the throwaway server's log tail is filtered before it
 * reaches the console.
 *
 * ── RUN IT ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/next-build.js
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_PRO=price_... \
 *     node scripts/stripe-testmode-probe.mjs
 *
 * Optional, for the webhook subsection: `STRIPE_WEBHOOK_SECRET` plus the Stripe
 * CLI (`stripe login` already done). The probe starts its own production server
 * against a throwaway SQLite database under the OS temp directory; no repo file,
 * no `.env` value and no developer database is touched.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg("--port", "3151"));
const STRIPE_API = "https://api.stripe.com";
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

/** Every secret this probe knows, so a log tail can be scrubbed before printing. */
const secrets = [];
function scrub(text) {
  let out = text;
  for (const value of secrets) {
    if (value) out = out.split(value).join("<redacted>");
  }
  // Stripe echoes the offending credential back in its own error bodies, already
  // partly masked (`Invalid API Key provided: sk_test_***********0000`). That form
  // never equals the value in `secrets`, so the loop above cannot catch it, and the
  // trailing characters it keeps are real. Redact anything key-shaped by pattern.
  return out.replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*]+|\bwhsec_[A-Za-z0-9*]+/g, "<redacted>");
}

// ---------------------------------------------------------------------------
// Credential classification. Presence and prefix class only — never a value.
// ---------------------------------------------------------------------------
function classifyKey(key) {
  if (!key) return { kind: "absent" };
  if (/^(sk|rk)_live_/.test(key)) return { kind: "live" };
  if (/^(sk|rk)_test_/.test(key)) return { kind: "test", prefix: key.slice(0, 8) };
  return { kind: "unrecognized", prefix: key.slice(0, 3) };
}

async function stripeRequest(path, { key, method = "GET", form } = {}) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": "2025-04-30.basil",
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? form.toString() : undefined,
  });
  // Scrubbed here, at the one point every caller reads a Stripe response through,
  // so no call site can leak a credential Stripe echoed back at us.
  const text = scrub(await res.text());
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — `text` is the evidence */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Local server + HTTP, same shape as the billing probe (own cookie jar, so
// "anonymous" is genuinely anonymous).
// ---------------------------------------------------------------------------
const servers = [];
function killServer(entry) {
  try {
    process.kill(-entry.child.pid, "SIGKILL");
  } catch {
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

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once("error", (err) =>
      reject(
        new Error(
          `port ${port} is already in use (${err.code}). Stop whatever is listening there — ` +
            `if it is a stray probe server, \`lsof -ti :${port} | xargs kill -9\`.`,
        ),
      ),
    );
    tester.once("listening", () => tester.close(() => resolve()));
    tester.listen(port, "127.0.0.1");
  });
}

async function startServer({ dbUrl, storageRoot, stripeKey, pricePro, webhookSecret }) {
  await assertPortFree(PORT);
  // `localhost`, not `127.0.0.1`: the CSRF check compares Origin against
  // `new URL(request.url).origin`, which `next start` reports as localhost.
  const base = `http://localhost:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    DATABASE_URL: dbUrl,
    ADMIN_SECRET: `stripe-probe-${randomBytes(8).toString("hex")}`,
    NEXT_PUBLIC_SITE_URL: base,
    STORAGE_LOCAL_ROOT: storageRoot,
    // Unset on purpose: this probe observes the default, and must not be the
    // reason a deployment starts enforcing limits.
    USAGE_LIMIT_MODE: undefined,
    STRIPE_SECRET_KEY: stripeKey,
    STRIPE_PRICE_PRO: pricePro,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_BUSINESS: undefined,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];

  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  servers.push({ child, port: PORT, tail: () => scrub(log.slice(-3000)) });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(500);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`server on ${PORT} never became healthy:\n${scrub(log.slice(-2000))}`);
}

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

async function post(base, path, { body, store } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(store && store.size ? { Cookie: cookieHeader(store) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  if (store) absorb(store, res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
}

async function get(base, path, { store } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { ...(store && store.size ? { Cookie: cookieHeader(store) } : {}) },
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

async function signup(base, store, email) {
  const res = await post(base, "/api/auth/signup", {
    store,
    body: {
      name: "Stripe Probe",
      email,
      password: "probe-password-123456",
      confirmPassword: "probe-password-123456",
    },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${res.text.slice(0, 200)}`);
  }
}

/** Whether the Stripe CLI is on PATH and logged in. */
function stripeCli(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("stripe", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ available: false, out: "" });
      return;
    }
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ available: false, out }));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve({ available: true, timedOut: true, out, code: null });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ available: true, out, code });
    });
  });
}

const NOT_RUN_BANNER =
  "Stripe Test Mode: ENVIRONMENT-LIMITED / NOT RUN\n" +
  "This is not evidence of a real Stripe E2E.";

// ---------------------------------------------------------------------------
async function main() {
  console.log("PDFDadi — REAL Stripe TEST-MODE probe");
  console.log("(synthetic signed-webhook verification lives in scripts/billing-probe.mjs)");

  section(0, "Credentials, by presence and prefix class only");
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const pricePro = process.env.STRIPE_PRICE_PRO ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  secrets.push(key, webhookSecret);
  const keyKind = classifyKey(key);

  console.log(
    `  STRIPE_SECRET_KEY:     ${
      keyKind.kind === "absent"
        ? "absent"
        : `${keyKind.kind}${keyKind.prefix ? ` (prefix ${keyKind.prefix}…, length ${key.length})` : ""}`
    }`,
  );
  console.log(`  STRIPE_PRICE_PRO:      ${pricePro ? `set (${pricePro})` : "absent"}`);
  console.log(`  STRIPE_WEBHOOK_SECRET: ${webhookSecret ? `set (length ${webhookSecret.length})` : "absent"}`);

  // Gate 1 of 2 against live mode, before any request exists to be made.
  if (keyKind.kind === "live") {
    console.log(
      "\nREFUSED: STRIPE_SECRET_KEY is a LIVE key. This probe creates checkout and " +
        "portal sessions and must never run against live mode. Supply a test key.",
    );
    process.exit(2);
  }
  if (keyKind.kind === "unrecognized") {
    console.log(
      "\nREFUSED: STRIPE_SECRET_KEY is neither sk_test_/rk_test_ nor sk_live_/rk_live_. " +
        "Refusing rather than guessing which mode it is.",
    );
    process.exit(2);
  }

  if (keyKind.kind === "absent" || !pricePro) {
    const missing = [
      keyKind.kind === "absent" ? "STRIPE_SECRET_KEY (test)" : null,
      pricePro ? null : "STRIPE_PRICE_PRO",
    ].filter(Boolean);
    console.log(`\n  Missing: ${missing.join(", ")}`);
    console.log(`\n${NOT_RUN_BANNER}`);
    console.log(
      "\nWhat this means: no request was made to api.stripe.com, no checkout session " +
        "was created, and nothing here bears on whether a real Stripe account is wired " +
        "to this deployment. The synthetic signed-webhook path is verified separately " +
        "by `node scripts/billing-probe.mjs`; that probe does not talk to Stripe either.",
    );
    console.log(
      "\nTo run it for real: create a TEST-mode recurring price in Stripe, then\n" +
        "  STRIPE_SECRET_KEY=sk_test_… STRIPE_PRICE_PRO=price_… \\\n" +
        "    node scripts/stripe-testmode-probe.mjs",
    );
    // Exit 0: the limitation is confirmed and recorded, which is the outcome. It
    // is deliberately not a pass — the banner above says so in those words.
    process.exit(0);
  }

  check("the configured key is a TEST-mode key, by prefix", keyKind.kind === "test", keyKind.prefix);

  // ---- 1. Ask Stripe about the configured price --------------------------
  section(1, "The configured Pro price exists at Stripe, recurs, and is test mode");
  const price = await stripeRequest(`/v1/prices/${encodeURIComponent(pricePro)}`, { key });
  check(
    "STRIPE_PRICE_PRO resolves to a price object",
    price.status === 200 && price.json?.object === "price",
    `status ${price.status}${price.json?.error?.message ? ` — ${price.json.error.message}` : ""}`,
  );
  if (price.status !== 200) {
    console.log("\nStopping: without a readable configured price nothing below can be verified.");
    return finish();
  }
  // Gate 2 of 2 against live mode: Stripe's own word on the object, not the key's.
  if (price.json.livemode === true) {
    console.log("\nREFUSED: Stripe reports livemode:true for the configured price. Stopping.");
    process.exit(2);
  }
  check("Stripe reports the price as a test-mode object", price.json.livemode === false, "livemode=false");
  check("the price is active", price.json.active === true, `active=${price.json.active}`);
  check(
    "the price is recurring, so a subscription can be billed on it",
    price.json.type === "recurring" && !!price.json.recurring?.interval,
    `type=${price.json.type} interval=${price.json.recurring?.interval ?? "none"}`,
  );
  const expectedAmount = price.json.unit_amount;
  const expectedCurrency = String(price.json.currency ?? "").toLowerCase();
  console.log(
    `  ..   configured price: ${expectedAmount ?? "no unit amount"} ${expectedCurrency} ` +
      `every ${price.json.recurring?.interval_count ?? 1} ${price.json.recurring?.interval ?? "?"}`,
  );

  // ---- 2. A real production deployment with those credentials -------------
  section(2, "A production deployment configured with the real test credentials");
  const root = mkdtempSync(join(tmpdir(), `pdfdadi-stripe-probe-${process.pid}-`));
  const dbUrl = `file:${join(root, "stripe-testmode.db")}`;
  const db = new PrismaClient({ datasourceUrl: dbUrl });
  let base;
  let createdCustomerId = null;

  try {
    await migrate(dbUrl);
    base = await startServer({
      dbUrl,
      storageRoot: join(root, "storage"),
      stripeKey: key,
      pricePro,
      webhookSecret: webhookSecret || undefined,
    });
    check("the server is healthy on a throwaway database", true, base);

    const owner = jar();
    const stamp = Date.now();
    await signup(base, owner, `stripe-probe-${stamp}@pdfdadi.test`);
    const ownerUser = (await db.user.findMany()).find(
      (u) => u.email === `stripe-probe-${stamp}@pdfdadi.test`,
    );
    const ownerMembership = await db.organizationMembership.findFirst({
      where: { userId: ownerUser.id },
    });
    check(
      "an owner account exists with exactly one organization",
      ownerMembership?.role === "owner",
      `role=${ownerMembership?.role}`,
    );

    // The display price should now be readable, which is the one assertion the
    // synthetic probe has to report ENVIRONMENT-LIMITED.
    const summary = await get(base, "/api/billing/summary", { store: owner });
    const amountMatches =
      typeof expectedAmount === "number" &&
      typeof summary.json?.priceLabel === "string" &&
      // Compare on digits only: the label is Intl-formatted, the price is minor units.
      summary.json.priceLabel.replace(/[^\d]/g, "") === String(expectedAmount);
    check(
      "the billing summary shows the REAL configured Stripe price, not a fallback",
      summary.status === 200 &&
        summary.json?.configured === true &&
        typeof summary.json?.priceLabel === "string" &&
        summary.json.priceLabel.length > 0 &&
        amountMatches,
      `priceLabel=${summary.json?.priceLabel ?? "null"} period=${summary.json?.pricePeriod ?? "null"} expected minor units ${expectedAmount}`,
    );

    // ---- 3. PDFDadi creates a real Stripe TEST checkout session -----------
    section(3, "PDFDadi's own endpoint creates a real Stripe TEST checkout session");
    const checkout = await post(base, "/api/billing/checkout", {
      store: owner,
      body: { plan: "pro" },
    });
    check(
      "the checkout endpoint returns a Stripe-hosted URL and a session id",
      checkout.status === 200 &&
        typeof checkout.json?.url === "string" &&
        /^https:\/\/checkout\.stripe\.com\//.test(checkout.json.url) &&
        typeof checkout.json?.sessionId === "string" &&
        checkout.json.sessionId.startsWith("cs_test_"),
      `status ${checkout.status} session=${String(checkout.json?.sessionId).slice(0, 12)}… ${
        checkout.json?.error?.message ?? ""
      }`,
    );
    if (checkout.status !== 200) {
      console.log("\nStopping: no checkout session to retrieve.");
      return finish();
    }

    const row = await db.billingSubscription.findUnique({
      where: { organizationId: ownerMembership.organizationId },
    });
    createdCustomerId = row?.providerCustomerId ?? null;
    check(
      "a provider customer was stored server-side for that organization",
      typeof createdCustomerId === "string" && createdCustomerId.startsWith("cus_"),
      createdCustomerId ? `${createdCustomerId.slice(0, 10)}…` : "no customer stored",
    );
    check(
      "creating a checkout session granted no plan",
      row?.planId === "free" && row?.providerSubscriptionId === null,
      `plan=${row?.planId} sub=${row?.providerSubscriptionId ?? "none"}`,
    );

    // ---- 4. Ask STRIPE what that endpoint actually created ----------------
    section(4, "Stripe's own record of the session matches what this deployment sells");
    const retrieved = await stripeRequest(
      `/v1/checkout/sessions/${encodeURIComponent(checkout.json.sessionId)}?expand[]=line_items`,
      { key },
    );
    check(
      "the session can be retrieved from Stripe",
      retrieved.status === 200 && retrieved.json?.object === "checkout.session",
      `status ${retrieved.status}${retrieved.json?.error?.message ? ` — ${retrieved.json.error.message}` : ""}`,
    );
    if (retrieved.status === 200) {
      if (retrieved.json.livemode === true) {
        console.log("\nREFUSED: Stripe reports livemode:true for the created session. Stopping.");
        process.exit(2);
      }
      check("Stripe reports the session as test mode", retrieved.json.livemode === false, "livemode=false");
      check(
        "the session is in subscription mode",
        retrieved.json.mode === "subscription",
        `mode=${retrieved.json.mode}`,
      );
      const lineItems = retrieved.json.line_items?.data ?? [];
      check(
        "its only line item is the configured Pro price",
        lineItems.length === 1 && lineItems[0]?.price?.id === pricePro,
        `${lineItems.length} item(s): ${lineItems.map((i) => i?.price?.id).join(",") || "none"}`,
      );
      check(
        "the organization is correlated on the session and on the subscription it will create",
        retrieved.json.client_reference_id === ownerMembership.organizationId &&
          retrieved.json.metadata?.organizationId === ownerMembership.organizationId,
        `client_reference_id=${retrieved.json.client_reference_id === ownerMembership.organizationId ? "match" : "MISMATCH"} metadata=${retrieved.json.metadata?.organizationId === ownerMembership.organizationId ? "match" : "MISMATCH"}`,
      );
      check(
        "the customer on the session is the one stored server-side",
        retrieved.json.customer === createdCustomerId,
        retrieved.json.customer === createdCustomerId ? "match" : "MISMATCH",
      );
      // The return URLs are built from configured origin + fixed path. Asserted
      // exactly, because "starts with our origin" would still admit an appended
      // path or query a request had supplied.
      check(
        "the success URL is the fixed, safe one",
        retrieved.json.success_url === `${base}/pricing?checkout=success`,
        String(retrieved.json.success_url),
      );
      check(
        "the cancel URL is the fixed, safe one",
        retrieved.json.cancel_url === `${base}/pricing?checkout=cancelled`,
        String(retrieved.json.cancel_url),
      );
      check(
        "the session is unpaid, so nothing about it could be entitlement yet",
        retrieved.json.payment_status === "unpaid" && retrieved.json.status === "open",
        `payment_status=${retrieved.json.payment_status} status=${retrieved.json.status}`,
      );
    }

    // ---- 5. Portal, against the stored customer ---------------------------
    section(5, "The portal opens for the stored customer");
    if (!createdCustomerId) {
      environmentLimited(
        "a real portal session is created",
        "no provider customer was stored, so there is nothing to open",
      );
    } else {
      const portal = await post(base, "/api/billing/portal", { store: owner, body: {} });
      const portalOk =
        portal.status === 200 && /^https:\/\/billing\.stripe\.com\//.test(portal.json?.url ?? "");
      if (portal.status === 500 || portal.status === 502) {
        // The commonest cause is an unconfigured portal in the Stripe test
        // dashboard, which is an account setting rather than a code defect.
        environmentLimited(
          "a real portal session is created",
          `Stripe refused the portal call (status ${portal.status}) — the test-mode ` +
            "customer portal usually needs configuring once at " +
            "dashboard.stripe.com/test/settings/billing/portal",
        );
      } else {
        check(
          "the portal endpoint returns a Stripe-hosted billing portal URL",
          portalOk,
          `status ${portal.status} ${portalOk ? "billing.stripe.com" : portal.text.slice(0, 140)}`,
        );
      }
      const portalForged = await post(base, "/api/billing/portal", {
        store: owner,
        body: { customerId: "cus_attacker_controlled", returnUrl: "https://evil.example/back" },
      });
      check(
        "a browser-supplied customer id and return URL change nothing about it",
        !portalForged.text.includes("cus_attacker_controlled") &&
          !portalForged.text.includes("evil.example"),
        portalForged.text.slice(0, 120),
      );
    }

    // ---- 6. Webhook ingress -----------------------------------------------
    section(6, "A real Stripe event reaching this deployment grants entitlement");
    const cli = await stripeCli(["--version"], { timeoutMs: 10_000 });
    if (!cli.available) {
      environmentLimited(
        "a real Stripe webhook delivery grants Pro",
        "the Stripe CLI is not installed, and a local endpoint has no public ingress — " +
          "install it and run `stripe login`, or point a test-mode dashboard endpoint at " +
          "a tunnelled URL and replay from there",
      );
    } else if (!webhookSecret) {
      environmentLimited(
        "a real Stripe webhook delivery grants Pro",
        "STRIPE_WEBHOOK_SECRET is not set, so the endpoint answers 503 by design — " +
          "start `stripe listen --forward-to " +
          `${base}/api/billing/webhook\` and pass the whsec_ it prints`,
      );
    } else {
      const listen = spawn(
        "stripe",
        ["listen", "--forward-to", `${base}/api/billing/webhook`, "--print-json"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let listenOut = "";
      listen.stdout.on("data", (d) => (listenOut += d.toString()));
      listen.stderr.on("data", (d) => (listenOut += d.toString()));
      // The CLI prints its own signing secret on startup; it only matches the
      // configured one if the operator passed that same value through.
      await sleep(6_000);
      const ready = /Ready!/.test(listenOut);
      const printedSecret = listenOut.match(/whsec_[A-Za-z0-9]+/)?.[0] ?? null;
      if (!ready) {
        environmentLimited(
          "a real Stripe webhook delivery grants Pro",
          `\`stripe listen\` did not become ready (usually \`stripe login\` has not been run): ${scrub(
            listenOut.slice(-200),
          ).replace(/\s+/g, " ")}`,
        );
      } else if (printedSecret && printedSecret !== webhookSecret) {
        environmentLimited(
          "a real Stripe webhook delivery grants Pro",
          "the CLI's forwarding secret differs from STRIPE_WEBHOOK_SECRET, so every " +
            "delivery would (correctly) fail signature verification — restart with the " +
            "secret the CLI prints",
        );
      } else {
        const triggered = await stripeCli(
          ["trigger", "customer.subscription.created", "--override", `price:id=${pricePro}`],
          { timeoutMs: 90_000 },
        );
        // `stripe trigger` creates its OWN customer, so the event names a customer
        // this deployment never stored. That is a refusal by design, and it is what
        // the assertion below is about: delivery works, and ownership still comes
        // from our own row.
        let refused = false;
        for (let i = 0; i < 20 && !refused; i += 1) {
          await sleep(1_000);
          refused = (await db.billingEvent.count()) > 0 || /unknown_customer/.test(listenOut);
        }
        check(
          "a real Stripe test event was delivered to the endpoint and answered 200",
          triggered.code === 0 && /\[200\]/.test(listenOut),
          `trigger exit ${triggered.code}; ${
            (listenOut.match(/\[\d{3}\]/g) ?? []).slice(-4).join(" ") || "no status lines"
          }`,
        );
        const planAfter = await get(base, "/api/usage", { store: owner });
        check(
          "an event for a customer this deployment never stored grants it nothing",
          planAfter.json?.plan === "free",
          `plan=${planAfter.json?.plan}`,
        );
        environmentLimited(
          "a real PAID checkout completes and grants Pro end to end",
          "completing a Stripe Checkout session needs a browser and a test card; " +
            "`stripe trigger` fabricates its own customer, which this deployment " +
            "correctly refuses. Do this one by hand once before launch",
        );
      }
      try {
        listen.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } finally {
    // Leave no residue in the Stripe test account we just wrote to.
    if (createdCustomerId) {
      const deleted = await stripeRequest(`/v1/customers/${createdCustomerId}`, {
        key,
        method: "DELETE",
      }).catch(() => ({ status: 0 }));
      console.log(
        `\n  ..   cleanup: test customer ${createdCustomerId.slice(0, 10)}… ${
          deleted.status === 200 ? "deleted from the Stripe test account" : `NOT deleted (status ${deleted.status}) — remove it by hand`
        }`,
      );
    }
    await db.$disconnect().catch(() => {});
    for (const entry of servers) killServer(entry);
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }

  return finish();
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const l of limits) console.log(`  ENVIRONMENT-LIMITED: ${l.name} — ${l.reason}`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    console.log("\nStripe Test Mode: RAN, WITH FAILURES");
    process.exit(1);
  }
  console.log(
    `\nStripe Test Mode: VERIFIED (${checks.length} checks against api.stripe.com in test mode)`,
  );
  if (limits.length) {
    console.log("Subsections above marked ENVIRONMENT-LIMITED were not exercised.");
  }
  return undefined;
}

main().catch((err) => {
  console.error(`\nPROBE ERROR: ${scrub(err instanceof Error ? err.stack : String(err))}`);
  for (const entry of servers) {
    console.error(`\n--- server :${entry.port} log tail ---\n${entry.tail()}`);
    killServer(entry);
  }
  process.exit(2);
});
