import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The Stripe test-mode probe must never print a credential, including the ones
 * Stripe prints back at it.
 *
 * THE BUG THIS PINS. `scripts/stripe-testmode-probe.mjs` collects every secret it
 * knows into `secrets` and `scrub()` removes those exact strings from anything it
 * logs. That is not enough, because Stripe's own error bodies echo the offending
 * key already partly masked:
 *
 *   401 → {"error":{"message":"Invalid API Key provided: sk_test_***********0000"}}
 *
 * That string never equals the configured value, so the exact-match loop could not
 * see it, and five call sites interpolate `error.message` / `.text` straight into
 * `check()` details and print them. A real run of the probe printed the trailing
 * characters of the supplied key to the console. The fix scrubs by *pattern* too,
 * at `stripeRequest` — the one point every caller reads a Stripe response through.
 *
 * WHY SOURCE TEXT. The probe runs `main()` at module load and talks to
 * `api.stripe.com`, so it cannot be imported into this suite, and this suite must
 * not open sockets. What a Node test CAN do is read the shipped file, execute the
 * real redaction pattern out of it, and assert the response body is scrubbed
 * before any call site can reach it. The second test is behavioural, not textual:
 * it runs the actual regex literal, so weakening the pattern fails here even
 * though the source still contains the word `scrub`.
 */

const PROBE = ["scripts", "stripe-testmode-probe.mjs"];

/** Reads a repo file with comments removed, so matches are on real code only. */
function code(...segments: string[]): string {
  const src = readFileSync(path.join(process.cwd(), ...segments), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** The redaction pattern as it is actually written in the probe today. */
function redactor(): RegExp {
  const src = code(...PROBE);
  const literal = /out\.replace\(\/(.+?)\/g, "<redacted>"\)/.exec(src);
  expect(literal, "scrub() no longer redacts by pattern at all").not.toBeNull();
  return new RegExp(literal![1], "g");
}

describe("the Stripe probe scrubs credentials Stripe echoes back", () => {
  it("scrubs the response body at stripeRequest, before any call site reads it", () => {
    const src = code(...PROBE);
    // Scope to `stripeRequest`'s body. The local-HTTP helpers further down read
    // this deployment's own responses and are a different concern; asserting on the
    // whole file would pass or fail on them by accident.
    const start = src.indexOf("async function stripeRequest(");
    expect(start, "stripeRequest was renamed or removed").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    // `const text = await res.text()` hands every caller the raw bytes: the bug.
    expect(body).toMatch(/const text = scrub\(await res\.text\(\)\)/);
    expect(body).not.toMatch(/const text = await res\.text\(\)/);
    // JSON is parsed from the scrubbed text, so callers reading `json.error.message`
    // are covered by the same single scrub rather than each needing their own.
    expect(body).toMatch(/JSON\.parse\(text\)/);
  });

  it("redacts Stripe's masked-key echo, which never equals the configured value", () => {
    const masked = "Invalid API Key provided: sk_test_***********0000";
    const scrubbed = masked.replace(redactor(), "<redacted>");
    expect(scrubbed).toBe("Invalid API Key provided: <redacted>");
    // The trailing characters are the real ones — they must not survive.
    expect(scrubbed).not.toContain("0000");
  });

  it("redacts live, restricted and publishable key shapes and webhook secrets", () => {
    const re = redactor();
    for (const token of [
      "sk_live_51AbCdEfGhIjKlMnOp",
      "rk_test_51AbCdEfGhIjKlMnOp",
      "rk_live_***********beef",
      "pk_test_51AbCdEfGhIjKlMnOp",
      "whsec_AbCdEfGhIjKlMnOpQrSt",
    ]) {
      expect(`echo: ${token}`.replace(re, "<redacted>"), `${token} survived`).toBe(
        "echo: <redacted>",
      );
    }
  });

  it("leaves the deliberate prefix-class disclosure and ordinary Stripe ids alone", () => {
    const re = redactor();
    // The probe reports presence, prefix class and length on purpose; redacting
    // `price_…`/`cs_test_…`/`cus_…` would destroy the evidence the probe exists to
    // produce, and the bare `sk_test_` prefix is the documented disclosure.
    for (const keep of [
      "price_1AbCdEfGhIjKlMnOp",
      "cs_test_a1b2c3d4e5",
      "cus_AbCdEfGhIj",
      "sub_AbCdEfGhIj",
    ]) {
      expect(keep.replace(re, "<redacted>"), `${keep} was over-redacted`).toBe(keep);
    }
  });
});
