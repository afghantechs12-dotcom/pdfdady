"use client";

import { useRef, useState } from "react";
import { Plus, Trash2, Save, X } from "lucide-react";
import { persistPricingPlans } from "./pricingPersistence";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveStatus,
} from "@/components/admin/SaveStatus";
import type { PricingPlan } from "@/data/pricing";
import { useRouter } from "next/navigation";

export function PricingManager({ initial }: { initial: PricingPlan[] }) {
  const router = useRouter();
  const [plans, setPlans] = useState<PricingPlan[]>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const inFlight = useRef(false);
  const [savedPlans, setSavedPlans] = useState(() => Object.fromEntries(initial.map(p => [p.id, JSON.stringify(p)])));
  const dirtyPlans = plans.filter(p => savedPlans[p.id] !== JSON.stringify(p));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveBatch(pending: PricingPlan[]) {
    if (inFlight.current || pending.length === 0) return;
    if (pending.some(p => !p.id || !p.name || !p.price)) {
      setError("ID, name and price are required for each changed plan");
      setStatus("error");
      return;
    }
    inFlight.current = true;
    setStatus("saving");
    setError(null);
    try {
      await persistPricingPlans(pending, {
        save: (id, snapshot) => {
          setBusyId(id);
          return fetch(`/api/admin/pricing/${encodeURIComponent(id)}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: snapshot,
          });
        },
        onSaved: (id, snapshot) => setSavedPlans(current => ({ ...current, [id]: snapshot })),
      });
      setStatus("saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed. Your changes are still here.");
      setStatus("error");
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (inFlight.current) return;
    if (!confirm(`Delete the "${id}" plan?`)) return;
    inFlight.current = true;
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/pricing/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPlans((arr) => arr.filter((p) => p.id !== id));
        router.refresh();
      } else {
        setError("Failed to delete");
      }
    } catch {
      setError("Network error");
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  function addPlan() {
    const base: PricingPlan = {
      id: "",
      name: "",
      price: "",
      period: "",
      description: "",
      features: [],
      cta: "Get started",
      href: "/tools",
      available: false,
      highlighted: false,
    };
    setPlans((arr) => [...arr, base]);
  }

  return (
    <div className="space-y-6">
      <Card
        title="Pricing plans"
        description="Shown on the /pricing page."
        toolbar={
          <button
            type="button"
            onClick={addPlan}
            disabled={busyId !== null}
            className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-2 text-xs font-semibold text-white shadow-card hover:bg-primary-hover"
          >
            <Plus size={14} />
            New plan
          </button>
        }
      >
        <fieldset disabled={busyId !== null}>
        <ul className="space-y-4">
          {plans.map((plan, planIndex) => (
            <li
              key={planIndex}
              className="rounded-xl border border-softborder bg-white p-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_1fr_120px_120px]">
                <Field label="ID">
                  <input
                    className={inputClass()}
                    value={plan.id}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, id: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Name">
                  <input
                    className={inputClass()}
                    value={plan.name}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Price" hint="e.g. $0, Coming soon">
                  <input
                    className={inputClass()}
                    value={plan.price}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, price: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Period">
                  <input
                    className={inputClass()}
                    value={plan.period ?? ""}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, period: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="forever / month"
                  />
                </Field>

                <Field label="Description" className="sm:col-span-4">
                  <textarea
                    className="min-h-[60px] resize-y rounded-button border border-softborder bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                    value={plan.description}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex
                            ? { ...x, description: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                </Field>

                <Field label="CTA label">
                  <input
                    className={inputClass()}
                    value={plan.cta}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, cta: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="CTA href">
                  <input
                    className={inputClass()}
                    value={plan.href}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, href: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </Field>
                <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
                  <input
                    type="checkbox"
                    checked={plan.available}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex
                            ? { ...x, available: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  Available
                </label>
                <label className="flex items-center gap-2 self-end rounded-button border border-softborder bg-white px-3 py-2 text-xs font-semibold text-navy">
                  <input
                    type="checkbox"
                    checked={plan.highlighted ?? false}
                    onChange={(e) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex
                            ? { ...x, highlighted: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  Highlighted
                </label>

                <Field label="Features" className="sm:col-span-4">
                  <FeatureList
                    features={plan.features}
                    onChange={(next) =>
                      setPlans((arr) =>
                        arr.map((x, idx) =>
                          idx === planIndex ? { ...x, features: next } : x,
                        ),
                      )
                    }
                  />
                </Field>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => remove(plan.id)}
                  disabled={busyId !== null || !plan.id}
                  className="inline-flex items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-1.5 text-xs font-semibold text-navy-soft hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => saveBatch([plan])}
                  disabled={busyId !== null}
                  className="inline-flex items-center gap-1.5 rounded-button bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  <Save size={13} />
                  Save plan
                </button>
              </div>
            </li>
          ))}
        </ul>
        </fieldset>
      </Card>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-card border border-softborder bg-white p-4 shadow-card">
        <div className="text-sm text-navy">
          <p role="status">{dirtyPlans.length ? `${dirtyPlans.length} plan${dirtyPlans.length === 1 ? "" : "s"} with unsaved changes` : "All plan changes saved"}</p>
          {status !== "idle" && <SaveStatus status={status} errorMessage={error ?? undefined} />}
        </div>
        <button type="button" onClick={() => saveBatch(dirtyPlans)} disabled={busyId !== null || dirtyPlans.length === 0}
          aria-busy={status === "saving" || undefined}
          className="min-h-11 rounded-button bg-primary px-4 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60">
          {status === "saving" ? "Saving plans…" : "Save changed plans"}
        </button>
      </div>
    </div>
  );
}

function FeatureList({
  features,
  onChange,
}: {
  features: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <ul className="space-y-2">
        {features.map((f, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <input
              className={inputClass()}
              value={f}
              onChange={(e) => {
                const next = [...features];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              onClick={() => onChange(features.filter((_, idx) => idx !== i))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
              aria-label="Remove feature"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <input
          className={inputClass()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a feature"
        />
        <button
          type="button"
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            onChange([...features, v]);
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
