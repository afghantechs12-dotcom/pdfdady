import { ShieldCheck } from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import type { BlogAuthor } from "@/data/blog";

/**
 * Author/E-E-A-T box shown at the end of an article. Reinforces who published
 * the content (matching the Article schema's author/publisher).
 */
export function AuthorBox({ author }: { author: BlogAuthor }) {
  return (
    <aside className="mt-12 rounded-card border border-softborder bg-lavender/40 p-6">
      <div className="flex items-start gap-4">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-white">
          <ShieldCheck size={24} />
        </span>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Written by
          </p>
          <p className="mt-0.5 text-lg font-bold text-navy">{author.name}</p>
          <p className="mt-2 text-sm leading-relaxed text-navy-soft">
            {author.bio}
          </p>
          <div className="mt-4">
            <Logo />
          </div>
        </div>
      </div>
    </aside>
  );
}
