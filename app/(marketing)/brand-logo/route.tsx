import { ImageResponse } from "next/og";

/**
 * Stable brand logo at a FIXED url (/brand-logo), used as the Organization /
 * publisher `logo` in JSON-LD. Article OG images are content-hashed, but
 * schema.org needs a permanent logo URL — this route provides one (512×512 PNG,
 * square, as Google recommends).
 */
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "36px",
          background: "#FFFFFF",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            width: "220px",
            height: "220px",
            borderRadius: "56px",
            background:
              "linear-gradient(135deg, #8B5CF6 0%, #7C3AED 55%, #DB2777 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 20px 60px rgba(124, 58, 237, 0.35)",
          }}
        >
          <svg width="150" height="150" viewBox="0 0 48 48" fill="none">
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
            fontSize: "72px",
            fontWeight: 700,
            color: "#1E1B2E",
          }}
        >
          PDF<span style={{ color: "#7C3AED" }}>Dadi</span>
        </div>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
