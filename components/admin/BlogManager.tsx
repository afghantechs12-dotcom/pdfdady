"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Edit3, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/admin/Card";
import { Field, inputClass, SaveButton, textareaClass } from "@/components/admin/SaveStatus";
import type { BlogAuthor, BlogPost, ContentBlock, BlogFaqItem } from "@/data/blog";
import { useRouter } from "next/navigation";

const TONES = ["purple", "blue", "green", "orange", "pink", "teal", "red"] as const;

export function BlogManager({
  initial,
}: {
  initial: BlogPost[];
}) {
  const router = useRouter();
  const [posts, setPosts] = useState<BlogPost[]>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BlogPost | null>(null);
  const [creating, setCreating] = useState(false);

  function move(i: number, dir: -1 | 1) {
    const next = [...posts];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setPosts(next);
    void persistOrder(next);
  }

  async function persistOrder(next: BlogPost[]) {
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection: "blog", order: next.map((p) => p.slug) }),
      });
      setStatus(res.ok ? "saved" : "error");
      if (res.ok) router.refresh();
    } catch {
      setStatus("error");
    } finally {
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  async function remove(slug: string) {
    if (!confirm(`Delete "${slug}"?`)) return;
    try {
      const res = await fetch(`/api/admin/blog/${slug}`, { method: "DELETE" });
      if (res.ok) {
        setPosts((arr) => arr.filter((p) => p.slug !== slug));
        router.refresh();
      }
    } catch {
      setError("Network error");
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title={`Blog posts (${posts.length})`}
        description="Write SEO articles in the same typed block format the public blog uses. Each post drives its visible UI AND its JSON-LD."
        toolbar={
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-2 text-xs font-semibold text-white shadow-card hover:bg-primary-hover"
          >
            <Plus size={14} />
            New post
          </button>
        }
        status={status}
        errorMessage={error ?? undefined}
      >
        <ul className="space-y-2">
          {posts.map((p, i) => (
            <li
              key={p.slug}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-softborder bg-white px-3 py-3 hover:bg-lavender/40"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-navy">{p.title}</span>
                  {p.featured && (
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                      Featured
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-navy-soft">
                  <span>/{p.slug}</span>
                  <span aria-hidden>·</span>
                  <span>{p.category}</span>
                  <span aria-hidden>·</span>
                  <span>{p.readTime}</span>
                  <span aria-hidden>·</span>
                  <span>{p.datePublished}</span>
                </div>
              </div>
              <Link
                href={`/blog/${p.slug}`}
                target="_blank"
                className="hidden rounded-button border border-softborder bg-white px-2.5 py-1 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary sm:inline-flex"
              >
                View ↗
              </Link>
              <button
                type="button"
                aria-label="Move up"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                aria-label="Move down"
                onClick={() => move(i, 1)}
                disabled={i === posts.length - 1}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
              >
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(p);
                  setCreating(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
              >
                <Edit3 size={13} />
                Edit
              </button>
              <button
                type="button"
                onClick={() => remove(p.slug)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                aria-label="Delete"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {(editing || creating) && (
        <BlogEditor
          initial={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            setStatus("saved");
            router.refresh();
            setTimeout(() => setStatus("idle"), 1500);
          }}
          onStatus={setStatus}
          onError={setError}
        />
      )}
    </div>
  );
}

function BlogEditor({
  initial,
  onClose,
  onSaved,
  onStatus,
  onError,
}: {
  initial: BlogPost | null;
  onClose: () => void;
  onSaved: () => void;
  onStatus: (s: "idle" | "saving" | "saved" | "error") => void;
  onError: (e: string | null) => void;
}) {
  const isNew = !initial;
  const defaultAuthor = initial ? initial.author : undefined;
  const [data, setData] = useState<BlogPost>(
    initial ?? makeBlank(defaultAuthor),
  );
  const [busy, setBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [relatedDraft, setRelatedDraft] = useState("");

  function patch<K extends keyof BlogPost>(k: K, v: BlogPost[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  function patchAuthor<K extends keyof BlogAuthor>(k: K, v: BlogAuthor[K]) {
    setData((d) => ({ ...d, author: { ...d.author, [k]: v } }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onStatus("saving");
    onError(null);
    try {
      const res = await fetch(`/api/admin/blog/${data.slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        onError(j.error ?? "Failed");
        onStatus("error");
        return;
      }
      onSaved();
    } catch {
      onError("Network error");
      onStatus("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-softborder bg-white p-5 shadow-card sm:p-7">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-softborder pb-4">
        <div>
          <h2 className="text-lg font-bold text-navy">
            {isNew ? "New blog post" : `Edit "${initial?.slug}"`}
          </h2>
          <p className="text-sm text-navy-soft">
            The slug determines the public URL: /blog/{data.slug || "..."}.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary"
        >
          Close
        </button>
      </header>
      <form onSubmit={onSubmit} className="mt-5 space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Slug" hint="kebab-case" >
            <input
              className={inputClass()}
              required
              pattern="[a-z0-9-]+"
              disabled={!isNew}
              value={data.slug}
              onChange={(e) => patch("slug", e.target.value)}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputClass()}
              required
              value={data.title}
              onChange={(e) => patch("title", e.target.value)}
            />
          </Field>
          <Field label="Excerpt" className="sm:col-span-2">
            <textarea
              className={textareaClass() + " min-h-[80px]"}
              required
              value={data.excerpt}
              onChange={(e) => patch("excerpt", e.target.value)}
            />
          </Field>
          <Field label="Category">
            <input
              className={inputClass()}
              required
              value={data.category}
              onChange={(e) => patch("category", e.target.value)}
            />
          </Field>
          <Field label="Read time" hint="e.g. 5 min read">
            <input
              className={inputClass()}
              required
              value={data.readTime}
              onChange={(e) => patch("readTime", e.target.value)}
            />
          </Field>
          <Field label="Date published" hint="YYYY-MM-DD">
            <input
              className={inputClass()}
              required
              pattern="\d{4}-\d{2}-\d{2}"
              value={data.datePublished}
              onChange={(e) => patch("datePublished", e.target.value)}
            />
          </Field>
          <Field label="Date updated" hint="YYYY-MM-DD">
            <input
              className={inputClass()}
              required
              pattern="\d{4}-\d{2}-\d{2}"
              value={data.dateUpdated}
              onChange={(e) => patch("dateUpdated", e.target.value)}
            />
          </Field>
          <Field label="Hero icon" hint="Lucide icon name">
            <input
              className={inputClass()}
              required
              value={data.heroIcon}
              onChange={(e) => patch("heroIcon", e.target.value)}
            />
          </Field>
          <Field label="Hero tone">
            <select
              className={inputClass()}
              value={data.heroTone}
              onChange={(e) =>
                patch("heroTone", e.target.value as (typeof TONES)[number])
              }
            >
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Related tool slug" hint="Optional · e.g. merge-pdf">
            <input
              className={inputClass()}
              value={data.relatedToolSlug ?? ""}
              onChange={(e) => patch("relatedToolSlug", e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
            <input
              type="checkbox"
              checked={data.featured ?? false}
              onChange={(e) => patch("featured", e.target.checked)}
            />
            Featured post
          </label>

          <Field label="Tags" className="sm:col-span-2">
            <ul className="mb-2 flex flex-wrap gap-2">
              {data.tags.map((t) => (
                <li
                  key={t}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() =>
                      patch(
                        "tags",
                        data.tags.filter((x) => x !== t),
                      )
                    }
                    aria-label={`Remove tag ${t}`}
                    className="hover:text-primary-hover"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <input
                className={inputClass()}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="merge pdf"
              />
              <button
                type="button"
                onClick={() => {
                  const v = tagDraft.trim().toLowerCase();
                  if (!v || data.tags.includes(v)) return;
                  patch("tags", [...data.tags, v]);
                  setTagDraft("");
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
              >
                <Plus size={13} /> Add tag
              </button>
            </div>
          </Field>

          <Field label="Related slugs" hint="Comma-separated post slugs" className="sm:col-span-2">
            <div className="flex items-center gap-2">
              <input
                className={inputClass()}
                value={relatedDraft}
                onChange={(e) => setRelatedDraft(e.target.value)}
                placeholder="compress-pdf-online, jpg-to-pdf-guide"
              />
              <button
                type="button"
                onClick={() => {
                  const v = relatedDraft
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  patch("relatedSlugs", v);
                  setRelatedDraft("");
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
              >
                Set related
              </button>
            </div>
            {data.relatedSlugs?.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {data.relatedSlugs.map((s) => (
                  <li
                    key={s}
                    className="rounded-full bg-lavender px-2.5 py-1 text-xs font-mono text-navy"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            ) : null}
          </Field>

          <Field label="Author" className="sm:col-span-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                className={inputClass()}
                placeholder="Name"
                value={data.author.name}
                onChange={(e) => patchAuthor("name", e.target.value)}
              />
              <input
                className={inputClass()}
                placeholder="URL"
                value={data.author.url}
                onChange={(e) => patchAuthor("url", e.target.value)}
              />
              <input
                className={inputClass()}
                placeholder="Bio"
                value={data.author.bio}
                onChange={(e) => patchAuthor("bio", e.target.value)}
              />
            </div>
          </Field>
        </div>

        <BodyEditor
          blocks={data.body}
          onChange={(next) => patch("body", next)}
        />

        <HowToEditor
          howTo={data.howTo}
          onChange={(next) => patch("howTo", next)}
        />

        <FaqEditor
          items={data.faq ?? []}
          onChange={(next) => patch("faq", next)}
        />

        <div className="flex items-center justify-end gap-2 border-t border-softborder pt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary"
          >
            Cancel
          </button>
          <SaveButton busy={busy} status="idle" />
        </div>
      </form>
    </section>
  );
}

function makeBlank(author?: BlogAuthor): BlogPost {
  return {
    slug: "",
    title: "",
    excerpt: "",
    category: "Guides",
    tags: [],
    author: author ?? {
      name: "PDFDadi Team",
      url: "/about",
      bio: "",
    },
    datePublished: new Date().toISOString().slice(0, 10),
    dateUpdated: new Date().toISOString().slice(0, 10),
    readTime: "5 min read",
    featured: false,
    heroIcon: "Sparkles",
    heroTone: "purple",
    body: [{ type: "paragraph", text: "" }],
    faq: [],
    relatedSlugs: [],
  };
}

function BodyEditor({
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
    <Card title="Body" description="Compose the article using typed blocks. Drag-equivalent: use arrows to reorder.">
      <ul className="space-y-3">
        {blocks.map((b, i) => (
          <li
            key={i}
            className="rounded-xl border border-softborder bg-white p-3"
          >
            <div className="flex items-center justify-between gap-2">
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
              <BlockEditor block={b} onChange={(next) => update(i, next)} />
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
            ["toolCta", "Tool CTA"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              if (k === "paragraph") add({ type: "paragraph", text: "" });
              else if (k === "heading")
                add({ type: "heading", level: 2, id: slugId("h"), text: "" });
              else if (k === "list")
                add({ type: "list", ordered: false, items: [""] });
              else if (k === "callout")
                add({ type: "callout", variant: "tip", text: "" });
              else if (k === "quote") add({ type: "quote", text: "" });
              else if (k === "toolCta") add({ type: "toolCta", toolSlug: "merge-pdf" });
            }}
            className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
          >
            <Plus size={12} /> {label}
          </button>
        ))}
      </div>
    </Card>
  );
}

function BlockEditor({
  block,
  onChange,
}: {
  block: ContentBlock;
  onChange: (next: Partial<ContentBlock>) => void;
}) {
  if (block.type === "paragraph") {
    return (
      <textarea
        className={textareaClass() + " min-h-[80px]"}
        value={block.text}
        onChange={(e) => onChange({ text: e.target.value })}
      />
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
          placeholder="id-slug"
          value={block.id}
          onChange={(e) =>
            onChange({ id: e.target.value.replace(/[^a-z0-9-]/g, "-") })
          }
        />
        <input
          className={inputClass()}
          placeholder="Heading text"
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
          Ordered list
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
                aria-label="Remove item"
                onClick={() =>
                  onChange({
                    items: block.items.filter((_, idx) => idx !== i),
                  })
                }
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
          <Plus size={12} />
          Add item
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
  if (block.type === "quote") {
    return (
      <div className="space-y-2">
        <textarea
          className={textareaClass() + " min-h-[80px]"}
          value={block.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <input
          className={inputClass()}
          placeholder="Cite (optional)"
          value={block.cite ?? ""}
          onChange={(e) => onChange({ cite: e.target.value })}
        />
      </div>
    );
  }
  if (block.type === "toolCta") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr]">
        <input
          className={inputClass()}
          placeholder="tool-slug"
          value={block.toolSlug}
          onChange={(e) => onChange({ toolSlug: e.target.value })}
        />
        <input
          className={inputClass()}
          placeholder="Optional label"
          value={block.label ?? ""}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>
    );
  }
  return null;
}

function HowToEditor({
  howTo,
  onChange,
}: {
  howTo: BlogPost["howTo"];
  onChange: (next: BlogPost["howTo"]) => void;
}) {
  if (!howTo) {
    return (
      <Card
        title="HowTo (optional)"
        description="A step-by-step section eligible for Google's HowTo rich result."
        toolbar={
          <button
            type="button"
            onClick={() =>
              onChange({ name: "How to …", description: "", steps: [] })
            }
            className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
          >
            <Plus size={13} /> Enable
          </button>
        }
      >
        <p className="text-sm text-navy-soft">Not enabled.</p>
      </Card>
    );
  }
  return (
    <Card
      title="HowTo steps"
      description="Drives the visible numbered steps and the HowTo JSON-LD."
      toolbar={
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="inline-flex items-center gap-1.5 rounded-button border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
        >
          <Trash2 size={13} /> Disable
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass()}
            value={howTo.name}
            onChange={(e) => onChange({ ...howTo, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <input
            className={inputClass()}
            value={howTo.description}
            onChange={(e) => onChange({ ...howTo, description: e.target.value })}
          />
        </Field>
      </div>
      <ul className="mt-4 space-y-2">
        {howTo.steps.map((s, i) => (
          <li
            key={i}
            className="grid grid-cols-1 items-start gap-2 rounded-xl border border-softborder bg-white p-3 sm:grid-cols-[40px_1fr_1fr_auto]"
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
              {i + 1}
            </span>
            <input
              className={inputClass()}
              placeholder="Step name"
              value={s.name}
              onChange={(e) => {
                const next = [...howTo.steps];
                next[i] = { ...next[i], name: e.target.value };
                onChange({ ...howTo, steps: next });
              }}
            />
            <textarea
              className={textareaClass() + " min-h-[60px]"}
              placeholder="Step description"
              value={s.text}
              onChange={(e) => {
                const next = [...howTo.steps];
                next[i] = { ...next[i], text: e.target.value };
                onChange({ ...howTo, steps: next });
              }}
            />
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...howTo,
                  steps: howTo.steps.filter((_, idx) => idx !== i),
                })
              }
              aria-label="Remove step"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          onChange({
            ...howTo,
            steps: [...howTo.steps, { name: "", text: "" }],
          })
        }
        className="mt-3 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
      >
        <Plus size={13} />
        Add step
      </button>
    </Card>
  );
}

function FaqEditor({
  items,
  onChange,
}: {
  items: BlogFaqItem[];
  onChange: (next: BlogFaqItem[]) => void;
}) {
  return (
    <Card title="Article FAQ (optional)" description="Drives the footer FAQ and FAQPage JSON-LD on the post.">
      <ul className="space-y-3">
        {items.map((it, i) => (
          <li key={i} className="rounded-xl border border-softborder bg-white p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Field label="Question">
                <input
                  className={inputClass()}
                  value={it.question}
                  onChange={(e) => {
                    const next = [...items];
                    next[i] = { ...next[i], question: e.target.value };
                    onChange(next);
                  }}
                />
              </Field>
              <button
                type="button"
                onClick={() =>
                  onChange(items.filter((_, idx) => idx !== i))
                }
                className="mt-6 inline-flex h-10 items-center justify-center rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-red-600 hover:bg-red-50"
                aria-label="Remove FAQ item"
              >
                <Trash2 size={13} />
              </button>
              <Field label="Answer" className="sm:col-span-2">
                <textarea
                  className={textareaClass() + " min-h-[60px]"}
                  value={it.answer}
                  onChange={(e) => {
                    const next = [...items];
                    next[i] = { ...next[i], answer: e.target.value };
                    onChange(next);
                  }}
                />
              </Field>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...items, { question: "", answer: "" }])}
        className="mt-3 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
      >
        <Plus size={13} />
        Add FAQ item
      </button>
    </Card>
  );
}

function slugId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

export function BlogAuthorForm({ initial }: { initial: BlogAuthor }) {
  const router = useRouter();
  const [data, setData] = useState<BlogAuthor>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/blog/author", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed");
        setStatus("error");
        return;
      }
      setStatus("saved");
      router.refresh();
    } catch {
      setError("Network error");
      setStatus("error");
    } finally {
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Card
        title="Default author / publisher"
        description="Used for new posts unless overridden at the post level."
        status={status}
        errorMessage={error ?? undefined}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_200px_1fr]">
          <Field label="Name">
            <input
              className={inputClass()}
              value={data.name}
              onChange={(e) => setData({ ...data, name: e.target.value })}
            />
          </Field>
          <Field label="URL">
            <input
              className={inputClass()}
              value={data.url}
              onChange={(e) => setData({ ...data, url: e.target.value })}
            />
          </Field>
          <Field label="Bio">
            <input
              className={inputClass()}
              value={data.bio}
              onChange={(e) => setData({ ...data, bio: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <SaveButton busy={status === "saving"} status={status} />
        </div>
      </Card>
    </form>
  );
}
