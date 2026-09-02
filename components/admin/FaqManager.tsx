"use client";

import { useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveButton,
  textareaClass,
} from "@/components/admin/SaveStatus";
import type { FAQItem } from "@/data/faq";
import { useRouter } from "next/navigation";

export function FaqManager({ initial }: { initial: FAQItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState<FAQItem[]>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<FAQItem>({
    id: "",
    question: "",
    answer: "",
  });

  async function save(item: FAQItem) {
    setBusyId(item.id);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/admin/faq/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
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
    if (!confirm("Remove this FAQ item?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/faq/${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((arr) => arr.filter((x) => x.id !== id));
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  function addNew() {
    if (!draft.id.trim() || !draft.question.trim() || !draft.answer.trim()) {
      setError("ID, question and answer are required");
      return;
    }
    setItems((arr) => [...arr, { ...draft }]);
    save({ ...draft });
    setDraft({ id: "", question: "", answer: "" });
  }

  return (
    <div className="space-y-6">
      <Card title="FAQ items" description="Shown on the homepage and emitted as FAQ JSON-LD." status={status} errorMessage={error ?? undefined}>
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-softborder bg-white p-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
                <Field label="ID" hint="kebab-case, stable">
                  <input
                    className={inputClass()}
                    value={item.id}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x) =>
                          x.id === item.id ? { ...x, id: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Question">
                  <input
                    className={inputClass()}
                    value={item.question}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x) =>
                          x.id === item.id
                            ? { ...x, question: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Answer" className="sm:col-span-2">
                  <textarea
                    className={textareaClass() + " min-h-[80px]"}
                    value={item.answer}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x) =>
                          x.id === item.id
                            ? { ...x, answer: e.target.value }
                            : x,
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

      <Card title="Add a new FAQ item">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[180px_1fr]">
          <Field label="ID">
            <input
              className={inputClass()}
              placeholder="new-faq"
              value={draft.id}
              onChange={(e) =>
                setDraft({ ...draft, id: e.target.value.toLowerCase().trim() })
              }
            />
          </Field>
          <Field label="Question">
            <input
              className={inputClass()}
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              placeholder="What would you like to ask?"
            />
          </Field>
          <Field label="Answer" className="sm:col-span-2">
            <textarea
              className={textareaClass() + " min-h-[100px]"}
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
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
            Add FAQ item
          </button>
        </div>
      </Card>

      <SaveButton status={status} busy={status === "saving"} />
    </div>
  );
}
