"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { cn } from "@/lib/utils/cn";
import type { FAQItem } from "@/data/faq";

/**
 * The homepage FAQ.
 *
 * Three accessibility fixes from an earlier pass are load-bearing and kept:
 *
 *  1. **Collapsed answers must leave the accessibility tree.** An earlier version
 *     animated `grid-rows-[0fr]` + `opacity-0`, which hides content visually but
 *     leaves it readable — a screen-reader user heard every answer at once.
 *     Closed panels carry `hidden`, so `aria-expanded` and reality agree.
 *  2. **A visible focus ring on the trigger**, since the whole row is the hit
 *     target.
 *  3. **Answers are server-supplied** and present in the initial HTML. This
 *     component is interactive only; it does not fetch.
 *
 * ## Two columns, but not a two-column grid
 *
 * The reference lays the questions out in two columns. A `grid-cols-2` would
 * couple the heights of side-by-side cells, so opening one item would stretch a
 * blank gap into its neighbour. Two independent flex columns avoid that, and DOM
 * order stays predictable for keyboard and screen-reader users: the whole first
 * column, then the whole second.
 *
 * Only one item is open at a time (`openId`), and the first starts open so the
 * section does not read as a wall of closed bars.
 *
 * ## The support panel is gone
 *
 * This section used to close on a "Still have a question?" card with Contact and
 * Browse-all-tools buttons. It was capped at `max-w-3xl` inside a 1360px section,
 * so it read as a narrow island bolted under a wide grid, and both of its links
 * already exist further down the page — Contact in the footer's Company column,
 * the tool catalog in the closing CTA. Nothing was lost but the duplication;
 * `/contact` itself is untouched.
 */
export function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [openId, setOpenId] = useState<string | null>(items[0]?.id ?? null);

  const split = Math.ceil(items.length / 2);
  const columns = [items.slice(0, split), items.slice(split)].filter(
    (col) => col.length > 0,
  );

  return (
    <section aria-labelledby="faq" className="section-pad bg-lavender/40">
      <PageContainer maxWidth="wide">
        <div className="text-center">
          <h2
            id="faq"
            className="text-[clamp(1.6rem,2.8vw,2.25rem)] font-bold tracking-tight text-navy"
          >
            Frequently asked questions
          </h2>
          <p className="mx-auto mt-2.5 max-w-xl text-[0.9375rem] text-navy-soft">
            Where files are processed, what an account gets you, and what is
            free.
          </p>
        </div>

        <div className="mt-7 grid items-start gap-2.5 lg:grid-cols-2 lg:gap-x-5 lg:gap-y-2.5">
          {columns.map((col, colIndex) => (
            <div key={colIndex} className="flex flex-col gap-2.5">
              {col.map((item) => {
                const isOpen = openId === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "overflow-hidden rounded-panel border bg-white transition-colors",
                      isOpen
                        ? "border-primary/30 shadow-card"
                        : "border-softborder",
                    )}
                  >
                    <h3>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`faq-panel-${item.id}`}
                        id={`faq-button-${item.id}`}
                        onClick={() => setOpenId(isOpen ? null : item.id)}
                        className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left text-sm font-semibold text-navy transition-colors hover:bg-lavender/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
                      >
                        {item.question}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
                            isOpen
                              ? "bg-primary text-white"
                              : "bg-primary-soft text-primary",
                          )}
                        >
                          <ChevronDown
                            size={16}
                            className={cn(
                              "transition-transform duration-200 motion-reduce:transition-none",
                              isOpen && "rotate-180",
                            )}
                          />
                        </span>
                      </button>
                    </h3>
                    {/*
                      `hidden` rather than a zero-height animation: a collapsed
                      answer must be absent from the accessibility tree, not just
                      invisible.
                    */}
                    <div
                      id={`faq-panel-${item.id}`}
                      role="region"
                      aria-labelledby={`faq-button-${item.id}`}
                      hidden={!isOpen}
                    >
                      <p className="border-t border-softborder px-5 py-3 text-[0.8125rem] leading-relaxed text-navy-soft">
                        {item.answer}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </PageContainer>
    </section>
  );
}
