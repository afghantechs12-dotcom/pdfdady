import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import {
  checkAllDependencies,
  binaryInfo,
  type BinaryName,
} from "@/lib/server/dependencyCheck";
import { getPage } from "@/lib/seo/adminRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Server Status",
  robots: { index: false, follow: false },
};

export default async function ServerStatusPage() {
  const [deps, intro] = await Promise.all([
    checkAllDependencies(),
    getPage("serverStatus"),
  ]);
  const names = Object.keys(binaryInfo) as BinaryName[];

  return (
    <PageContainer className="section-pad" maxWidth="narrow">
      <SectionHeading
        as="h1"
        title={intro?.title || "Server tool status"}
        description={
          intro?.description ??
          "Checks whether the binaries used by server-side tools are installed in this environment."
        }
      />

      <div className="mt-10 overflow-hidden rounded-card border border-softborder bg-white shadow-card">
        {names.map((name) => {
          const ok = deps[name];
          return (
            <div
              key={name}
              className="flex items-center justify-between gap-4 border-b border-softborder px-5 py-4 last:border-b-0"
            >
              <div>
                <p className="font-semibold text-navy">{binaryInfo[name].label}</p>
                <p className="text-xs text-navy-soft">
                  binary: {name} · apt: {binaryInfo[name].apt}
                </p>
              </div>
              {ok ? (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
                  <CheckCircle2 size={18} /> Installed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600">
                  <XCircle size={18} /> Missing
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-sm text-navy-soft">
        Missing a binary? Install it on the server or run PDFDadi with the
        provided Docker image, which bundles every dependency. See SERVER_SETUP.md.
      </p>
    </PageContainer>
  );
}
