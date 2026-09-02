import { ArrowRight, FileText, Sparkles } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";

/**
 * The AI section — a preview of unbuilt work, and the target of a nav link.
 *
 * ## This section owns `id="ai-preview"`
 *
 * `data/nav.ts` points its "AI Assistant" item at `/#ai-preview`. Until this
 * component existed that anchor resolved to nothing: the header shipped a link
 * that scrolled nowhere. This is the target, so the id is load-bearing — do not
 * rename it without updating `navLinks`.
 *
 * ## Nothing here may look usable
 *
 * M8 has not started. There is no chat endpoint, no summarizer and no model
 * integration of any kind, and `data/tools.ts` marks all eight AI tools
 * `coming-soon-ai`, which `isComingLater` treats as not runnable.
 *
 * So this section deliberately has no input, no upload control and no button
 * that would appear to run something. The mock conversation is `aria-hidden`
 * decoration with a visible "Preview" label above it, and the one real control
 * links to `/tools#coming-later` — the catalog's "Coming later" section, where
 * each AI tool renders with its own badge and no executable affordance. It is
 * an anchor that exists (`ComingLaterSection`) rather than a filter query:
 * `/tools` keeps its category in local state and ignores `searchParams`, so
 * `?category=ai` would have silently landed on an unfiltered catalog.
 *
 * The reference design puts a working-looking "Try AI Assistant" CTA here;
 * shipping that against nothing is the exact misrepresentation
 * docs/launch-feature-evidence.md removed once already (C11).
 *
 * The prompt pills are styled as static tags rather than buttons for the same
 * reason — a pill that looks pressable but does nothing is worse than a label.
 *
 * ## Composition
 *
 * Three columns at desktop, roughly 28 / 20 / 52: copy, the document being read,
 * then the preview interface. The middle column is what makes the section read
 * as a product rather than two stacked cards — it gives the conversation
 * something to point at.
 *
 * ## Contrast
 *
 * The band fades to white at its foot, and a white preview panel with a hairline
 * grey border sitting on white had no edge left by the time it got there. Both
 * mocks now carry a violet-tinted border, an inset white rim and a two-part
 * shadow, and their interior surfaces went up a step (`lavender/40` → `/60`), so
 * the panel reads as a window over the page at every point in the gradient. The
 * document card gained the same treatment plus a real cast shadow: it is
 * explicitly one layer above the background and one layer below the conversation.
 */
export function AIPreview({ aiToolCount }: { aiToolCount: number }) {
  return (
    <section
      id="ai-preview"
      aria-labelledby="ai-preview-heading"
      className="section-pad relative isolate overflow-hidden"
    >
      {/* Soft tint so the section reads as a distinct band without a hard edge. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-b from-lavender/70 via-white to-white"
      />

      <PageContainer maxWidth="wide">
        <div className="grid items-center gap-8 lg:grid-cols-[0.56fr_0.4fr_1fr] lg:gap-8 xl:gap-10">
          {/* ── Copy ──────────────────────────────────────────────────────── */}
          <Reveal>
            {/*
              `text-pink-700`, not `text-aipink`: the brand pink is 3.13:1 against
              its own 10% tint, and "Coming soon" is the badge's whole point — 12px
              bold uppercase is not large text, so it owes 4.5:1 (WCAG 1.4.3). The
              deeper pink of the same family reads at 5.35:1 and needs no new token.
            */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-aipink/20 bg-aipink/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-pink-700">
              <Sparkles size={13} aria-hidden="true" />
              Coming soon
            </span>

            <h2
              id="ai-preview-heading"
              className="mt-3.5 text-[clamp(1.6rem,2.6vw,2.25rem)] font-bold leading-tight tracking-tight text-navy"
            >
              Ask your PDF anything.
            </h2>

            <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-navy-soft">
              We are building an assistant that reads a document and answers
              questions about it. It is not available yet — this is a preview of
              what {aiToolCount} planned AI tools will do, so you can see where
              PDFDadi is heading before it ships.
            </p>

            <ul className="mt-4 space-y-2">
              {[
                "Summarize long documents into their key points",
                "Explain dense or technical passages in plain words",
                "Translate a PDF while keeping its layout",
                "Pull tables and figures out into a spreadsheet",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2.5 text-sm leading-snug text-navy-soft"
                >
                  <span
                    aria-hidden="true"
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-aipink"
                  />
                  {item}
                </li>
              ))}
            </ul>

            <div className="mt-5">
              <Button
                href="/tools#coming-later"
                variant="outline"
                trailingIcon={<ArrowRight size={16} aria-hidden="true" />}
              >
                Explore planned AI tools
              </Button>
            </div>
          </Reveal>

          {/* ── The document being read ───────────────────────────────────── */}
          <Reveal delay={80} className="hidden lg:block">
            <AIDocumentCard />
          </Reveal>

          {/* ── Decorative mock ───────────────────────────────────────────── */}
          <Reveal delay={120}>
            <AIPreviewMock />
          </Reveal>
        </div>
      </PageContainer>
    </section>
  );
}

/**
 * The document the mock conversation is about.
 *
 * Decorative, like the conversation beside it. It exists so the preview has a
 * subject: a chat panel floating on its own reads as a chat product, and this is
 * a PDF product.
 */
