import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils/cn";

interface FeatureItemProps {
  icon: string;
  title: string;
  description: string;
  withDivider?: boolean;
}

export function FeatureItem({
  icon,
  title,
  description,
  withDivider,
}: FeatureItemProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center px-4 text-center",
        withDivider &&
          "lg:before:absolute lg:before:left-0 lg:before:top-1/2 lg:before:h-12 lg:before:-translate-y-1/2 lg:before:border-l lg:before:border-softborder",
      )}
    >
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <Icon name={icon} size={22} strokeWidth={2.1} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-navy">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-navy-soft">
        {description}
      </p>
    </div>
  );
}
