import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * Shared presentation primitives for the authenticated application.
 *
 * These exist so the Workspace dashboard, the document manager and the editor
 * inspector render the same card, the same section heading and the same empty
 * state rather than three near-identical implementations that drift apart. They
 * are deliberately thin: layout and tokens only, no data fetching and no state.
 */

/** A white panel on the app background — the default container for content. */
export function AppCard({
  children,
  className,
  padded = true,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  as?: "div" | "section" | "article" | "aside";
}) {
  return (
    <Tag
      className={cn(
        "rounded-appcard border border-app-border bg-app-surface shadow-appcard",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** A section title with an optional action rendered on the right. */
export function SectionHeader({
  title,
  subtitle,
  action,
  id,
  className,
  level = 2,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  id?: string;
  className?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <Heading id={id} className="truncate text-[15px] font-bold tracking-tight text-app-text">
          {title}
        </Heading>
        {subtitle && <p className="mt-0.5 truncate text-xs text-app-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * An empty state with an icon, a message and real actions.
 *
 * `actions` is a slot rather than a prop list because an empty state without a
 * way forward is the problem this component exists to prevent: the caller has
 * to decide what the user should do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact = false,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            "grid place-items-center rounded-full bg-lavender text-primary",
            compact ? "h-9 w-9" : "h-12 w-12",
          )}
        >
          {icon}
        </div>
      )}
      <div>
        <p className={cn("font-semibold text-app-text", compact ? "text-sm" : "text-[15px]")}>{title}</p>
        {description && (
          <p className={cn("mx-auto mt-1 max-w-sm text-app-muted", compact ? "text-xs" : "text-sm")}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
  info: "bg-primary-soft text-primary",
};

/**
 * A status pill. The label is always rendered as text, so status is never
 * conveyed by colour alone.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  icon,
  className,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** A compact icon-only control. An accessible name is required, not optional. */
export function IconButton({
  label,
  icon,
  onClick,
  href,
  disabled,
  active,
  size = "md",
  className,
  ...rest
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  active?: boolean;
  size?: "sm" | "md";
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "className">) {
  const classes = cn(
    "grid shrink-0 place-items-center rounded-control transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
    size === "sm" ? "h-8 w-8" : "h-9 w-9",
    active ? "bg-primary-soft text-primary" : "text-app-muted hover:bg-lavender hover:text-app-text",
    disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
    className,
  );

  if (href && !disabled) {
    return (
      <Link href={href} aria-label={label} title={label} className={classes}>
        {icon}
      </Link>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={classes}
      {...rest}
    >
      {icon}
    </button>
  );
}

/** A labelled progress meter, e.g. storage usage. */
export function Meter({
  value,
  max,
  label,
  tone = "info",
  className,
}: {
  value: number;
  max: number;
  label: string;
  tone?: StatusTone;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, Math.round((value / safeMax) * 100)));
  const barTone =
    tone === "danger" ? "bg-red-500" : tone === "warning" ? "bg-amber-500" : "bg-primary";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-app-border", className)}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cn("h-full rounded-full transition-[width]", barTone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A skeleton block for loading states.
 *
 * `motion-reduce:animate-none` is explicit rather than assumed: the comment here
 * used to claim reduced-motion support that no utility in the class list
 * provided, and the homepage's bespoke reduced-motion CSS block does not cover
 * generic `animate-pulse` on app surfaces.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse motion-reduce:animate-none rounded bg-app-border/70", className)}
    />
  );
}
