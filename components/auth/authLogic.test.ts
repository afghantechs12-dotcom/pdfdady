import { describe, expect, it } from "vitest";
import {
  NETWORK_ERROR_MESSAGE,
  canSubmit,
  describedBy,
  fieldErrorId,
  hasErrors,
  isBusy,
  mapServerError,
  passwordRequirements,
  submitLabel,
  validateLoginForm,
  validateSignupForm,
} from "./authLogic";

const validLogin = { email: "ada@example.com", password: "password123", rememberMe: false };
const validSignup = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "password123",
  confirmPassword: "password123",
  acceptedTerms: true,
};

describe("validateLoginForm", () => {
  it("accepts a well-formed credential pair", () => {
    expect(validateLoginForm(validLogin)).toEqual({});
  });

  it("flags a missing or malformed email", () => {
    expect(validateLoginForm({ ...validLogin, email: "" }).email).toBeTruthy();
    expect(validateLoginForm({ ...validLogin, email: "nope" }).email).toBeTruthy();
  });

  it("flags a missing password", () => {
    expect(validateLoginForm({ ...validLogin, password: "" }).password).toBeTruthy();
  });

  it("does NOT apply the signup length policy to an existing password", () => {
    // A legacy password shorter than the current policy must still be
    // submittable — only the server may reject it.
    expect(validateLoginForm({ ...validLogin, password: "short" })).toEqual({});
  });
});

describe("validateSignupForm", () => {
  it("accepts a complete, consistent form", () => {
    expect(validateSignupForm(validSignup)).toEqual({});
  });

  it("requires a name", () => {
    expect(validateSignupForm({ ...validSignup, name: "   " }).name).toBeTruthy();
  });

  it("requires a valid email", () => {
    expect(validateSignupForm({ ...validSignup, email: "bad" }).email).toBeTruthy();
  });

  it("enforces the minimum password length", () => {
    const errors = validateSignupForm({
      ...validSignup,
      password: "short",
      confirmPassword: "short",
    });
    expect(errors.password).toMatch(/8 characters/);
  });

  it("detects a password mismatch", () => {
    const errors = validateSignupForm({ ...validSignup, confirmPassword: "different123" });
    expect(errors.confirmPassword).toBe("Passwords do not match.");
  });

  it("requires the terms checkbox", () => {
    expect(validateSignupForm({ ...validSignup, acceptedTerms: false }).acceptedTerms).toBeTruthy();
  });

  it("reports every invalid field at once, not just the first", () => {
    const errors = validateSignupForm({
      name: "",
      email: "bad",
      password: "x",
      confirmPassword: "y",
      acceptedTerms: false,
    });
    expect(Object.keys(errors).sort()).toEqual(
      ["acceptedTerms", "confirmPassword", "email", "name", "password"].sort(),
    );
  });
});

describe("hasErrors", () => {
  it("distinguishes an empty error map from a populated one", () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ email: "bad" })).toBe(true);
  });
});

describe("isBusy / canSubmit", () => {
  it("treats in-flight and post-success states as busy", () => {
    for (const status of ["submitting", "success", "redirecting"] as const) {
      expect(isBusy(status)).toBe(true);
      // Blocking submit while redirecting is what prevents a double submission.
      expect(canSubmit(status)).toBe(false);
    }
  });

  it("allows submission when idle, validating or after an error", () => {
    for (const status of ["idle", "validating", "error"] as const) {
      expect(isBusy(status)).toBe(false);
      expect(canSubmit(status)).toBe(true);
    }
  });
});

describe("submitLabel", () => {
  it("swaps to the busy label only while busy", () => {
    expect(submitLabel("idle", "Sign in", "Signing in…")).toBe("Sign in");
    expect(submitLabel("error", "Sign in", "Signing in…")).toBe("Sign in");
    expect(submitLabel("submitting", "Sign in", "Signing in…")).toBe("Signing in…");
    expect(submitLabel("redirecting", "Sign in", "Signing in…")).toBe("Signing in…");
  });
});

