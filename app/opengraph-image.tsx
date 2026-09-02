import { ImageResponse } from "next/og";
import { getSITE } from "@/lib/seo/metadata";

export const alt = "PDFDadi — Free Online PDF Tools";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Default site-wide Open Graph image (1200×630), generated at the edge so there
 * is no static asset to maintain. Reads SITE.name/url/description from the
 * admin store, so brand copy edits show up in social previews automatically.
 */
export default async function OgImage() {
  const SITE = await getSITE();
  // Split "PDFDadi" into a plain prefix and an accent suffix for the wordmark.
  const prefix = SITE.name.startsWith("PDF") ? "PDF" : SITE.name;
  const suffix = SITE.name.startsWith("PDF") ? SITE.name.slice(3) : "";
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
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              width: "72px",
              height: "72px",
              borderRadius: "18px",
              background:
                "linear-gradient(135deg, #8B5CF6 0%, #7C3AED 55%, #DB2777 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="46" height="46" viewBox="0 0 48 48" fill="none">
              <path
                d="M14 8h14.5L38 17.5V38a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z"
                fill="#FFFFFF"
              />
              <path
                d="M28.5 8 38 17.5h-7a2.5 2.5 0 0 1-2.5-2.5V8z"
                fill="#DDD6FE"
              />
              <rect x="15.5" y="23" width="17" height="3.2" rx="1.6" fill="#A78BFA" />
              <rect x="15.5" y="29.4" width="17" height="3.2" rx="1.6" fill="#C4B5FD" />
              <rect x="15.5" y="35.8" width="11" height="3.2" rx="1.6" fill="#DDD6FE" />
            </svg>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "40px",
              fontWeight: 700,
              color: "#1E1B2E",
            }}
          >
            {prefix}
            <span style={{ color: "#7C3AED" }}>{suffix}</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: "68px",
              fontWeight: 800,
              color: "#1E1B2E",
              lineHeight: 1.1,
              letterSpacing: "-2px",
            }}
          >
            Free Online PDF Tools
          </div>
          <div style={{ fontSize: "32px", color: "#4B4760", marginTop: "20px" }}>
            {SITE.description}
          </div>
        </div>

        <div style={{ fontSize: "26px", color: "#7C3AED", fontWeight: 600 }}>
          {SITE.url.replace("https://", "")}
        </div>
      </div>
    ),
    { ...size },
  );
}
