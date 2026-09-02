"use client";

import { useId, useState } from "react";
import { AlertCircle, Eye, EyeOff, Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { describedBy, passwordRequirements } from "./authLogic";

/**
 * Accessible field primitives for the auth forms.
 *
 * Every field has a real <label> (placeholders are never the only label), a
 * 16px minimum font size so iOS Safari does not zoom on focus, a visible focus
 * ring, and its error joined to the input via aria-describedby so screen
 * readers announce the message when focus lands on the field.
 */

const inputBase =
  "w-full rounded-button border bg-white px-3.5 py-2.5 text-base text-navy shadow-sm outline-none transition " +
  "placeholder:text-navy-soft/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary " +
  "disabled:cursor-not-allowed disabled:bg-lavender disabled:text-navy-soft";

function borderFor(hasError: boolean) {
  return hasError ? "border-red-400 focus-visible:ring-red-200" : "border-softborder";
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-sm text-red-600">
      <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

export interface TextFieldProps {
  name: string;
  label: string;
  type?: "text" | "email";
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  error?: string;
  errorId: string;
  disabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  placeholder?: string;
}

export function TextField({
  name,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  error,
  errorId,
  disabled,
  autoFocus,
  maxLength,
  placeholder,
}: TextFieldProps) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-semibold text-navy">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        // Autofocus is appropriate here: these are single-purpose auth pages
        // whose first field is the sole reason the page exists.
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error ? errorId : undefined)}
        className={cn("mt-1.5", inputBase, borderFor(Boolean(error)))}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export interface PasswordFieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  error?: string;
  errorId: string;
  disabled?: boolean;
  /** Renders the live requirement checklist (signup only). */
  showRequirements?: boolean;
  /** Optional trailing control rendered beside the label (e.g. a help link). */
  labelAccessory?: React.ReactNode;
}

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is a real <button type="button"> so Enter inside the field submits
 * the form rather than toggling visibility, and it carries aria-pressed plus an
 * aria-label that names the action for screen readers. The 44px hit area meets
 * the minimum touch target size.
 */
export function PasswordField({
  name,
  label,
  value,
  onChange,
  autoComplete,
  error,
  errorId,
  disabled,
  showRequirements,
  labelAccessory,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const requirementsId = useId();
  const requirements = showRequirements ? passwordRequirements(value) : [];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={name} className="block text-sm font-semibold text-navy">
          {label}
        </label>
        {labelAccessory}
      </div>
      <div className="relative mt-1.5">
        <input
          id={name}
          name={name}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          maxLength={128}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(
            error ? errorId : undefined,
            showRequirements ? requirementsId : undefined,
          )}
          className={cn(inputBase, "pr-12", borderFor(Boolean(error)))}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-controls={name}
          className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-button text-navy-soft transition hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed"
        >
          {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      <FieldError id={errorId} message={error} />
      {showRequirements && (
        <ul id={requirementsId} className="mt-2.5 space-y-1">
          {requirements.map((requirement) => (
            <li
              key={requirement.label}
              className={cn(
                "flex items-center gap-1.5 text-xs transition-colors motion-reduce:transition-none",
                requirement.met ? "text-success" : "text-navy-soft",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  requirement.met ? "border-success bg-success text-white" : "border-softborder",
                )}
              >
                {requirement.met && <Check size={11} strokeWidth={3} aria-hidden="true" />}
              </span>
              {requirement.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Server/network error banner.
 *
 * role="alert" + aria-live="assertive" so the message is announced immediately;
 * `tabIndex={-1}` lets the form move focus here after a failed submit, which is
 * what tells a keyboard or screen-reader user that something went wrong.
 */
export function FormAlert({
  id,
  message,
  innerRef,
}: {
  id: string;
  message: string | null;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div aria-live="assertive" role="alert">
      {message && (
        <div
          id={id}
          ref={innerRef}
          tabIndex={-1}
          className="mb-1 flex items-start gap-2.5 rounded-button border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
        >
          <AlertCircle size={17} className="mt-px shrink-0" aria-hidden="true" />
          <span>{message}</span>
        </div>
      )}
    </div>
  );
}

/** Primary submit button with a busy state and a spinner. */
export function SubmitButton({
  busy,
  children,
}: {
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      aria-busy={busy}
      className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-buttonlg bg-primary px-4 py-3 text-base font-semibold text-white shadow-[0_6px_20px_rgba(124,58,237,0.28)] transition hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none"
    >
      {busy && (
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none"
        />
      )}
      {children}
    </button>
  );
}
