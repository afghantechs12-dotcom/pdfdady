import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { iconToneClasses } from "@/styles/tokens";
import type { ShortcutTool } from "./homeSections";

/**
 * The quick-tool strip directly below the hero.
 *
 * ## What used to be here
 *
 * A full-width white card wrapping a 200px-tall dropzone, plus six tall bordered
 * cards. Between the card's padding and the hero's own bottom padding it put
 * roughly a third of a viewport of near-empty space between the headline and the
 * first real content, which was the single largest contributor to the homepage
 * reading as sparse.
 *
 * The dropzone did not go away — it moved into the hero's copy column as
 * `HeroUpload variant="inline"`, keeping `useFileUpload`, the drop target, and
 * the `setHandoffFile` carry-through to a tool page. The hero is also where a
 * visitor looks for it.
 *
 * ## The strip
 *
 * One low bordered surface divided into six equal cells rather than six separate
 * cards: dividers instead of six borders, and a single `-mt-*` pull so the strip
 * overlaps the hero's lower edge and reads as attached to it, the way the
 * reference composition does.
 *
 * Entries are resolved from the tool registry on the server and already filtered
 * to runnable tools by `pickShortcutTools`. Nothing here can outlive the tool it
 * names: a slug that stops resolving, or a tool that stops being runnable, drops
 * out of the strip instead of rendering a dead link.
 */
export function QuickStart({ shortcuts }: { shortcuts: ShortcutTool[] }) {
  if (shortcuts.length === 0) return null;

  return (
    <section aria-labelledby="quick-start" className="relative z-30">
      <PageContainer maxWidth="wide">
        <h2 id="quick-start" className="sr-only">
          Start with a PDF tool
        </h2>

        <Reveal
          as="ul"
          // `gap-px` over a tinted background draws every divider — row and
          // column — without index arithmetic, and stays correct at each of the
          // three column counts. The cells paint white over it.
          className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-softborder bg-softborder shadow-card sm:grid-cols-3 lg:grid-cols-6"
        >
          {shortcuts.map((tool) => (
            <li key={tool.slug} className="bg-white">
              <Link
                href={tool.href}
                className="group flex h-full flex-col items-start gap-2 p-4 transition-colors duration-200 hover:bg-lavender/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 lg:px-4 lg:py-5"
              >
                <span
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 ${iconToneClasses[tool.iconTone]}`}
                >
                  <Icon name={tool.icon} size={19} aria-hidden="true" />
                </span>
                <span className="text-[0.9375rem] font-semibold leading-tight text-navy">
                  {tool.name}
                </span>
                <span className="text-xs leading-snug text-navy-soft">
                  {tool.tagline}
                </span>
              </Link>
            </li>
          ))}
        </Reveal>
      </PageContainer>
    </section>
  );
}
