"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  NETWORK_ERROR_MESSAGE,
  type AuthStatus,
  type FieldErrors,
  type LoginField,
  fieldErrorId,
  hasErrors,
  isBusy,
  mapServerError,
  submitLabel,
  validateLoginForm,
} from "./authLogic";
import { FormAlert, PasswordField, SubmitButton, TextField } from "./PasswordField";
import { MAX_EMAIL_LENGTH } from "@/src/application/services/authValidation";

/**
 * Login form.
 *
 * Submits JSON to POST /api/auth/login — never a native form POST to the page,
 * which is what produced the original 405. `next` is forwarded so the server can
 * decide the (validated) destination; the client never trusts its own copy of it.
 */
export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<AuthStatus>("idle");

  const alertRef = useRef<HTMLDivElement>(null);
  // Guards against a double submit racing past the disabled attribute, and lets
  // an unmount abort the in-flight request.
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = isBusy(status);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (inFlight.current || isBusy(status)) return;

      setStatus("validating");
      const nextErrors = validateLoginForm({ email, password, rememberMe });
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
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Same-origin only; the route additionally verifies the Origin header.
          credentials: "same-origin",
          signal: controller.signal,
          body: JSON.stringify({ email, password, rememberMe, next }),
        });

        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          // Keep the email so the user does not retype it; clear the password.
          setPassword("");
          setFormError(mapServerError(response.status, body));
          setStatus("error");
          inFlight.current = false;
          return;
        }

        setStatus("redirecting");
        const destination =
          (body as { redirectTo?: string } | null)?.redirectTo ?? "/workspaces";
        // refresh() re-runs the server components so the authenticated shell is
        // rendered rather than a cached anonymous version.
        router.replace(destination);
        router.refresh();
      } catch (error) {
        if (controller.signal.aborted) return;
        setPassword("");
        setFormError(NETWORK_ERROR_MESSAGE);
        setStatus("error");
        inFlight.current = false;
        void error;
      }
    },
    [email, password, rememberMe, next, router, status],
  );

  // Move focus to the banner so the failure is announced and reachable.
  useEffect(() => {
    if (status === "error" && formError) alertRef.current?.focus();
  }, [status, formError]);

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
      <FormAlert id="login-form-error" message={formError} innerRef={alertRef} />

      <TextField
        name="email"
        label="Email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        autoFocus
        maxLength={MAX_EMAIL_LENGTH}
        placeholder="you@company.com"
        error={errors.email}
        errorId={fieldErrorId("login", "email")}
        disabled={busy}
      />

      <PasswordField
        name="password"
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        error={errors.password}
        errorId={fieldErrorId("login", "password")}
        disabled={busy}
      />

      <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-navy-soft">
        <input
          type="checkbox"
          name="rememberMe"
          checked={rememberMe}
          onChange={(event) => setRememberMe(event.target.checked)}
          disabled={busy}
          className="h-4 w-4 rounded border-softborder text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
        Keep me signed in for 30 days
      </label>

      <SubmitButton busy={busy}>{submitLabel(status, "Sign in", "Signing in…")}</SubmitButton>

      <p className="pt-1 text-center text-sm text-navy-soft">
        New to PDFDadi?{" "}
        <Link
          href={next ? `/register?returnTo=${encodeURIComponent(next)}` : "/register"}
          className="font-semibold text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}
