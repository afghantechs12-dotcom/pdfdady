import {
  type FieldResult,
  validateEmail,
  validateExistingPassword,
  validateName,
  validateNewPassword,
  validatePasswordConfirmation,
} from "@/src/application/services/authValidation";

/**
 * Pure presentation logic for the auth forms.
 *
 * Everything here is a plain function over plain data — no React, no fetch — so
 * the rules that decide whether the submit button is enabled, what the button
 * says, and which server failure maps to which sentence can be unit-tested
 * without rendering a component or standing up a server.
 *
 * The field rules themselves are re-exported from the shared
 * `authValidation` module rather than reimplemented, so the client cannot
 * drift from what the API actually enforces.
 */

export type AuthStatus =
  | "idle"
  | "validating"
  | "submitting"
  | "success"
  | "redirecting"
  | "error";

export interface LoginFormValues {
  email: string;
  password: string;
  rememberMe: boolean;
}

export interface SignupFormValues {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type LoginField = "email" | "password";
export type SignupField = "name" | "email" | "password" | "confirmPassword" | "acceptedTerms";

function collect<K extends string>(entries: Array<[K, FieldResult]>): FieldErrors<K> {
  const errors: FieldErrors<K> = {};
  for (const [field, result] of entries) {
    if (!result.ok) errors[field] = result.message;
  }
  return errors;
}

export function validateLoginForm(values: LoginFormValues): FieldErrors<LoginField> {
  return collect<LoginField>([
    ["email", validateEmail(values.email)],
    // Existing-password rules only: the signup policy must not be applied to a
    // credential that already exists.
    ["password", validateExistingPassword(values.password)],
  ]);
}

export function validateSignupForm(values: SignupFormValues): FieldErrors<SignupField> {
  const errors = collect<SignupField>([
    ["name", validateName(values.name)],
    ["email", validateEmail(values.email)],
    ["password", validateNewPassword(values.password)],
    ["confirmPassword", validatePasswordConfirmation(values.password, values.confirmPassword)],
  ]);
  if (!values.acceptedTerms) {
    errors.acceptedTerms = "Accept the terms to continue.";
  }
  return errors;
}

export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * True while a request is in flight.
 *
 * `success` and `redirecting` count as busy: the navigation has not happened
 * yet, and re-enabling the button in that window invites a second submission.
 */
export function isBusy(status: AuthStatus): boolean {
  return status === "submitting" || status === "success" || status === "redirecting";
}

/** Submission is blocked while busy — validation errors surface on submit. */
export function canSubmit(status: AuthStatus): boolean {
  return !isBusy(status);
}

export function submitLabel(status: AuthStatus, idle: string, busy: string): string {
  return isBusy(status) ? busy : idle;
}

/** Server failure codes, mirroring `AuthErrorCode` on the API side. */
export interface ServerErrorShape {
  error?: { code?: string; message?: string };
}

const SERVER_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  EMAIL_TAKEN: "An account with this email already exists. Sign in instead.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  PAYLOAD_TOO_LARGE: "That request was too large. Shorten your details and try again.",
  CSRF_ORIGIN_REJECTED: "Your session could not be verified. Reload the page and try again.",
  CSRF_ORIGIN_REQUIRED: "Your session could not be verified. Reload the page and try again.",
  UNAUTHORIZED: "Your session has expired. Please sign in again.",
  PROVISIONING_FAILED: "We could not finish setting up your account. Please try again.",
  INVALID_JSON: "Something went wrong sending your details. Please try again.",
  INTERNAL_ERROR: "Something went wrong on our end. Please try again.",
};

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/**
 * Maps a server response onto copy that is safe to display.
 *
 * Only codes on the allow-list above produce a specific sentence. An unknown
 * code — or a raw server string, which could carry a stack trace, SQL fragment
 * or table name — collapses to the generic fallback. Validation messages
 * (INVALID_INPUT) are the deliberate exception: the API generates those from
 * the same validators the client uses, so they are known-safe and useful.
 */
export function mapServerError(status: number, body: unknown): string {
  const code = (body as ServerErrorShape | null)?.error?.code;
  if (typeof code === "string") {
    if (code === "INVALID_INPUT") {
      const message = (body as ServerErrorShape).error?.message;
      if (typeof message === "string" && message.length > 0 && message.length <= 200) {
        return message;
      }
      return FALLBACK_MESSAGE;
    }
    const mapped = SERVER_MESSAGES[code];
    if (mapped) return mapped;
  }
  if (status === 401) return SERVER_MESSAGES.INVALID_CREDENTIALS;
  if (status === 409) return SERVER_MESSAGES.EMAIL_TAKEN;
  if (status === 429) return SERVER_MESSAGES.RATE_LIMITED;
  return FALLBACK_MESSAGE;
}

/** Copy for a failed fetch (offline, DNS failure, aborted connection). */
export const NETWORK_ERROR_MESSAGE = "We could not reach the server. Check your connection and try again.";

/** Stable DOM ids so inputs and their messages can be wired with aria. */
export function fieldErrorId(form: string, field: string): string {
  return `${form}-${field}-error`;
}

export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return present.length > 0 ? present.join(" ") : undefined;
}

/** Password strength shown as guidance only — it never blocks submission. */
export interface PasswordRequirement {
  label: string;
  met: boolean;
}

export function passwordRequirements(password: string): PasswordRequirement[] {
  return [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "A lowercase and an uppercase letter", met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: "A number or symbol", met: /[^A-Za-z]/.test(password) },
  ];
}
