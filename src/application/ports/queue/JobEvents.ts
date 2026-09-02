/**
 * JobEvents port — progress reporting for streaming UIs (e.g. an SSE endpoint
 * that shows job progress to the client). Adapters: in-memory (EventEmitter,
 * single-process) and Redis (pub/sub, cross-process). The worker calls
 * `emitProgress` via the JobContext; an SSE route subscribes via `onProgress`.
 */
export interface ProgressEvent {
  jobId: string;
  pct: number;
  detail?: string;
}

export interface IJobEvents {
  emitProgress(jobId: string, pct: number, detail?: string): Promise<void>;
  /** Subscribes to progress events for `jobId`; returns an unsubscribe fn. */
  onProgress(jobId: string, cb: (e: ProgressEvent) => void): () => void;
}
