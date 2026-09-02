import { cn } from "@/lib/utils/cn";
import { SaveStatus } from "./SaveStatus";

interface CardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  notice?: React.ReactNode;
  toolbar?: React.ReactNode;
  status?: "idle" | "saving" | "saved" | "error";
  errorMessage?: string;
}

export function Card({
  title,
  description,
  children,
  className,
  notice,
  toolbar,
  status,
  errorMessage,
}: CardProps) {
  return (
    <section
      className={cn(
        "rounded-card border border-softborder bg-white p-5 shadow-card sm:p-7",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-navy">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-navy-soft">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status && <SaveStatus status={status} errorMessage={errorMessage} />}
          {toolbar}
        </div>
      </header>
      {notice && <div className="mt-4">{notice}</div>}
      <div className="mt-5">{children}</div>
    </section>
  );
}
