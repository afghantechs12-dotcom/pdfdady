import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** App favicon — the PDFDadi document mark on the violet→pink gradient tile. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #8B5CF6 0%, #7C3AED 55%, #DB2777 100%)",
          borderRadius: 14,
        }}
      >
        <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
          <path
            d="M14 8h14.5L38 17.5V38a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z"
            fill="#FFFFFF"
          />
          <path d="M28.5 8 38 17.5h-7a2.5 2.5 0 0 1-2.5-2.5V8z" fill="#DDD6FE" />
          <rect x="15.5" y="23" width="17" height="3.2" rx="1.6" fill="#A78BFA" />
          <rect x="15.5" y="29.4" width="17" height="3.2" rx="1.6" fill="#C4B5FD" />
          <rect x="15.5" y="35.8" width="11" height="3.2" rx="1.6" fill="#DDD6FE" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
