import { Check } from "lucide-react";
import { Icon } from "@/components/ui/Icon";

interface UseCaseCardProps {
  title: string;
  description: string;
  icon: string;
  /** The concrete workflow, when the entry defines one. */
  steps?: string[];
}

/**
 * A use case, as a workflow rather than a label.
 *
 * The card previously showed a title and one generic line ("Assignments, notes
 * and study materials") which told a visitor nothing about what the product
 * would do for them. It now lists the actual sequence of features that audience
 * would use. `steps` is optional so that a use case added through the admin
 * console — which edits title/description/icon only — still renders correctly.
 *
 * Hover lift is dropped: these are not links, and a card that rises under the
 * cursor while doing nothing when clicked reads as broken.
 */
export function UseCaseCard({
  title,
  description,
  icon,
  steps,
}: UseCaseCardProps) {
  return (
    <div className="flex h-full flex-col items-start gap-4 rounded-card border border-softborder bg-white p-6 shadow-card">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <Icon name={icon} size={22} strokeWidth={2.1} aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-base font-semibold text-navy">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-navy-soft">
          {description}
        </p>
      </div>

      {steps && steps.length > 0 && (
        <ul className="mt-auto flex w-full flex-col gap-2 border-t border-softborder pt-4">
          {steps.map((step) => (
            <li key={step} className="flex items-start gap-2 text-sm text-navy-soft">
              <Check
                size={14}
                strokeWidth={3}
                aria-hidden="true"
                className="mt-1 shrink-0 text-success"
              />
              <span>{step}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
