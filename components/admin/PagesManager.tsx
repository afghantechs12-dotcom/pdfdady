"use client";

import { useState } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveButton,
  textareaClass,
} from "@/components/admin/SaveStatus";
import type { ContentBlock } from "@/data/blog";
import { useRouter } from "next/navigation";

export interface PageContent {
  title: string;
  description?: string;
  blocks: ContentBlock[];
}

export function PagesManager({
  initial,
}: {
  initial: Record<string, PageContent>;
}) {
  const router = useRouter();
  const [pages, setPages] = useState<Record<string, PageContent>>(initial);

  async function savePage(key: string, value: PageContent) {
    const res = await fetch(`/api/admin/pages/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (res.ok) router.refresh();
    return res.ok;
  }

  const pages_meta = [
    { key: "about", label: "About", description: "/about · static page" },
    { key: "contact", label: "Contact", description: "/contact · static page" },
    { key: "privacy", label: "Privacy Policy", description: "/privacy-policy · legal page" },
    { key: "terms", label: "Terms", description: "/terms · legal page" },
    { key: "pricing", label: "Pricing page intro", description: "Intro copy above the plan grid on /pricing" },
    { key: "serverStatus", label: "Server status intro", description: "Intro copy above the dependency list on /server-status" },
  ];

  return (
    <div className="space-y-6">
      {pages_meta.map((m) => (
        <PageEditor
          key={m.key}
          label={m.label}
          description={m.description}
          initial={pages[m.key] ?? { title: "", description: "", blocks: [] }}
          onSave={(value) => {
            setPages((prev) => ({ ...prev, [m.key]: value }));
            return savePage(m.key, value);
          }}
        />
      ))}
    </div>
  );
}

function PageEditor({
  label,
  description,
  initial,
  onSave,
}: {
  label: string;
  description: string;
  initial: PageContent;
  onSave: (value: PageContent) => Promise<boolean>;
}) {
  const [data, setData] = useState<PageContent>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error" | null>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const ok = await onSave(data);
      if (!ok) {
        setStatus("error");
        setError("Save failed");
        return;
      }
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setError("Network error");
      setStatus("error");
    }
  }

  return (
    <Card
      title={label}
      description={description}
      status={status ?? "idle"}
      errorMessage={error ?? undefined}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Title">
            <input
              className={inputClass()}
              value={data.title}
              onChange={(e) => setData({ ...data, title: e.target.value })}
            />
          </Field>
          <Field label="Description" hint="Used for meta description">
            <input
              className={inputClass()}
              value={data.description ?? ""}
              onChange={(e) => setData({ ...data, description: e.target.value })}
            />
          </Field>
        </div>
        <BlockListEditor
          blocks={data.blocks}
          onChange={(next) => setData({ ...data, blocks: next })}
        />
        <div className="flex justify-end">
          <SaveButton busy={status === "saving"} status={status ?? "idle"} />
        </div>
      </form>
    </Card>
  );
}

function BlockListEditor({
  blocks,
  onChange,
}: {
  blocks: ContentBlock[];
  onChange: (next: ContentBlock[]) => void;
}) {
  function update(i: number, patch: Partial<ContentBlock>) {
    const next = [...blocks];
    next[i] = { ...next[i], ...patch } as ContentBlock;
    onChange(next);
  }
  function add(b: ContentBlock) {
    onChange([...blocks, b]);
  }
  function remove(i: number) {
    onChange(blocks.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const next = [...blocks];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  return (
    <div>
      <ul className="space-y-3">
        {blocks.map((b, i) => (
          <li key={i} className="rounded-xl border border-softborder bg-white p-3">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                {b.type}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Move up"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  onClick={() => move(i, 1)}
                  disabled={i === blocks.length - 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() => remove(i)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <div className="mt-2">
              <PageBlockEditor block={b} onChange={(next) => update(i, next)} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-navy-soft">Add block:</span>
        {(
          [
            ["paragraph", "Paragraph"],
            ["heading", "Heading"],
            ["list", "List"],
            ["callout", "Callout"],
            ["quote", "Quote"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              if (k === "paragraph") add({ type: "paragraph", text: "" });
              else if (k === "heading")
                add({ type: "heading", level: 2, id: randomId("h"), text: "" });
              else if (k === "list") add({ type: "list", ordered: false, items: [""] });
              else if (k === "callout")
                add({ type: "callout", variant: "info", text: "" });
              else if (k === "quote") add({ type: "quote", text: "" });
            }}
            className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
          >
            <Plus size={12} /> {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function PageBlockEditor({
  block,
  onChange,
}: {
  block: ContentBlock;
  onChange: (next: Partial<ContentBlock>) => void;
}) {
  if (block.type === "paragraph" || block.type === "quote") {
    return (
      <div className="space-y-2">
        <textarea
          className={textareaClass() + " min-h-[80px]"}
          value={block.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        {block.type === "quote" && (
          <input
            className={inputClass()}
            placeholder="Citation (optional)"
            value={block.cite ?? ""}
            onChange={(e) => onChange({ cite: e.target.value })}
          />
        )}
      </div>
    );
  }
  if (block.type === "heading") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[80px_140px_1fr]">
        <select
          className={inputClass()}
          value={block.level}
          onChange={(e) =>
            onChange({ level: Number(e.target.value) as 2 | 3 })
          }
        >
          <option value={2}>H2</option>
          <option value={3}>H3</option>
        </select>
        <input
          className={inputClass()}
          placeholder="id"
          value={block.id}
          onChange={(e) =>
            onChange({ id: e.target.value.replace(/[^a-z0-9-]/g, "-") })
          }
        />
        <input
          className={inputClass()}
          placeholder="Heading"
          value={block.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
    );
  }
  if (block.type === "list") {
    return (
      <div>
        <label className="mb-2 inline-flex items-center gap-2 rounded-button border border-softborder bg-white px-2 py-1 text-xs font-semibold text-navy">
          <input
            type="checkbox"
            checked={block.ordered ?? false}
            onChange={(e) => onChange({ ordered: e.target.checked })}
          />
          Ordered
        </label>
        <ul className="space-y-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                className={inputClass()}
                value={it}
                onChange={(e) =>
                  onChange({
                    items: block.items.map((v, idx) =>
                      idx === i ? e.target.value : v,
                    ),
                  })
                }
              />
              <button
                type="button"
                onClick={() =>
                  onChange({
                    items: block.items.filter((_, idx) => idx !== i),
                  })
                }
                aria-label="Remove"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onChange({ items: [...block.items, ""] })}
          className="mt-2 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={12} /> Add item
        </button>
      </div>
    );
  }
  if (block.type === "callout") {
    return (
      <div className="space-y-2">
        <select
          className={inputClass() + " max-w-[200px]"}
          value={block.variant}
          onChange={(e) =>
            onChange({ variant: e.target.value as "info" | "tip" | "warning" })
          }
        >
          <option value="info">Info</option>
          <option value="tip">Tip</option>
          <option value="warning">Warning</option>
        </select>
        <textarea
          className={textareaClass() + " min-h-[80px]"}
          value={block.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
    );
  }
  return null;
}

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}
