"use client";

import { useState } from "react";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveButton,
} from "@/components/admin/SaveStatus";
import type { SeoSettings } from "@/data/admin";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";

export function SeoForm({ initial }: { initial: SeoSettings }) {
  const router = useRouter();
  const [data, setData] = useState<SeoSettings>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [exclDraft, setExclDraft] = useState("");
  const [disDraft, setDisDraft] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed to save");
        setStatus("error");
        return;
      }
      setStatus("saved");
      router.refresh();
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setError("Network error");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card
        title="SEO defaults"
        description="Used as fallbacks on blog and content pages."
        status={status}
        errorMessage={error ?? undefined}
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Default author name">
            <input
              className={inputClass()}
              value={data.defaultOgAuthor}
              onChange={(e) =>
                setData({ ...data, defaultOgAuthor: e.target.value })
              }
            />
          </Field>
          <Field label="Default article section">
            <input
              className={inputClass()}
              value={data.defaultArticleSection}
              onChange={(e) =>
                setData({ ...data, defaultArticleSection: e.target.value })
              }
            />
          </Field>
        </div>
      </Card>

      <Card
        title="Sitemap exclusions"
        description="Paths (with leading slash) removed from sitemap.xml even if a tool or page exists at them."
      >
        <ListEditor
          items={data.sitemapExcluded}
          draft={exclDraft}
          setDraft={setExclDraft}
          placeholder="/example/exclude"
          onAdd={(v) =>
            setData({ ...data, sitemapExcluded: [...data.sitemapExcluded, v] })
          }
          onRemove={(i) =>
            setData({
              ...data,
              sitemapExcluded: data.sitemapExcluded.filter((_, idx) => idx !== i),
            })
          }
        />
      </Card>

      <Card
        title="robots.txt disallow rules"
        description="Paths appended to robots.txt under the universal Allow / rule."
      >
        <ListEditor
          items={data.robotsDisallow}
          draft={disDraft}
          setDraft={setDisDraft}
          placeholder="/private/"
          onAdd={(v) =>
            setData({ ...data, robotsDisallow: [...data.robotsDisallow, v] })
          }
          onRemove={(i) =>
            setData({
              ...data,
              robotsDisallow: data.robotsDisallow.filter((_, idx) => idx !== i),
            })
          }
        />
      </Card>

      <div className="flex items-center justify-end">
        <SaveButton status={status} busy={status === "saving"} />
      </div>
    </form>
  );
}

function ListEditor({
  items,
  draft,
  setDraft,
  placeholder,
  onAdd,
  onRemove,
}: {
  items: string[];
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li
            key={`${item}-${i}`}
            className="flex items-center gap-2 rounded-xl border border-softborder bg-white px-3 py-2"
          >
            <code className="flex-1 truncate font-mono text-xs text-navy">
              {item}
            </code>
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label="Remove"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <input
          className={inputClass()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            onAdd(v);
            setDraft("");
          }}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={14} />
          Add
        </button>
      </div>
    </div>
  );
}
