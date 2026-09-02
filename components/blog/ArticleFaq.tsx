"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BlogFaqItem } from "@/data/blog";
import { cn } from "@/lib/utils/cn";

/**
 * Accessible FAQ accordion for an article. Mirrors the homepage FAQ pattern
 * (button-in-heading, aria-expanded/controls, region). The FAQ JSON-LD is
 * emitted separately on the page from the same data.
 */
export function ArticleFaq({ items }: { items: BlogFaqItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <section aria-labelledby="faq-heading" className="mt-16">
      <h2 id="faq-heading" className="text-2xl font-bold text-navy">
        Frequently asked questions
      </h2>
      <div className="mt-6 flex flex-col gap-3">
        {items.map((item, i) => {
          const isOpen = openIdx === i;
          return (
            <div
              key={i}
              className="overflow-hidden rounded-2xl border border-softborder bg-white shadow-card"
            >
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`article-faq-panel-${i}`}
                  id={`article-faq-button-${i}`}
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-[0.95rem] font-semibold text-navy"
                >
                  {item.question}
                  <ChevronDown
                    size={18}
                    className={cn(
                      "shrink-0 text-primary transition-transform duration-300",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
              </h3>
              <div
                id={`article-faq-panel-${i}`}
                role="region"
                aria-labelledby={`article-faq-button-${i}`}
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  isOpen
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <p className="px-5 pb-5 text-[0.95rem] leading-7 text-navy-soft">
                    {item.answer}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
