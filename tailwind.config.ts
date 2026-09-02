import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./data/**/*.{ts,tsx}",
    // styles/tokens.ts holds class strings too (iconToneClasses, focusRing).
    // Without it Tailwind purges any utility named only there: "teal" was the
    // one icon tone used by no component directly, so every teal-toned tool —
    // Edit PDF among them — rendered its icon with no tile and no colour.
    "./styles/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#7C3AED",
          hover: "#6D28D9",
          soft: "#EDE9FE",
        },
        navy: {
          DEFAULT: "#1E1B2E",
          soft: "#4B4760",
        },
        lavender: "#F5F3FF",
        softborder: "#E9E5F5",
        success: "#15803D",
        warning: "#F59E0B",
        aipink: "#EC4899",

        // ── Authenticated application surfaces (M8-UI) ────────────────────
        // Scoped under `app-*` so the marketing palette above is untouched.
        // The authenticated shell is a productivity surface: cooler, denser and
        // flatter than the marketing gradients.
        app: {
          bg: "#F5F7FB",
          surface: "#FFFFFF",
          // Secondary surface for rails, table headers and inset panels.
          subtle: "#F8FAFC",
          border: "#E5E9F0",
          // Stronger divider for panel edges against the app background.
          borderstrong: "#D8DEE9",
          text: "#111827",
          muted: "#667085",
          sidebar: "#07111F",
          sidebarhover: "#111F33",
          sidebaractive: "#16263D",
          sidebartext: "#94A3B8",
        },

        // ── Premium editor shell surfaces (M-editor redesign) ──────────────
        // Scoped under `editor-*` so the app chrome above is untouched. These are
        // the tokens `styles/editor.ts` declares — the editor is its own surface
        // with its own application background, distinct from the workbench chrome.
        editor: {
          bg: "#F4F6FB",
          surface: "#FFFFFF",
          subtle: "#F8FAFC",
          border: "#E6E9F2",
          borderstrong: "#D8DEE9",
          text: "#1F2430",
          muted: "#667085",
          accent: "#7C3AED",
          accenthover: "#6D28D9",
          accentsoft: "#F3EEFF",
          page: "#FFFFFF",
          // Three distinct signal colours — see the long note in styles/editor.ts.
          // `accent` is brand + active tool; selection and guides must differ from
          // it, and from each other, or the canvas loses its readable hierarchy.
          selection: "#2563EB",
          selectionsoft: "#DBEAFE",
          guide: "#DB2777",
        },
      },
      borderRadius: {
        button: "12px",
        buttonlg: "14px",
        card: "24px",
        upload: "30px",
        // Authenticated app radii — tighter than the marketing `card` (24px),
        // which reads as decorative at dashboard density.
        control: "8px",
        controllg: "10px",
        appcard: "12px",
        panel: "16px",
        // Editor radius hierarchy (P1 final visual pass). One scale, four steps,
        // so nothing in the editor picks an arbitrary radius: inputs/buttons use
        // `control` (8px), a toolbar GROUP shell is 10px, panel surfaces 12px,
        // and floating/contextual surfaces (menus, the capsule, popovers) 14px.
        // Mixed ad-hoc radii are a large part of what reads as "prototype".
        toolgroup: "10px",
        appmenu: "14px",
      },
      spacing: {
        13: "3.25rem",
      },
      boxShadow: {
        card: "0 4px 20px rgba(124, 58, 237, 0.06)",
        cardhover: "0 10px 30px rgba(124, 58, 237, 0.12)",
        upload: "0 12px 40px rgba(124, 58, 237, 0.10)",
        // Restrained neutral elevation for the authenticated app. The violet
        // marketing shadows tint every card and read as decorative at density.
        appcard: "0 1px 2px rgba(16, 24, 40, 0.05)",
        appcardhover: "0 4px 12px rgba(16, 24, 40, 0.08)",
        apppanel: "0 8px 24px rgba(16, 24, 40, 0.10)",
        appmenu: "0 12px 32px rgba(16, 24, 40, 0.14)",
        // The PDF page on the editor canvas.
        page: "0 2px 8px rgba(16, 24, 40, 0.10), 0 8px 24px rgba(16, 24, 40, 0.08)",
        // Floating surfaces over the canvas (compact control capsule).
        editorfloating: "0 8px 24px rgba(16, 24, 40, 0.14)",
      },
      maxWidth: {
        // Body-copy sections. Widened from 1200px in the target-match pass:
        // the reference composition puts six tool tiles and a five-column tool
        // grid on one row, which reads as cramped inside 1200.
        container: "1280px",
        // Major visual panels (hero, security band, final CTA) that are meant
        // to feel wider than the text sections around them.
        panel: "1360px",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "lavender-gradient":
          "linear-gradient(180deg, #F5F3FF 0%, #FBFAFF 40%, #FFFFFF 100%)",
        "ai-gradient":
          "linear-gradient(135deg, #F3E8FF 0%, #FCE7F3 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