function AIDocumentCard() {
  return (
    <div aria-hidden="true" className="relative select-none">
      <div className="rotate-[-3deg] rounded-[18px] border border-primary/12 bg-white p-3.5 shadow-[0_2px_4px_rgba(30,27,46,0.05),0_10px_20px_-8px_rgba(76,29,149,0.2),0_26px_56px_-20px_rgba(76,29,149,0.45)]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-red-500 text-white">
            <FileText size={14} strokeWidth={2.4} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-bold text-navy">
              Marketing_Proposal.pdf
            </span>
            <span className="block text-[9px] text-navy-soft">24 pages</span>
          </span>
        </div>

        <div className="mt-3 space-y-1.5 rounded-lg bg-lavender/60 p-2.5">
          <span className="block h-1.5 w-4/5 rounded-full bg-navy/15" />
          <span className="block h-1.5 w-full rounded-full bg-navy/10" />
          <span className="block h-1.5 w-11/12 rounded-full bg-navy/10" />
          <span className="block h-1.5 w-3/5 rounded-full bg-navy/10" />
          {/* A highlighted passage — what the assistant would be reading. */}
          <span className="mt-2 block h-1.5 w-full rounded-full bg-aipink/40" />
          <span className="block h-1.5 w-4/5 rounded-full bg-aipink/40" />
          <span className="mt-2 block h-1.5 w-full rounded-full bg-navy/10" />
          <span className="block h-1.5 w-2/3 rounded-full bg-navy/10" />
        </div>

        <div className="mt-3 space-y-1.5">
          <span className="block h-1.5 w-full rounded-full bg-navy/10" />
          <span className="block h-1.5 w-3/4 rounded-full bg-navy/10" />
        </div>
      </div>

      {/* A second page peeking out behind the first. */}
      <div className="absolute -bottom-2 -right-2 -z-10 h-full w-full rotate-[2deg] rounded-[18px] border border-softborder bg-white/70" />
    </div>
  );
}

/**
 * A still frame of a conversation that cannot happen yet.
 *
 * `aria-hidden` in full: it is an illustration of a planned feature, so exposing
 * its fake question-and-answer to a screen reader would read as a transcript of
 * something the product did. The surrounding copy carries the meaning.
 */
function AIPreviewMock() {
  return (
    <div aria-hidden="true" className="relative select-none">
      <div className="pointer-events-none absolute -inset-6 -z-10">
        <div className="animate-glow-pulse absolute right-8 top-4 h-56 w-56 rounded-full bg-aipink/20 blur-[80px]" />
        <div className="animate-glow-pulse absolute bottom-0 left-4 h-48 w-48 rounded-full bg-primary/20 blur-[70px] [animation-delay:2.5s]" />
      </div>

      <div className="rounded-card border border-primary/12 bg-white p-4 shadow-[0_2px_4px_rgba(30,27,46,0.05),0_14px_28px_-12px_rgba(76,29,149,0.22),0_34px_72px_-26px_rgba(76,29,149,0.5)] ring-1 ring-inset ring-white sm:p-5">
        {/* File chip */}
        <div className="flex items-center gap-3 rounded-xl border border-softborder bg-lavender/60 p-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500 text-[10px] font-bold text-white">
            PDF
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-navy">
              Marketing_Proposal.pdf
            </span>
            <span className="block text-xs text-navy-soft">
              12.4 MB &middot; 24 pages
            </span>
          </span>
        </div>

        {/* The asked question */}
        <div className="mt-4 flex justify-end">
          <span className="rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-xs font-medium text-white">
            Give me a summary of this document
          </span>
        </div>

        {/* The answer */}
        <div className="mt-3 flex gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-aipink/15 text-aipink">
            <Sparkles size={14} />
          </span>
          <div className="min-w-0 rounded-2xl rounded-tl-sm border border-softborder bg-lavender/50 p-3.5">
            <p className="text-xs font-semibold text-navy">
              Here is a summary of your PDF:
            </p>
            <ul className="mt-2 space-y-1.5">
              {[
                "Aims to increase brand awareness",
                "Includes market analysis and target audience",
                "Covers content, social and SEO strategy",
                "Budget estimated at $120,000 over six months",
              ].map((line) => (
                <li key={line} className="flex gap-1.5 text-[11px] leading-snug text-navy-soft">
                  <span className="text-aipink">&bull;</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/*
          Static tags, not buttons. See the section docblock: a pressable-looking
          control with nothing behind it is worse than a plain label.
        */}
        <ul className="mt-4 flex flex-wrap gap-2 border-t border-softborder pt-4">
          {["Summarize", "Explain", "Translate", "Extract data"].map((label) => (
            <li
              key={label}
              className="rounded-full border border-softborder bg-white px-3 py-1.5 text-[11px] font-semibold text-navy-soft"
            >
              {label}
            </li>
          ))}
        </ul>
      </div>

      {/* Corner label, so the mock is never mistaken for live UI. */}
      <span className="absolute -top-2.5 left-4 rounded-full bg-navy px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-card">
        Preview
      </span>
    </div>
  );
}
