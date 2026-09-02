import { cn } from "@/lib/utils/cn";

interface PageContainerProps {
  children: React.ReactNode;
  maxWidth?: "default" | "narrow" | "wide";
  className?: string;
}

const widthClasses = {
  default: "max-w-container",
  narrow: "max-w-3xl",
  wide: "max-w-panel",
} as const;

export function PageContainer({
  children,
  maxWidth = "default",
  className,
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-5 sm:px-6 lg:px-8",
        widthClasses[maxWidth],
        className,
      )}
    >
      {children}
    </div>
  );
}
