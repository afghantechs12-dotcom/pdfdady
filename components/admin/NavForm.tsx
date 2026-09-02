"use client";

import { useState } from "react";
import { Plus, X, GripVertical, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/admin/Card";
import {
  inputClass,
  SaveButton,
} from "@/components/admin/SaveStatus";
import type { FooterColumn, NavLink } from "@/data/nav";
import { useRouter } from "next/navigation";

export function NavForm({
  initialLinks,
  initialFooter,
}: {
  initialLinks: NavLink[];
  initialFooter: FooterColumn[];
}) {
  const router = useRouter();
  const [links, setLinks] = useState<NavLink[]>(initialLinks);
  const [footer, setFooter] = useState<FooterColumn[]>(initialFooter);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links, footerColumns: footer }),
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

  function moveLink(i: number, dir: -1 | 1) {
    const next = [...links];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setLinks(next);
  }

  function moveCol(i: number, dir: -1 | 1) {
    const next = [...footer];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setFooter(next);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card
        title="Header navigation"
        description="Links that appear in the sitewide header. Drag-equivalent: use the up/down arrows to reorder."
        status={status}
        errorMessage={error ?? undefined}
      >
        <ul className="space-y-2">
          {links.map((link, i) => (
            <li
              key={`${link.href}-${i}`}
              className="rounded-xl border border-softborder bg-white p-3"
            >
              <div className="flex items-center gap-2">
                <GripVertical
                  size={14}
                  className="shrink-0 text-navy-soft/40"
                />
                <input
                  className={inputClass()}
                  placeholder="Label"
                  value={link.label}
                  onChange={(e) =>
                    setLinks((arr) =>
                      arr.map((x, idx) =>
                        idx === i ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
                <input
                  className={inputClass()}
                  placeholder="Href"
                  value={link.href}
                  onChange={(e) =>
                    setLinks((arr) =>
                      arr.map((x, idx) =>
                        idx === i ? { ...x, href: e.target.value } : x,
                      ),
                    )
                  }
                />
                <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-button border border-softborder bg-white px-2 py-1.5 text-xs font-semibold text-navy">
                  <input
                    type="checkbox"
                    checked={link.hasDropdown ?? false}
                    onChange={(e) =>
                      setLinks((arr) =>
                        arr.map((x, idx) =>
                          idx === i
                            ? { ...x, hasDropdown: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  Dropdown
                </label>
                <button
                  type="button"
                  aria-label="Move up"
                  onClick={() => moveLink(i, -1)}
                  disabled={i === 0}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  onClick={() => moveLink(i, 1)}
                  disabled={i === links.length - 1}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronDown size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() =>
                    setLinks((arr) => arr.filter((_, idx) => idx !== i))
                  }
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                >
                  <X size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            setLinks((arr) => [
              ...arr,
              { label: "New link", href: "/", hasDropdown: false },
            ])
          }
          className="mt-3 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-2 text-sm font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={14} />
          Add header link
        </button>
      </Card>

      <Card
        title="Footer columns"
        description="Columns shown in the sitewide footer. Each column has a title and a list of label/href pairs."
      >
        <ul className="space-y-4">
          {footer.map((col, i) => (
            <li
              key={`col-${i}`}
              className="rounded-xl border border-softborder bg-white p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  className={inputClass() + " font-semibold"}
                  placeholder="Column title"
                  value={col.title}
                  onChange={(e) =>
                    setFooter((arr) =>
                      arr.map((x, idx) =>
                        idx === i ? { ...x, title: e.target.value } : x,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  aria-label="Move column up"
                  onClick={() => moveCol(i, -1)}
                  disabled={i === 0}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Move column down"
                  onClick={() => moveCol(i, 1)}
                  disabled={i === footer.length - 1}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                >
                  <ChevronDown size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Remove column"
                  onClick={() =>
                    setFooter((arr) => arr.filter((_, idx) => idx !== i))
                  }
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                >
                  <X size={15} />
                </button>
              </div>
              <ul className="mt-2 space-y-2">
                {col.links.map((link, j) => (
                  <li key={`link-${i}-${j}`} className="flex items-center gap-2">
                    <input
                      className={inputClass()}
                      placeholder="Label"
                      value={link.label}
                      onChange={(e) =>
                        setFooter((arr) =>
                          arr.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  links: x.links.map((l, k) =>
                                    k === j ? { ...l, label: e.target.value } : l,
                                  ),
                                }
                              : x,
                          ),
                        )
                      }
                    />
                    <input
                      className={inputClass()}
                      placeholder="Href"
                      value={link.href}
                      onChange={(e) =>
                        setFooter((arr) =>
                          arr.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  links: x.links.map((l, k) =>
                                    k === j ? { ...l, href: e.target.value } : l,
                                  ),
                                }
                              : x,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label="Remove link"
                      onClick={() =>
                        setFooter((arr) =>
                          arr.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  links: x.links.filter(
                                    (_, k) => k !== j,
                                  ),
                                }
                              : x,
                          ),
                        )
                      }
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() =>
                  setFooter((arr) =>
                    arr.map((x, idx) =>
                      idx === i
                        ? { ...x, links: [...x.links, { label: "New link", href: "/" }] }
                        : x,
                    ),
                  )
                }
                className="mt-2 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
              >
                <Plus size={13} /> Add link
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            setFooter((arr) => [
              ...arr,
              { title: "New column", links: [{ label: "Link", href: "/" }] },
            ])
          }
          className="mt-3 inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-2 text-sm font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={14} />
          Add footer column
        </button>
      </Card>

      <div className="flex items-center justify-end">
        <SaveButton status={status} busy={status === "saving"} />
      </div>
    </form>
  );
}
