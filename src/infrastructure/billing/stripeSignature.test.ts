import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BillingError } from "@/src/domain/billing/subscription";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  signStripePayload,
  stripeSignatureHeader,
  verifyStripeSignature,
} from "./stripeSignature";

const SECRET = "whsec_test_2b6f8a1c";
const BODY = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
const NOW = new Date("2026-08-25T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function expectInvalid(fn: () => void, note: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected rejection: ${note}`).toBeInstanceOf(BillingError);
  expect((thrown as BillingError).code).toBe("INVALID_SIGNATURE");
}

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body", () => {
    const header = stripeSignatureHeader(BODY, SECRET, NOW_S);
    expect(() => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW })).not.toThrow();
  });

  it("computes the signature over `${timestamp}.${body}` with HMAC-SHA256", () => {
    // Pinned against an independent computation, not against our own helper, so a
    // change to the scheme cannot be self-consistently wrong.
    const expected = createHmac("sha256", SECRET).update(`${NOW_S}.${BODY}`).digest("hex");
    expect(signStripePayload(BODY, SECRET, NOW_S)).toBe(expected);
    expect(stripeSignatureHeader(BODY, SECRET, NOW_S)).toBe(`t=${NOW_S},v1=${expected}`);
  });

  it("rejects a body altered after signing", () => {
    const header = stripeSignatureHeader(BODY, SECRET, NOW_S);
    const tampered = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", extra: 1 });
    expectInvalid(
      () => verifyStripeSignature({ rawBody: tampered, header, secret: SECRET, now: NOW }),
      "tampered body",
    );
  });

  it("rejects a signature made with a different secret", () => {
    const header = stripeSignatureHeader(BODY, "whsec_attacker", NOW_S);
    expectInvalid(
      () => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
      "wrong secret",
    );
  });

  it("rejects a missing or malformed header", () => {
    for (const header of [null, "", "sig=abc", "t=,v1=abc", `t=${NOW_S}`, `v1=${signStripePayload(BODY, SECRET, NOW_S)}`, "t=notanumber,v1=abc"]) {
      expectInvalid(
        () => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
        `header ${JSON.stringify(header)}`,
      );
    }
  });

  it("rejects everything when no webhook secret is configured", () => {
    const header = stripeSignatureHeader(BODY, SECRET, NOW_S);
    for (const secret of [null, ""]) {
      expectInvalid(
        () => verifyStripeSignature({ rawBody: BODY, header, secret, now: NOW }),
        `secret ${JSON.stringify(secret)}`,
      );
    }
  });

  it("rejects a replay outside the tolerance window", () => {
    const old = NOW_S - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1;
    const header = stripeSignatureHeader(BODY, SECRET, old);
    expectInvalid(
      () => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
      "stale timestamp",
    );
  });

  it("accepts a delivery at the edge of the tolerance window", () => {
    const edge = NOW_S - DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
    const header = stripeSignatureHeader(BODY, SECRET, edge);
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it("rejects a future-dated timestamp", () => {
    // The window is two-sided. A one-sided check would let a signature minted
    // with a far-future `t` stay valid for as long as its author chose.
    const future = NOW_S + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1;
    const header = stripeSignatureHeader(BODY, SECRET, future);
    expectInvalid(
      () => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
      "future timestamp",
    );
  });

  it("accepts a header carrying several v1 signatures, as sent during secret rotation", () => {
    const good = signStripePayload(BODY, SECRET, NOW_S);
    const header = `t=${NOW_S},v1=${signStripePayload(BODY, "whsec_old", NOW_S)},v1=${good}`;
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it("ignores v0 scheme signatures", () => {
    const header = `t=${NOW_S},v0=${signStripePayload(BODY, SECRET, NOW_S)}`;
    expectInvalid(
      () => verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
      "v0 only",
    );
  });

  it("rejects a truncated signature without leaking a length comparison", () => {
    const good = signStripePayload(BODY, SECRET, NOW_S);
    expectInvalid(
      () => verifyStripeSignature({ rawBody: BODY, header: `t=${NOW_S},v1=${good.slice(0, 32)}`, secret: SECRET, now: NOW }),
      "short signature",
    );
  });
});
