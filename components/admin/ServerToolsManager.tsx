"use client";

import { useState } from "react";
import { Plus, X, Save, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/admin/Card";
import { Field, inputClass, textareaClass } from "@/components/admin/SaveStatus";
import type { ServerToolConfig, OptionField } from "@/data/serverToolConfig";
import { useRouter } from "next/navigation";

const MB = 1024 * 1024;

export interface ServerToolEntry {
  slug: string;
  name: string;
  config: ServerToolConfig;
}

export function ServerToolsManager({ initial }: { initial: ServerToolEntry[] }) {
  return (
    <div className="space-y-6">
      {initial.map((entry) => (
        <ServerToolCard key={entry.slug} entry={entry} />
      ))}
      {initial.length === 0 && (
        <Card title="No server tools">
          <p className="text-sm text-navy-soft">
            No server-processed tools are configured in this build.
          </p>
        </Card>
      )}
    </div>
  );
}

function ServerToolCard({ entry }: { entry: ServerToolEntry }) {
  const router = useRouter();
  const [config, setConfig] = useState<ServerToolConfig>(entry.config);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch<K extends keyof ServerToolConfig>(k: K, v: ServerToolConfig[K]) {
    setConfig((c) => ({ ...c, [k]: v }));
  }

  async function save() {
    setBusy(true);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/admin/server-tools/${entry.slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed to save");
        setStatus("error");
        return;
      }
      setStatus("saved");
      router.refresh();
    } catch {
      setError("Network error");
      setStatus("error");
    } finally {
      setBusy(false);
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  async function reset() {
    if (!confirm(`Reset "${entry.name}" server settings to defaults?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/server-tools/${entry.slug}`, {
        method: "DELETE",
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={entry.name}
      description={`/tools/${entry.slug} · server-processed`}
      status={status}
      errorMessage={error ?? undefined}
      toolbar={
        <Link
          href={`/tools/${entry.slug}`}
          target="_blank"
          className="inline-flex rounded-button border border-softborder bg-white px-2.5 py-1 text-xs font-semibold text-navy-soft hover:border-primary hover:text-primary"
        >
          View ↗
        </Link>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Max upload size (MB)">
          <input
            type="number"
            min={1}
            className={inputClass()}
            value={Math.round(config.maxSizeBytes / MB)}
            onChange={(e) =>
              patch("maxSizeBytes", Math.max(1, Number(e.target.value) || 1) * MB)
            }
          />
        </Field>
        <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
          <input
            type="checkbox"
            checked={config.showSizeComparison ?? false}
            onChange={(e) => patch("showSizeComparison", e.target.checked)}
          />
          Show before/after size comparison
        </label>
        <Field label="Button label">
          <input
            className={inputClass()}
            value={config.buttonLabel}
            onChange={(e) => patch("buttonLabel", e.target.value)}
          />
        </Field>
        <Field label="Processing label">
          <input
            className={inputClass()}
            value={config.processingLabel}
            onChange={(e) => patch("processingLabel", e.target.value)}
          />
        </Field>
        <Field label="Upload title">
          <input
            className={inputClass()}
            value={config.uploadTitle}
            onChange={(e) => patch("uploadTitle", e.target.value)}
          />
        </Field>
        <Field label="Accept hint">
          <input
            className={inputClass()}
            value={config.acceptHint}
            onChange={(e) => patch("acceptHint", e.target.value)}
          />
        </Field>
        <Field label="Result note (optional)" className="sm:col-span-2">
          <textarea
            className={textareaClass() + " min-h-[60px]"}
            value={config.resultNote ?? ""}
            onChange={(e) => patch("resultNote", e.target.value || undefined)}
          />
        </Field>

        <Field label="Accepted MIME types" className="sm:col-span-1">
          <StringList
            values={config.accept}
            placeholder="application/pdf"
            onChange={(v) => patch("accept", v)}
          />
        </Field>
        <Field label="Allowed extensions" className="sm:col-span-1">
          <StringList
            values={config.extensions}
            placeholder=".pdf"
            onChange={(v) => patch("extensions", v)}
          />
        </Field>
      </div>

      <OptionsEditor
        options={config.options}
        onChange={(opts) => patch("options", opts)}
      />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-softborder pt-4">
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy-soft hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
        >
          <RotateCcw size={13} />
          Reset to default
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-button bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
        >
          <Save size={14} />
          Save settings
        </button>
      </div>
    </Card>
  );
}

function StringList({
  values,
  placeholder,
  onChange,
}: {
  values: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <ul className="space-y-2">
        {values.map((v, i) => (
          <li key={i} className="flex items-center gap-2">
            <code className="flex-1 rounded-button border border-softborder bg-white px-3 py-2 font-mono text-xs">
              {v}
            </code>
            <button
              type="button"
              aria-label="Remove"
              onClick={() => onChange(values.filter((_, idx) => idx !== i))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <input
          className={inputClass()}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            onChange([...values, v]);
            setDraft("");
          }}
          className="inline-flex h-10 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={13} />
          Add
        </button>
      </div>
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: OptionField[];
  onChange: (next: OptionField[]) => void;
}) {
  function update(i: number, next: OptionField) {
    onChange(options.map((o, idx) => (idx === i ? next : o)));
  }
  function addSelect() {
    onChange([
      ...options,
      {
        kind: "select",
        name: "option",
        label: "Option",
        default: "a",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ]);
  }
  function addPassword() {
    onChange([
      ...options,
      { kind: "password", name: "password", label: "Password", required: true },
    ]);
  }

  return (
    <div className="mt-6 rounded-xl border border-softborder bg-lavender/30 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-navy">Option fields</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={addSelect}
            className="inline-flex items-center gap-1 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
          >
            <Plus size={12} /> Select
          </button>
          <button
            type="button"
            onClick={addPassword}
            className="inline-flex items-center gap-1 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
          >
            <Plus size={12} /> Password
          </button>
        </div>
      </div>

      {options.length === 0 && (
        <p className="mt-3 text-xs text-navy-soft">
          No extra option fields. Add a select (e.g. quality level) or a password
          field (e.g. encryption password).
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {options.map((opt, i) => (
          <li key={i} className="rounded-lg border border-softborder bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                {opt.kind}
              </span>
              <button
                type="button"
                aria-label="Remove option"
                onClick={() => onChange(options.filter((_, idx) => idx !== i))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
              >
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Field name (form key)">
                <input
                  className={inputClass()}
                  value={opt.name}
                  onChange={(e) => update(i, { ...opt, name: e.target.value })}
                />
              </Field>
              <Field label="Label">
                <input
                  className={inputClass()}
                  value={opt.label}
                  onChange={(e) => update(i, { ...opt, label: e.target.value })}
                />
              </Field>
            </div>

            {opt.kind === "select" ? (
              <SelectOptionEditor opt={opt} onChange={(next) => update(i, next)} />
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Placeholder">
                  <input
                    className={inputClass()}
                    value={opt.placeholder ?? ""}
                    onChange={(e) =>
                      update(i, { ...opt, placeholder: e.target.value || undefined })
                    }
                  />
                </Field>
                <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
                  <input
                    type="checkbox"
                    checked={opt.required ?? false}
                    onChange={(e) => update(i, { ...opt, required: e.target.checked })}
                  />
                  Required
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SelectOptionEditor({
  opt,
  onChange,
}: {
  opt: Extract<OptionField, { kind: "select" }>;
  onChange: (next: OptionField) => void;
}) {
  return (
    <div className="mt-3">
      <p className="mb-2 text-xs font-semibold text-navy-soft">Choices</p>
      <ul className="space-y-2">
        {opt.options.map((choice, ci) => (
          <li key={ci} className="flex items-center gap-2">
            <input
              className={inputClass()}
              value={choice.value}
              placeholder="value"
              onChange={(e) =>
                onChange({
                  ...opt,
                  options: opt.options.map((c, idx) =>
                    idx === ci ? { ...c, value: e.target.value } : c,
                  ),
                })
              }
            />
            <input
              className={inputClass()}
              value={choice.label}
              placeholder="label"
              onChange={(e) =>
                onChange({
                  ...opt,
                  options: opt.options.map((c, idx) =>
                    idx === ci ? { ...c, label: e.target.value } : c,
                  ),
                })
              }
            />
            <button
              type="button"
              aria-label="Remove choice"
              onClick={() =>
                onChange({
                  ...opt,
                  options: opt.options.filter((_, idx) => idx !== ci),
                })
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...opt,
              options: [...opt.options, { value: "new", label: "New" }],
            })
          }
          className="inline-flex items-center gap-1 rounded-button border border-softborder bg-white px-2.5 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
        >
          <Plus size={12} /> Add choice
        </button>
        <label className="flex items-center gap-2 text-xs font-semibold text-navy-soft">
          Default
          <select
            className={inputClass() + " py-1"}
            value={opt.default}
            onChange={(e) => onChange({ ...opt, default: e.target.value })}
          >
            {opt.options.map((c, idx) => (
              <option key={idx} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
