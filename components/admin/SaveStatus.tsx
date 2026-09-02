import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export function SaveStatus({
  status,
  errorMessage,
}: {
  status: "idle" | "saving" | "saved" | "error";
  errorMessage?: string;
}) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">
        <Loader2 size={13} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
        <CheckCircle2 size={13} />
        Saved
      </span>
    );
  }
  return (
    <span
      title={errorMessage}
      className="inline-flex max-w-[16rem] items-center gap-1.5 truncate rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700"
    >
      <AlertCircle size={13} />
      {errorMessage ?? "Error"}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="text-xs font-semibold text-navy">{label}</span>
      {hint && <p className="mb-1.5 text-[11px] text-navy-soft">{hint}</p>}
      {children}
      {error && (
        <span className="mt-1 block text-[11px] font-medium text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export function inputClass(extra?: string) {
  return cn(
    "w-full rounded-button border border-softborder bg-white px-3 py-2 text-sm text-navy placeholder:text-navy-soft/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
    extra,
  );
}

export function textareaClass() {
  return cn(
    "w-full rounded-button border border-softborder bg-white px-3 py-2 text-sm text-navy placeholder:text-navy-soft/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
    "min-h-[120px] resize-y",
  );
}

export const SaveButton = ({
  busy,
  label = "Save changes",
  savedLabel = "Saved",
  status,
}: {
  busy?: boolean;
  label?: string;
  savedLabel?: string;
  status?: "idle" | "saving" | "saved" | "error";
}) => (
  <button
    type="submit"
    disabled={busy}
    className={cn(
      "inline-flex items-center gap-2 rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-card transition-colors hover:bg-primary-hover disabled:opacity-60",
      status === "saved" && "bg-green-600 hover:bg-green-600",
    )}
  >
    {busy ? (
      <>
        <Loader2 size={15} className="animate-spin" />
        Saving…
      </>
    ) : status === "saved" ? (
      <>
        <CheckCircle2 size={15} />
        {savedLabel}
      </>
    ) : (
      label
    )}
  </button>
);
