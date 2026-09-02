"use client";

import { useState } from "react";
import { BlogCard } from "./BlogCard";
import { cn } from "@/lib/utils/cn";
import type { BlogPost } from "@/data/blog";

/**
 * Client-side category filter + grid for the blog listing. Filtering happens in
 * the browser over the already-rendered post set (all posts are in the initial
 * HTML for SEO; the chips just hide/show).
 */
export function BlogGrid({
  posts,
  categories,
}: {
  posts: BlogPost[];
  categories: string[];
}) {
  const [active, setActive] = useState<string>("All");
  const filtered =
    active === "All" ? posts : posts.filter((p) => p.category === active);

  const chips = ["All", ...categories];

  return (
    <div>
      <div className="flex flex-wrap justify-center gap-2">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => setActive(chip)}
            aria-pressed={active === chip}
            className={cn(
              "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
              active === chip
                ? "border-primary bg-primary text-white"
                : "border-softborder bg-white text-navy-soft hover:border-primary/40 hover:text-primary",
            )}
          >
            {chip}
          </button>
        ))}
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </div>
  );
}
