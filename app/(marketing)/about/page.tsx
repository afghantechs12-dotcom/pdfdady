import type { Metadata } from "next";
import { ShieldCheck, Zap, Heart } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { AdminPageBody } from "@/components/pages/AdminPageBody";
import { getPage } from "@/lib/seo/adminRuntime";
import { buildMetadata } from "@/lib/seo/metadata";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "About",
    description:
      "PDFDadi builds fast, secure and privacy-first PDF tools for everyday document work.",
    path: "/about",
  });
}

const values = [
  {
    icon: ShieldCheck,
    title: "Privacy first",
    text: "Your files are processed in your browser wherever possible. Nothing is uploaded or stored for our supported tools.",
  },
  {
    icon: Zap,
    title: "Fast and simple",
    text: "Clean, focused tools that get the job done in seconds without clutter or sign ups.",
  },
  {
    icon: Heart,
    title: "Built for everyone",
    text: "From students to small businesses, PDFDadi is made for real, everyday document needs.",
  },
];

export default async function AboutPage() {
  const admin = await getPage("about");
  if (admin) {
    return (
      <PageContainer className="section-pad" maxWidth="narrow">
        <AdminPageBody content={admin} />
      </PageContainer>
    );
  }
  return (
    <PageContainer className="section-pad" maxWidth="narrow">
      <SectionHeading
        as="h1"
        title="About PDFDadi"
        description="Fast, secure and simple PDF tools for everyday document work."
      />

      <div className="mt-10 space-y-4 text-base leading-relaxed text-navy-soft">
        <p>
          PDFDadi started with a simple idea: working with PDFs shouldn&apos;t
          mean handing your private documents to a server you don&apos;t control.
          We build tools that run directly in your browser, so your files stay
          on your device.
        </p>
        <p>
          Our mission is to make everyday document work effortless — merging,
          splitting, editing and converting PDFs with a clean, modern
          experience that anyone can use, on any device, without an account.
        </p>
      </div>

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {values.map((v) => (
          <div
            key={v.title}
            className="rounded-card border border-softborder bg-white p-6 shadow-card"
          >
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-soft text-primary">
              <v.icon size={20} />
            </span>
            <h2 className="mt-4 text-base font-semibold text-navy">{v.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-navy-soft">
              {v.text}
            </p>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
