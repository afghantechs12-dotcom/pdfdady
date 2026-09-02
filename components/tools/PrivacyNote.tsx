import { Cloud, ShieldCheck } from "lucide-react";
import {
  PROCESSING_MODE_COPY,
  type ProcessingMode,
} from "@/lib/tools/processingMode";
import { getLifecycleCopyForMode } from "@/lib/tools/capability";

interface PrivacyNoteProps {
  /**
   * Accepts the legacy "client"/"server" names as well as the canonical
   * processing modes, so existing tool pages keep working unchanged.
   */
  variant?: "client" | "server" | ProcessingMode;
}

const LEGACY_ALIASES: Record<string, ProcessingMode> = {
  client: "browser",
  server: "secure-cloud",
};

/**
 * The per-tool processing explanation shown above the upload control.
 *
 * The copy is no longer written here. It comes from
 * lib/tools/processingMode.ts, which derives it from the tool registry — the
 * rule being that what we tell a user about their file must be a function of
 * how the tool actually works, not of what a marketing string happens to say.
 *
 * The previous version hardcoded "Nothing is uploaded to a server and nothing
 * is stored" for every client tool and promised automatic deletion for server
 * tools. The first is scoped-wrong (true of the operation, not the product);
 * the second described a retention job that does not exist.
 *
 * ## Two claims, not one
 *
 * `copy.detail` answers "where does my file go" — a privacy claim. The lifecycle
 * sentence answers "what does waiting look like" — whether the work happens on
 * this device, or as a background job with progress and a cancel button. Those
 * were previously collapsed into "Secure cloud processing", which left a
 * visitor to guess whether the page would block or hand them a job to watch.
 */
export function PrivacyNote({ variant = "client" }: PrivacyNoteProps) {
  const mode: ProcessingMode = LEGACY_ALIASES[variant] ?? (variant as ProcessingMode);
  const copy = PROCESSING_MODE_COPY[mode] ?? PROCESSING_MODE_COPY.browser;
  const Icon = mode === "browser" ? ShieldCheck : Cloud;
  const lifecycle = getLifecycleCopyForMode(mode);

  return (
    <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-softborder bg-lavender/60 px-4 py-3 text-sm text-navy-soft">
      <Icon size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
      <p>
        <span className="font-semibold text-navy">{copy.label} processing.</span>{" "}
        {copy.detail}
        {lifecycle && <span className="mt-1.5 block">{lifecycle}</span>}
      </p>
    </div>
  );
}
