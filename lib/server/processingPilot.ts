import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IFeatureFlagService } from "@/src/application/ports/featureflags/FeatureFlagService";

/** The pilot tool for the unified pipeline. Exactly one, deliberately. */
export const PILOT_TOOL_SLUG = "compress-pdf";

export const PROCESSING_PIPELINE_FLAG = "unified_processing_pipeline";

/**
 * Whether a tool should run through the unified pipeline.
 *
 * Two gates, and both must pass. The slug must be the pilot — a flag flip must
 * not sweep thirteen unmigrated tools into a pipeline whose processors have not
 * been exercised. And the flag must be on.
 *
 * `PROCESSING_PIPELINE=off` in the environment forces it off regardless of the
 * database. That is the rollback lever: a flag stored in the DB is no help when
 * the reason you are rolling back is that the DB is unhappy, and an operator
 * mid-incident should not need a working admin UI to get back to the previous
 * code path. `on` likewise forces it on, for local development without seeding a
 * flag row.
 *
 * Defaults to disabled. Every failure — no flag row, unreachable DB, thrown
 * resolver — resolves to the legacy path, which is the one already running in
 * production.
 */
export async function isProcessingPipelineEnabled(slug: string): Promise<boolean> {
  if (slug !== PILOT_TOOL_SLUG) return false;

  const override = (process.env.PROCESSING_PIPELINE ?? "").trim().toLowerCase();
  if (override === "off" || override === "0" || override === "false") return false;
  if (override === "on" || override === "1" || override === "true") return true;

  try {
    const flags = appContainer.resolve<IFeatureFlagService>(Tokens.FeatureFlagService);
    return await flags.isEnabled(PROCESSING_PIPELINE_FLAG);
  } catch {
    return false;
  }
}
