import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface SectionHeadingProps {
  title: string;
  align?: "left" | "center";
  eyebrow?: string;
  description?: string;
  action?: { label: string; href: string };
  as?: "h1" | "h2";
  id?: string;
  className?: string;
}

export function SectionHeading({
  title,
  align = "center",
  eyebrow,
  description,
  action,
  as = "h2",
  id,
  className,
}: SectionHeadingProps) {
  const Heading = as;
  return (
    <div
      className={cn(
        "flex w-full gap-4",
        align === "center"
          ? "flex-col items-center text-center"
          : "flex-col items-start text-left sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className={cn(align === "center" && "mx-auto max-w-2xl")}>
        {eyebrow && (
          <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-primary">
            {eyebrow}
          </p>
        )}
        <Heading
          id={id}
          className={cn(
            "font-bold text-navy",
            as === "h1"
              ? "text-[clamp(2.5rem,5vw,4rem)] leading-tight"
              : "text-[clamp(1.75rem,3vw,2.5rem)]",
          )}
        >
          {title}
        </Heading>
        {description && (
          <p className="mt-3 text-base text-navy-soft sm:text-lg">
            {description}
          </p>
        )}
      </div>

      {action && (
        <Link
          href={action.href}
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary-hover"
        >
          {action.label}
          <ArrowRight
            size={16}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      )}
    </div>
  );
}
