"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  NETWORK_ERROR_MESSAGE,
  type AuthStatus,
  type FieldErrors,
  type SignupField,
  fieldErrorId,
  hasErrors,
  isBusy,
  mapServerError,
  submitLabel,
  validateSignupForm,
} from "./authLogic";
import { FieldError, FormAlert, PasswordField, SubmitButton, TextField } from "./PasswordField";
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from "@/src/application/services/authValidation";

/**
 * Signup form.
 *
 * Posts to /api/auth/signup, which creates the user AND provisions their
 * Organization + default Workspace before returning, so the redirect that
 * follows always lands on a usable workspace rather than a 404.
 */
export function SignupForm({ next }: { next?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<SignupField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<AuthStatus>("idle");

  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = isBusy(status);
  const termsErrorId = fieldErrorId("signup", "acceptedTerms");

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (inFlight.current || isBusy(status)) return;

      setStatus("validating");
      const nextErrors = validateSignupForm({
        name,
        email,
        password,
        confirmPassword,
        acceptedTerms,
      });
      setErrors(nextErrors);
      if (hasErrors(nextErrors)) {
        setFormError(null);
        setStatus("idle");
        return;
      }

      inFlight.current = true;
      setFormError(null);
      setStatus("submitting");
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
          body: JSON.stringify({ name, email, password, confirmPassword, next }),
        });

        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          setPassword("");
          setConfirmPassword("");
          setFormError(mapServerError(response.status, body));
          setStatus("error");
          inFlight.current = false;
          return;
        }

        setStatus("redirecting");
        const destination =
          (body as { redirectTo?: string } | null)?.redirectTo ?? "/workspaces";
        router.replace(destination);
        router.refresh();
      } catch (error) {
        if (controller.signal.aborted) return;
        setPassword("");
        setConfirmPassword("");
        setFormError(NETWORK_ERROR_MESSAGE);
        setStatus("error");
        inFlight.current = false;
        void error;
      }
    },
    [name, email, password, confirmPassword, acceptedTerms, next, router, status],
  );

  useEffect(() => {
    if (status === "error" && formError) alertRef.current?.focus();
  }, [status, formError]);

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
      <FormAlert id="signup-form-error" message={formError} innerRef={alertRef} />

      <TextField
        name="name"
        label="Full name"
        value={name}
        onChange={setName}
        autoComplete="name"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        placeholder="Ada Lovelace"
        error={errors.name}
        errorId={fieldErrorId("signup", "name")}
        disabled={busy}
      />

      <TextField
        name="email"
        label="Work email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        maxLength={MAX_EMAIL_LENGTH}
        placeholder="you@company.com"
        error={errors.email}
        errorId={fieldErrorId("signup", "email")}
        disabled={busy}
      />

      <PasswordField
        name="password"
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        error={errors.password}
        errorId={fieldErrorId("signup", "password")}
        disabled={busy}
        showRequirements
      />

      <PasswordField
        name="confirmPassword"
        label="Confirm password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete="new-password"
        error={errors.confirmPassword}
        errorId={fieldErrorId("signup", "confirmPassword")}
        disabled={busy}
      />

      <div>
        <label className="flex cursor-pointer items-start gap-2.5 py-2 text-sm text-navy-soft">
          <input
            type="checkbox"
            name="acceptedTerms"
            checked={acceptedTerms}
            onChange={(event) => setAcceptedTerms(event.target.checked)}
            disabled={busy}
            aria-invalid={errors.acceptedTerms ? true : undefined}
            aria-describedby={errors.acceptedTerms ? termsErrorId : undefined}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-softborder text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" className="font-semibold text-primary underline-offset-2 hover:underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy" className="font-semibold text-primary underline-offset-2 hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        <FieldError id={termsErrorId} message={errors.acceptedTerms} />
      </div>

      <SubmitButton busy={busy}>
        {submitLabel(status, "Create account", "Setting up your workspace…")}
      </SubmitButton>

      <p className="pt-1 text-center text-sm text-navy-soft">
        Already have an account?{" "}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          className="font-semibold text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
