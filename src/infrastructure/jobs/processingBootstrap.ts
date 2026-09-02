import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IToolProcessorRegistry } from "@/src/application/ports/processing/ToolProcessor";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
} from "@/src/application/services/ProcessingJobService";
import { ProcessingUsageRecorder } from "@/src/application/services/ProcessingUsageRecorder";
import type { UsageMeteringService } from "@/src/application/services/UsageMeteringService";
import { createProcessingJobHandler } from "./ProcessingJobHandler";

/**
 * Registers the unified `processing` handler on a worker.
 *
 * Shared by the in-process worker bootstrap and the standalone `npm run worker`
 * process so both agree, by construction, on which handler serves the type. Two
 * separate registration sites would be a live bug waiting to happen: the
 * standalone worker would eventually run a handler version the web process does
 * not, and the difference would only show up as jobs failing in production.
 */
export function registerProcessingHandler(worker: IWorker): void {
  const logger = appContainer.resolve<ILogger>(Tokens.Logger);
  worker.register(
    PROCESSING_JOB_TYPE,
    createProcessingJobHandler({
      storage: appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage),
      upload: appContainer.resolve<IUploadService>(Tokens.UploadService),
      jobs: appContainer.resolve<ProcessingJobService>(Tokens.ProcessingJobService),
      processors: appContainer.resolve<IToolProcessorRegistry>(
        Tokens.ToolProcessorRegistry,
      ),
      usage: appContainer.resolve<ProcessingUsageRecorder>(
        Tokens.ProcessingUsageRecorder,
      ),
      // The same singleton the submit path reserved through, so a settlement and
      // its reservation share one in-process idempotency guard whenever the
      // worker runs in the web process.
      metering: appContainer.resolve<UsageMeteringService>(Tokens.UsageMeteringService),
      logger,
    }),
  );
}
