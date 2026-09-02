"use client";

import { Check } from "lucide-react";
import type { JobProgressStage } from "@/src/domain/jobs/progressStage";
import { stageRank } from "@/src/domain/jobs/progressStage";
import { VISIBLE_JOB_STAGES, stageLabel } from "@/lib/tools/processingJobStatus";
import { cn } from "@/lib/utils/cn";

/**
 * The stage track: Preparing → Queued → Processing → Finalizing.
 *
 * It shows *which* stage the job is in, and nothing more precise than that,
 * because nothing more precise is known. A stage the job has passed is a filled
 * check; the current stage pulses; later stages are dim. There is no animation
 * that advances on its own — every visual change here corresponds to a stage the
 * worker actually reported.
 *
 * This replaces the growing-percentage bar for pipeline jobs. A bar implies a
 * measured fraction; a Ghostscript run does not expose one, so a bar could only
 * ever be a plausible-looking guess. Four honest labels tell the user more than a
 * smooth lie: "Queued" explains a wait that a stuck 8% does not.
 */
export function JobStageTrack({
  stage,
  className,
}: {
  stage: JobProgressStage;
  className?: string;
}) {
  const current = stageRank(stage);

  return (
    <ol className={cn("flex w-full items-center gap-1.5", className)}>
      {VISIBLE_JOB_STAGES.map((s) => {
        const rank = stageRank(s);
        const done = rank < current;
        const active = rank === current;
        return (
          <li key={s} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div
              className={cn(
                "h-1.5 w-full rounded-full transition-colors duration-300",
                done && "bg-primary",
                active && "animate-pulse bg-primary",
                !done && !active && "bg-softborder/60",
              )}
            />
            <span
              className={cn(
                "flex items-center gap-1 truncate text-[11px] leading-none transition-colors",
                active ? "font-semibold text-navy" : "text-navy-soft",
                !done && !active && "opacity-60",
              )}
            >
              {done && <Check size={11} className="shrink-0 text-primary" />}
              {stageLabel(s)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
