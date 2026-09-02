import Link from "next/link";
import { ArrowRight, Info, Lightbulb, AlertTriangle } from "lucide-react";
import { getToolBySlug } from "@/data/tools";
import type { ContentBlock } from "@/data/blog";
import { cn } from "@/lib/utils/cn";

/**
 * Renders an article's typed ContentBlock[] with premium, on-brand typography.
 * No markdown parser and no @tailwindcss/typography dependency — bespoke styling
 * keeps the reading experience consistent with the rest of the site and lets us
 * render rich blocks (callouts, tool CTAs) that plain prose can't.
 */
export function ArticleBody({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="max-w-none">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "heading": {
      const Tag = block.level === 2 ? "h2" : "h3";
      return (
        <Tag
          id={block.id}
          className={cn(
            "scroll-mt-28 font-bold tracking-tight text-navy",
            block.level === 2
              ? "mt-12 text-2xl sm:text-[1.7rem]"
              : "mt-8 text-xl",
          )}
        >
          {block.text}
        </Tag>
      );
    }

    case "paragraph":
      return (
        <p className="mt-5 text-[1.0625rem] leading-8 text-navy-soft">
          {block.text}
        </p>
      );

    case "list":
      return block.ordered ? (
        <ol className="mt-5 list-decimal space-y-2.5 pl-6 text-[1.0625rem] leading-8 text-navy-soft marker:font-semibold marker:text-primary">
          {block.items.map((item, i) => (
            <li key={i} className="pl-1.5">
              {item}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-5 space-y-2.5 text-[1.0625rem] leading-8 text-navy-soft">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span
                aria-hidden
                className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );

    case "callout":
      return <Callout variant={block.variant} text={block.text} />;

    case "quote":
      return (
        <figure className="mt-8 border-l-4 border-primary bg-lavender/50 py-4 pl-5 pr-4">
          <blockquote className="text-lg font-medium italic leading-relaxed text-navy">
            “{block.text}”
          </blockquote>
          {block.cite && (
            <figcaption className="mt-2 text-sm text-navy-soft">
              — {block.cite}
            </figcaption>
          )}
        </figure>
      );

    case "toolCta":
      return <ToolCta toolSlug={block.toolSlug} label={block.label} />;

    default:
      return null;
  }
}

const calloutStyles = {
  info: {
    icon: Info,
    wrap: "border-blue-200 bg-blue-50",
    iconColor: "text-blue-600",
  },
  tip: {
    icon: Lightbulb,
    wrap: "border-primary/30 bg-primary-soft/60",
    iconColor: "text-primary",
  },
  warning: {
    icon: AlertTriangle,
    wrap: "border-amber-200 bg-amber-50",
    iconColor: "text-amber-600",
  },
} as const;

function Callout({
  variant,
  text,
}: {
  variant: "info" | "tip" | "warning";
  text: string;
}) {
  const { icon: Icon, wrap, iconColor } = calloutStyles[variant];
  const label = variant === "tip" ? "Tip" : variant === "warning" ? "Note" : "Good to know";
  return (
    <div className={cn("mt-8 flex gap-3 rounded-2xl border p-4 sm:p-5", wrap)}>
      <Icon size={20} className={cn("mt-0.5 shrink-0", iconColor)} />
      <div>
        <p className="text-sm font-semibold text-navy">{label}</p>
        <p className="mt-1 text-[0.95rem] leading-7 text-navy-soft">{text}</p>
      </div>
    </div>
  );
}

function ToolCta({ toolSlug, label }: { toolSlug: string; label?: string }) {
  const tool = getToolBySlug(toolSlug);
  if (!tool) return null;
  return (
    <Link
      href={tool.href}
      className="group mt-8 flex items-center justify-between gap-4 rounded-2xl border border-softborder bg-white p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-cardhover"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          Try it free
        </p>
        <p className="mt-1 font-semibold text-navy">
          {label ?? `Open the ${tool.name} tool`}
        </p>
        <p className="mt-0.5 text-sm text-navy-soft">{tool.description}</p>
      </div>
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition-transform group-hover:translate-x-0.5">
        <ArrowRight size={20} />
      </span>
    </Link>
  );
}
