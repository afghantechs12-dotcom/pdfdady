import type { Metadata } from "next";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { ContactForm } from "@/components/contact/ContactForm";
import { ArticleBody } from "@/components/blog/ArticleBody";
import { getPage } from "@/lib/seo/adminRuntime";
import { buildMetadata } from "@/lib/seo/metadata";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "Contact",
    description: "Get in touch with the PDFDadi team.",
    path: "/contact",
  });
}

export default async function ContactPage() {
  const admin = await getPage("contact");
  return (
    <PageContainer className="section-pad" maxWidth="narrow">
      <SectionHeading
        as="h1"
        title={admin?.title || "Contact us"}
        description={
          admin?.description ??
          "Have a question or feedback? We'd love to hear from you."
        }
      />
      {admin && admin.blocks.length > 0 && (
        <div className="mt-8">
          <ArticleBody blocks={admin.blocks} />
        </div>
      )}
      <div className="mx-auto mt-10 max-w-lg">
        <ContactForm />
      </div>
    </PageContainer>
  );
}
