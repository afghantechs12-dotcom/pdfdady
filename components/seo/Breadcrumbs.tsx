import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { JsonLd } from "./JsonLd";
import { breadcrumbSchema, type BreadcrumbItem } from "@/lib/seo/jsonLd";
import { cn } from "@/lib/utils/cn";

interface BreadcrumbsProps {
  /** Ordered trail. "Home" (/) is prepended automatically. */
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * Accessible breadcrumb trail that ALSO emits BreadcrumbList JSON-LD, so Google
 * can show the breadcrumb in search results. The last item is the current page
 * (not a link).
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  const trail: BreadcrumbItem[] = [{ name: "Home", path: "/" }, ...items];

  return (
    <>
      <JsonLd data={breadcrumbSchema(trail)} />
      <nav aria-label="Breadcrumb" className={cn("w-full", className)}>
        <ol className="flex flex-wrap items-center gap-1.5 text-sm text-navy-soft">
          {trail.map((item, i) => {
            const isLast = i === trail.length - 1;
            return (
              <li key={item.path} className="flex items-center gap-1.5">
                {isLast ? (
                  <span aria-current="page" className="font-medium text-navy">
                    {item.name}
                  </span>
                ) : (
                  <Link
                    href={item.path}
                    className="transition-colors hover:text-primary"
                  >
                    {item.name}
                  </Link>
                )}
                {!isLast && (
                  <ChevronRight
                    size={14}
                    className="text-navy-soft/50"
                    aria-hidden
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
