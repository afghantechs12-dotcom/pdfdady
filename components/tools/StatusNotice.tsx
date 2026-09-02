import { ArrowRight, Info, Wrench } from "lucide-react";
import Link from "next/link";

/**
 * The notices shown in place of a tool for work that is not built.
 *
 * Both previously read as product marketing: an AI-gradient panel, "Coming
 * Soon", and "We're building this now — check back soon", which commits to a
 * timeline nobody has set. They are now the same plain treatment as any other
 * unavailable tool, worded as "later" rather than "soon", and they say plainly
 * that there is nothing to try. Neither renders an upload control, a disabled
 * "Start" button, or any other affordance that implies the page could run.
 */
function UnavailableNotice({
  toolName,
  heading,
  body,
  reason,
}: {
  toolName: string;
  heading: string;
  body: string;
  reason?: string;
}) {
  return (
    <div className="rounded-card border border-softborder bg-lavender/40 p-8 text-center">
      <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-primary shadow-card">
        <Wrench size={24} aria-hidden="true" />
      </span>
      <h2 className="mt-5 text-xl font-bold text-navy">{heading}</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-navy-soft">
        {body}
      </p>

      {reason && (
        <div className="mx-auto mt-5 flex max-w-lg items-start gap-2.5 rounded-xl border border-softborder bg-white px-4 py-3 text-left text-sm leading-relaxed text-navy-soft">
          <Info size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
          <span>
            <span className="font-semibold text-navy">
              Why {toolName} is not live yet:{" "}
            </span>
            {reason}
          </span>
        </div>
      )}

      <Link
        href="/tools"
        className="group mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        See the tools that work today
        <ArrowRight
          size={16}
          aria-hidden="true"
          className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        />
      </Link>
    </div>
  );
}

export function AiComingSoonNotice({ toolName }: { toolName: string }) {
  return (
    <UnavailableNotice
      toolName={toolName}
      heading={`${toolName} is coming later`}
      body="AI document features are not part of PDFDadi yet. There is nothing to upload on this page and no date to announce — when it ships, it will appear alongside the other tools."
    />
  );
}

export function PlannedNotice({
  toolName,
  reason,
}: {
  toolName: string;
  reason: string;
}) {
  return (
    <UnavailableNotice
      toolName={toolName}
      heading={`${toolName} is coming later`}
      body="This tool is planned but not built. There is nothing to upload on this page."
      reason={reason}
    />
  );
}
