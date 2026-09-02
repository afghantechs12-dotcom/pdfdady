"use client";

import { useState } from "react";
import { Card } from "@/components/admin/Card";
import {
  Field,
  inputClass,
  SaveButton,
  textareaClass,
} from "@/components/admin/SaveStatus";
import { Plus, X } from "lucide-react";
import type { SiteSettings } from "@/data/admin";
import { useRouter } from "next/navigation";

export function SiteSettingsForm({ initial }: { initial: SiteSettings }) {
  const router = useRouter();
  const [data, setData] = useState<SiteSettings>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [bulletDraft, setBulletDraft] = useState("");

  function patch<K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/site", {
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
        title="Brand identity"
        description="The name and brand-voice settings shown across the site."
        status={status}
        errorMessage={error ?? undefined}
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Site name">
            <input
              className={inputClass()}
              value={data.name}
              onChange={(e) => patch("name", e.target.value)}
            />
          </Field>
          <Field label="Twitter handle" hint="Include @ (e.g., @pdfdadi)">
            <input
              className={inputClass()}
              value={data.twitter}
              onChange={(e) => patch("twitter", e.target.value)}
            />
          </Field>
          <Field label="Locale">
            <input
              className={inputClass()}
              value={data.locale}
              onChange={(e) => patch("locale", e.target.value)}
              placeholder="en_US"
            />
          </Field>
          <Field label="Logo path">
            <input
              className={inputClass()}
              value={data.logoUrl}
              onChange={(e) => patch("logoUrl", e.target.value)}
              placeholder="/brand-logo"
            />
          </Field>
          <Field label="OpenGraph image path">
            <input
              className={inputClass()}
              value={data.ogImageUrl}
              onChange={(e) => patch("ogImageUrl", e.target.value)}
              placeholder="/opengraph-image"
            />
          </Field>
          <Field label="Default title" hint="Used when a page doesn't set its own.">
            <input
              className={inputClass()}
              value={data.defaultTitle}
              onChange={(e) => patch("defaultTitle", e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5">
          <Field label="Title template" hint="%s is replaced by the per-page title.">
            <input
              className={inputClass()}
              value={data.titleTemplate}
              onChange={(e) => patch("titleTemplate", e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Site URL" hint="Used by sitemap, OG and JSON-LD.">
            <input
              className={inputClass()}
              value={data.url}
              onChange={(e) => patch("url", e.target.value)}
              placeholder="https://example.com"
              type="url"
              required
            />
          </Field>
          <Field label="Description" hint="Default meta description for the homepage.">
            <textarea
              className={textareaClass() + " min-h-[80px]"}
              value={data.description}
              onChange={(e) => patch("description", e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title="Social" description="Links rendered in the footer and JSON-LD.">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Twitter URL">
            <input
              className={inputClass()}
              type="url"
              value={data.social.twitterUrl}
              onChange={(e) =>
                patch("social", { ...data.social, twitterUrl: e.target.value })
              }
            />
          </Field>
          <Field label="GitHub URL">
            <input
              className={inputClass()}
              type="url"
              value={data.social.githubUrl}
              onChange={(e) =>
                patch("social", { ...data.social, githubUrl: e.target.value })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="Footer & hero trust bullets" description="Copy shown in the footer card and the hero.">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Footer tagline">
            <input
              className={inputClass()}
              value={data.footerTagline}
              onChange={(e) => patch("footerTagline", e.target.value)}
            />
          </Field>
          <Field label="Footer card title">
            <input
              className={inputClass()}
              value={data.footerCardTitle}
              onChange={(e) => patch("footerCardTitle", e.target.value)}
            />
          </Field>
          <Field label="Footer card subtitle" className="sm:col-span-2">
            <input
              className={inputClass()}
              value={data.footerCardSubtitle}
              onChange={(e) => patch("footerCardSubtitle", e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-5">
          <Field label="Hero trust bullets" hint="Shown next to the homepage hero CTA.">
            <ul className="space-y-2">
              {data.trustBullets.map((b, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <input
                    className={inputClass()}
                    value={b}
                    onChange={(e) => {
                      const next = [...data.trustBullets];
                      next[i] = e.target.value;
                      patch("trustBullets", next);
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Remove bullet"
                    onClick={() =>
                      patch(
                        "trustBullets",
                        data.trustBullets.filter((_, idx) => idx !== i),
                      )
                    }
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-navy-soft hover:bg-red-50 hover:text-red-600"
                  >
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <input
                className={inputClass()}
                placeholder="Add another bullet"
                value={bulletDraft}
                onChange={(e) => setBulletDraft(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const v = bulletDraft.trim();
                  if (!v) return;
                  patch("trustBullets", [...data.trustBullets, v]);
                  setBulletDraft("");
                }}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-button border border-softborder bg-white px-3 text-xs font-semibold text-navy hover:border-primary hover:text-primary"
              >
                <Plus size={14} />
                Add
              </button>
            </div>
          </Field>
        </div>
      </Card>

      <div className="flex items-center justify-end">
        <SaveButton status={status} busy={status === "saving"} />
      </div>
    </form>
  );
}
