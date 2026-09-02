"use client";

import { cn } from "@/lib/utils/cn";

export function SectionHeader({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 lg:mb-8", className)}>
      {eyebrow && (
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          {eyebrow}
        </p>
      )}
      <h1 className="mt-1 text-2xl font-bold text-navy lg:text-3xl">{title}</h1>
      {description && (
        <p className="mt-2 max-w-3xl text-sm text-navy-soft lg:text-base">
          {description}
        </p>
      )}
    </div>
  );
}
