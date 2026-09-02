import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { colors, aura } from "@/styles/tokens";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  withWordmark?: boolean;
  className?: string;
}

const sizeMap = {
  sm: { box: 32, text: "text-lg" },
  md: { box: 36, text: "text-xl" },
  lg: { box: 44, text: "text-2xl" },
} as const;

/**
 * PDFDadi brand mark: a white document with a folded corner on a
 * violet→pink gradient tile. Rendered as inline SVG so it stays crisp at
 * every size with zero image requests.
 */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className="shrink-0 drop-shadow-[0_4px_12px_rgba(124,58,237,0.35)]"
    >
      <defs>
        <linearGradient id="pdfdadi-tile" x1="4" y1="4" x2="44" y2="44">
          <stop offset="0%" stopColor={aura.violet} />
          <stop offset="55%" stopColor={colors.primary} />
          <stop offset="100%" stopColor={aura.pinkDeep} />
        </linearGradient>
        <linearGradient id="pdfdadi-sheen" x1="4" y1="4" x2="24" y2="24">
          <stop offset="0%" stopColor={colors.white} stopOpacity="0.28" />
          <stop offset="100%" stopColor={colors.white} stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#pdfdadi-tile)" />
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#pdfdadi-sheen)" />
      {/* document with dog-eared corner */}
      <path
        d="M16 11h11.2L34 17.8V34a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3z"
        fill={colors.white}
      />
      <path d="M27.2 11 34 17.8h-5a1.8 1.8 0 0 1-1.8-1.8v-5z" fill="#DDD6FE" />
      {/* content lines */}
      <rect x="17.5" y="22.5" width="13" height="2.4" rx="1.2" fill="#A78BFA" />
      <rect x="17.5" y="27.3" width="13" height="2.4" rx="1.2" fill="#C4B5FD" />
      <rect x="17.5" y="32.1" width="8.5" height="2.4" rx="1.2" fill="#DDD6FE" />
    </svg>
  );
}

export function Logo({
  size = "md",
  withWordmark = true,
  className,
}: LogoProps) {
  const s = sizeMap[size];
  return (
    <Link
      href="/"
      aria-label="PDFDadi home"
      className={cn("inline-flex items-center gap-2.5", className)}
    >
      <LogoMark size={s.box} />
      {withWordmark && (
        <span className={cn("font-bold tracking-tight text-navy", s.text)}>
          PDF
          <span className="bg-gradient-to-r from-primary to-aipink bg-clip-text text-transparent">
            Dadi
          </span>
        </span>
      )}
    </Link>
  );
}
