import { ImageResponse } from "next/og";
import { getBlogList, getBlogPostBySlug } from "@/lib/seo/adminRuntime";
import { getSITE } from "@/lib/seo/metadata";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "PDFDadi blog article";

// Pre-generate one image per article (SSG-friendly, matches the page params).
export async function generateStaticParams() {
  const posts = await getBlogList();
  return posts.map((p) => ({ slug: p.slug }));
}

/**
 * Per-article Open Graph image: the article title on the brand template, plus
 * its category. Generated at the edge so every article gets a correct 1200×630
 * social/search preview with zero manual image work.
 */
export default async function ArticleOgImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [post, SITE] = await Promise.all([
    getBlogPostBySlug(slug),
    getSITE(),
  ]);
  const title = post?.title ?? `${SITE.name} Blog`;
  const category = post?.category ?? "Guides";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background:
            "linear-gradient(135deg, #F5F3FF 0%, #FBFAFF 45%, #FFFFFF 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
            <div
              style={{
                width: "64px",
                height: "64px",
                borderRadius: "16px",
                background: "#7C3AED",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontSize: "34px",
                fontWeight: 700,
              }}
            >
              P
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "34px",
                fontWeight: 700,
                color: "#1E1B2E",
              }}
            >
              {SITE.name}
            </div>
          </div>
          <div
            style={{
              fontSize: "24px",
              fontWeight: 600,
              color: "#7C3AED",
              background: "#EDE9FE",
              padding: "10px 24px",
              borderRadius: "999px",
            }}
          >
            {category}
          </div>
        </div>

        <div
          style={{
            fontSize: title.length > 42 ? "60px" : "72px",
            fontWeight: 800,
            color: "#1E1B2E",
            lineHeight: 1.12,
            letterSpacing: "-2px",
            display: "flex",
          }}
        >
          {title}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            fontSize: "26px",
            color: "#4B4760",
            fontWeight: 600,
          }}
        >
          <span style={{ color: "#7C3AED" }}>
            {SITE.url.replace("https://", "")}/blog
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
