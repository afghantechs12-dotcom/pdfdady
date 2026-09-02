import { EventEmitter } from "node:events";
import type {
  IJobEvents,
  ProgressEvent,
} from "@/src/application/ports/queue/JobEvents";

/**
 * In-process IJobEvents — a per-job EventEmitter channel. Single-instance
 * (dev); the Redis adapter (pub/sub) is the cross-process production path. An
 * SSE route subscribes via `onProgress`; the worker emits via `JobContext`.
 */
export class InMemoryJobEvents implements IJobEvents {
  private readonly emitter = new EventEmitter();

  async emitProgress(
    jobId: string,
    pct: number,
    detail?: string,
  ): Promise<void> {
    this.emitter.emit(`progress:${jobId}`, { jobId, pct, detail } as ProgressEvent);
  }

  onProgress(jobId: string, cb: (e: ProgressEvent) => void): () => void {
    const key = `progress:${jobId}`;
    this.emitter.on(key, cb);
    return () => this.emitter.off(key, cb);
  }
}
