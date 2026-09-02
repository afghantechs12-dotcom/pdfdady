"use client";

import { useState } from "react";
import { Plus, Trash2, Save, ChevronUp, ChevronDown } from "lucide-react";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveButton,
} from "@/components/admin/SaveStatus";
import { useRouter } from "next/navigation";

export interface ListItem {
  id: string;
  title?: string;
  description?: string;
  icon?: string;
  name?: string;
}

export function SimpleListEditor({
  title,
  description,
  endpoint,
  collection,
  initial,
  titleKey,
}: {
  title: string;
  description: string;
  endpoint: string;
  /** Store collection key used to persist reordering via /api/admin/reorder. */
  collection: string;
  initial: ListItem[];
  /** Whether the API expects `name` (AI tools) or `title` (everything else). */
  titleKey?: "title" | "name";
}) {
  const router = useRouter();
  const [items, setItems] = useState<ListItem[]>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ListItem>({
    id: "",
    title: "",
    description: "",
    icon: "Sparkles",
    name: titleKey === "name" ? "" : undefined,
  });
  const fieldName = titleKey ?? "title";

  function readTitle(item: ListItem) {
    return fieldName === "name" ? item.name ?? "" : item.title ?? "";
  }
  function writeTitle(item: ListItem, v: string): ListItem {
    return fieldName === "name" ? { ...item, name: v } : { ...item, title: v };
  }

  async function save(item: ListItem) {
    if (!item.id || !item.icon || !item.description || !readTitle(item)) {
      setError("All fields are required");
      return;
    }
    setBusyId(item.id);
    setStatus("saving");
    setError(null);
    try {
      const body = {
        id: item.id,
        icon: item.icon,
        description: item.description,
        [fieldName]: readTitle(item),
      };
      const res = await fetch(`${endpoint}/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      setBusyId(null);
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this item?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`${endpoint}/${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((arr) => arr.filter((x) => x.id !== id));
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function persistOrder(next: ListItem[]) {
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection, order: next.map((x) => x.id) }),
      });
      setStatus(res.ok ? "saved" : "error");
      if (res.ok) router.refresh();
    } catch {
      setStatus("error");
    } finally {
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  function move(i: number, dir: -1 | 1) {
    const next = [...items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
    void persistOrder(next);
  }

  function addNew() {
    if (
      !draft.id ||
      !draft.icon ||
      !draft.description ||
      !readTitle(draft)
    ) {
      setError("All fields are required");
      return;
    }
    setItems((arr) => [...arr, { ...draft }]);
    save({ ...draft });
    setDraft({
      id: "",
      title: fieldName === "name" ? "" : "",
      name: fieldName === "name" ? "" : undefined,
      description: "",
      icon: "Sparkles",
    });
  }

  return (
    <div className="space-y-6">
      <Card
        title={title}
        description={description}
        status={status}
        errorMessage={error ?? undefined}
      >
        <ul className="space-y-3">
          {items.map((item, i) => (
            <li
              key={item.id}
              className="rounded-xl border border-softborder bg-white p-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_140px_1fr_72px]">
                <Field label="ID" hint="kebab-case">
                  <input
                    className={inputClass()}
                    value={item.id}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x, idx) =>
                          idx === i ? { ...x, id: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Icon" hint="Lucide icon name">
                  <input
                    className={inputClass()}
                    value={item.icon ?? ""}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x, idx) =>
                          idx === i ? { ...x, icon: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Title">
                  <input
                    className={inputClass()}
                    value={readTitle(item)}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x, idx) =>
                          idx === i ? writeTitle(x, e.target.value) : x,
                        ),
                      )
                    }
                  />
                </Field>
                <div className="flex items-end justify-end gap-1">
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
                    disabled={i === items.length - 1}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender disabled:opacity-40"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
                <Field label="Description" className="sm:col-span-4">
                  <textarea
                    className="min-h-[80px] resize-y rounded-button border border-softborder bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                    value={item.description ?? ""}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x, idx) =>
                          idx === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  disabled={busyId === item.id}
                  className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-1.5 text-xs font-semibold text-navy-soft hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={13} />
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => save(item)}
                  disabled={busyId === item.id}
                  className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  <Save size={13} />
                  Save
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Add new ${title.toLowerCase().replace(/s$/, "")}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_140px_1fr]">
          <Field label="ID">
            <input
              className={inputClass()}
              value={draft.id}
              placeholder="new-id"
              onChange={(e) =>
                setDraft({ ...draft, id: e.target.value.toLowerCase().trim() })
              }
            />
          </Field>
          <Field label="Icon">
            <input
              className={inputClass()}
              value={draft.icon ?? ""}
              onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputClass()}
              value={readTitle(draft)}
              onChange={(e) => setDraft(writeTitle(draft, e.target.value))}
            />
          </Field>
          <Field label="Description" className="sm:col-span-3">
            <textarea
              className="min-h-[80px] resize-y rounded-button border border-softborder bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={addNew}
            className="inline-flex items-center gap-1.5 rounded-button bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            <Plus size={14} />
            Add item
          </button>
        </div>
      </Card>

      <SaveButton status={status} busy={status === "saving"} />
    </div>
  );
}