describe("mapServerError", () => {
  it("maps known codes to specific copy", () => {
    expect(mapServerError(401, { error: { code: "INVALID_CREDENTIALS" } })).toBe(
      "Email or password is incorrect.",
    );
    expect(mapServerError(409, { error: { code: "EMAIL_TAKEN" } })).toMatch(/already exists/);
    expect(mapServerError(429, { error: { code: "RATE_LIMITED" } })).toMatch(/Too many attempts/);
    expect(mapServerError(500, { error: { code: "PROVISIONING_FAILED" } })).toMatch(
      /could not finish setting up/,
    );
    expect(mapServerError(401, { error: { code: "UNAUTHORIZED" } })).toMatch(/session has expired/);
  });

  it("passes through server-generated validation messages", () => {
    expect(
      mapServerError(400, { error: { code: "INVALID_INPUT", message: "Enter your full name." } }),
    ).toBe("Enter your full name.");
  });

  it("hides a raw server error string that is not on the allow-list", () => {
    const leaky = {
      error: {
        code: "INTERNAL_ERROR",
        message: 'Invalid `prisma.user.create()` at users.email UNIQUE constraint failed',
      },
    };
    const shown = mapServerError(500, leaky);
    expect(shown).not.toMatch(/prisma/i);
    expect(shown).not.toMatch(/constraint/i);
    expect(shown).toBe("Something went wrong on our end. Please try again.");
  });

  it("hides an unknown error code entirely", () => {
    const shown = mapServerError(500, { error: { code: "PG_22001", message: "value too long for varchar" } });
    expect(shown).not.toMatch(/varchar/);
    expect(shown).toBe("Something went wrong. Please try again.");
  });

  it("rejects an over-long INVALID_INPUT message rather than rendering it", () => {
    const shown = mapServerError(400, {
      error: { code: "INVALID_INPUT", message: "x".repeat(500) },
    });
    expect(shown).toBe("Something went wrong. Please try again.");
  });

  it("falls back on status alone when the body carries no code", () => {
    expect(mapServerError(401, null)).toBe("Email or password is incorrect.");
    expect(mapServerError(409, {})).toMatch(/already exists/);
    expect(mapServerError(429, undefined)).toMatch(/Too many attempts/);
    expect(mapServerError(500, "a string body")).toBe("Something went wrong. Please try again.");
  });

  it("never returns an empty message", () => {
    for (const status of [400, 401, 403, 409, 413, 429, 500, 503]) {
      expect(mapServerError(status, null).length).toBeGreaterThan(0);
    }
  });
});

describe("NETWORK_ERROR_MESSAGE", () => {
  it("is actionable and leaks no internals", () => {
    expect(NETWORK_ERROR_MESSAGE).toMatch(/connection/i);
    expect(NETWORK_ERROR_MESSAGE).not.toMatch(/fetch|TypeError|ECONN/);
  });
});

describe("fieldErrorId / describedBy", () => {
  it("builds stable, unique ids per form and field", () => {
    expect(fieldErrorId("login", "email")).toBe("login-email-error");
    expect(fieldErrorId("signup", "email")).toBe("signup-email-error");
    expect(fieldErrorId("login", "email")).not.toBe(fieldErrorId("signup", "email"));
  });

  it("joins only the ids that are present", () => {
    expect(describedBy("a", "b")).toBe("a b");
    expect(describedBy("a", undefined, false, null, "")).toBe("a");
    expect(describedBy(undefined, false, null)).toBeUndefined();
  });
});

describe("passwordRequirements", () => {
  it("reports each requirement independently", () => {
    const empty = passwordRequirements("");
    expect(empty.every((requirement) => !requirement.met)).toBe(true);

    const strong = passwordRequirements("Password1!");
    expect(strong.every((requirement) => requirement.met)).toBe(true);
  });

  it("tracks the length requirement at the boundary", () => {
    expect(passwordRequirements("a".repeat(7))[0].met).toBe(false);
    expect(passwordRequirements("a".repeat(8))[0].met).toBe(true);
  });

  it("requires both letter cases for the second rule", () => {
    expect(passwordRequirements("alllowercase")[1].met).toBe(false);
    expect(passwordRequirements("ALLUPPERCASE")[1].met).toBe(false);
    expect(passwordRequirements("MixedCase")[1].met).toBe(true);
  });

  it("counts a number or a symbol for the third rule", () => {
    expect(passwordRequirements("OnlyLetters")[2].met).toBe(false);
    expect(passwordRequirements("Letters1")[2].met).toBe(true);
    expect(passwordRequirements("Letters!")[2].met).toBe(true);
  });

  it("is guidance only — a weak-but-valid password still passes the form", () => {
    // Requirements 2 and 3 are unmet, yet the form accepts it: the checklist
    // advises, it does not gate.
    const values = { ...validSignup, password: "abcdefgh", confirmPassword: "abcdefgh" };
    expect(passwordRequirements("abcdefgh").filter((r) => r.met)).toHaveLength(1);
    expect(validateSignupForm(values)).toEqual({});
  });
});
