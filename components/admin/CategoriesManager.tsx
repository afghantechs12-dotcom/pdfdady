"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Card } from "@/components/admin/Card";
import { Field, inputClass } from "@/components/admin/SaveStatus";
import { useRouter } from "next/navigation";

export function CategoriesManager({
  initial,
}: {
  initial: { id: string; label: string; tabLabel: string }[];
}) {
  const router = useRouter();
  const [cats, setCats] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(cat: { id: string; label: string; tabLabel: string }) {
    setBusyId(cat.id);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/admin/tool-categories/${cat.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cat),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed");
        setStatus("error");
        return;
      }
      setStatus("saved");
      router.refresh();
    } finally {
      setBusyId(null);
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  return (
    <Card
      title="Tool categories"
      description="Labels used by the catalog tabs and homepage sections."
      status={status}
      errorMessage={error ?? undefined}
    >
      <ul className="space-y-3">
        {cats.map((c) => (
          <li
            key={c.id}
            className="grid grid-cols-1 items-end gap-3 rounded-xl border border-softborder bg-white p-4 sm:grid-cols-[120px_1fr_1fr_auto]"
          >
            <div>
              <p className="text-xs font-semibold text-navy">ID</p>
              <code className="mt-1 inline-block font-mono text-xs text-navy-soft">
                {c.id}
              </code>
            </div>
            <Field label="Label">
              <input
                className={inputClass()}
                value={c.label}
                onChange={(e) =>
                  setCats((arr) =>
                    arr.map((x) =>
                      x.id === c.id ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <Field label="Tab label">
              <input
                className={inputClass()}
                value={c.tabLabel}
                onChange={(e) =>
                  setCats((arr) =>
                    arr.map((x) =>
                      x.id === c.id ? { ...x, tabLabel: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <button
              type="button"
              onClick={() => save(c)}
              disabled={busyId === c.id}
              className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
            >
              <Save size={13} /> Save
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
