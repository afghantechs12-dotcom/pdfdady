import { cn } from "@/lib/utils/cn";

type BadgeTone = "purple" | "green" | "pink" | "neutral";

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  icon?: React.ReactNode;
  className?: string;
}

const toneClasses: Record<BadgeTone, string> = {
  purple: "bg-primary-soft text-primary",
  green: "bg-green-50 text-green-600",
  pink: "bg-pink-50 text-pink-600",
  neutral: "bg-lavender text-navy-soft",
};

export function Badge({ children, tone = "purple", icon, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold",
        toneClasses[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
