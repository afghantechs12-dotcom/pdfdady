import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  type ButtonSize,
  type ButtonVariant,
} from "./buttonStyles";

interface BaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  fullWidth?: boolean;
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
}

type ButtonProps = BaseProps &
  (
    | ({ href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>)
    | ({ href?: undefined } & React.ButtonHTMLAttributes<HTMLButtonElement>)
  );

export function Button({
  variant = "primary",
  size = "md",
  leadingIcon,
  trailingIcon,
  fullWidth,
  loading,
  className,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(
    BUTTON_BASE,
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    fullWidth && "w-full",
    className,
  );

  const content = (
    <>
      {loading ? (
        <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        leadingIcon
      )}
      {children}
      {trailingIcon}
    </>
  );

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorProps } = props as {
      href: string;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      // `aria-busy` and nothing more: an anchor has no `disabled`, and inventing
      // one (pointer-events-none + aria-disabled) would be a navigation-blocking
      // state no caller has asked for.
      <Link href={href} className={classes} aria-busy={loading || undefined} {...anchorProps}>
        {content}
      </Link>
    );
  }

  const buttonProps = props as React.ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      className={classes}
      aria-busy={loading || undefined}
      {...buttonProps}
      // After the spread on purpose: `loading` implies `disabled`, and a call
      // site must not be able to hand back a button that still submits while its
      // own spinner is turning. `WorkspaceCreateDialog` had written
      // `disabled={loading}` next to `loading={loading}` for exactly this reason,
      // and four other call sites (`NewMenu`, `TagCatalog` ×2, `SmartCollections`)
      // had not — so a second Enter or a fast double-click POSTed twice. One
      // guard here beats the same guard at every call site, and each of those
      // still keeps its own in-flight `if (loading) return`, which covers the
      // submit already dispatched.
      disabled={loading || buttonProps.disabled}
    >
      {content}
    </button>
  );
}
