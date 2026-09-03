"use client";

import { useState } from "react";
import { Send, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { contactSchema } from "@/lib/validation/fileSchemas";

type FieldErrors = Partial<Record<"name" | "email" | "message", string>>;

export function ContactForm() {
  const [values, setValues] = useState({ name: "", email: "", message: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = contactSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FieldErrors;
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    /*
     * There is no backend, so the panel below must not imply one. It used to say
     * "we've noted your message" under a green tick: a visitor sent to /contact by
     * the Pricing page's unavailable plans (`data/pricing.ts` points every one of
     * them here) would then wait for a reply nobody could send. Validation still
     * runs — an invalid address is still worth telling someone about before they
     * retype it into their mail client.
     */
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="rounded-card border border-softborder bg-white p-8 text-center shadow-card">
        <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-primary">
          <Mail size={30} />
        </span>
        <h2 className="mt-5 text-lg font-bold text-navy">This form isn&apos;t connected yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-navy-soft">
          Nothing was sent, and nobody has your message — there is no inbox
          behind this form yet. Email us instead at{" "}
          <a
            href="mailto:hello@pdfdadi.com"
            className="font-medium text-primary"
          >
            hello@pdfdadi.com
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-card border border-softborder bg-white p-6 shadow-card sm:p-8"
    >
      <Field
        label="Name"
        error={errors.name}
        htmlFor="name"
      >
        <input
          id="name"
          type="text"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>

      <Field label="Email" error={errors.email} htmlFor="email">
        <input
          id="email"
          type="email"
          value={values.email}
          onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
          className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>

      <Field label="Message" error={errors.message} htmlFor="message">
        <textarea
          id="message"
          rows={5}
          value={values.message}
          onChange={(e) =>
            setValues((v) => ({ ...v, message: e.target.value }))
          }
          className="w-full rounded-button border border-softborder bg-white px-3 py-2.5 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>

      <Button type="submit" fullWidth leadingIcon={<Send size={16} />}>
        Send message
      </Button>
      <p className="mt-3 text-center text-xs text-navy-soft">
        Support is coming soon. Messages aren&apos;t sent to a server yet.
      </p>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-sm font-medium text-navy"
      >
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
