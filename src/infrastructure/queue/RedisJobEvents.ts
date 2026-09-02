import Redis from "ioredis";
import type {
  IJobEvents,
  ProgressEvent,
} from "@/src/application/ports/queue/JobEvents";

const channel = (jobId: string) => `pdfdadi:progress:${jobId}`;

/**
 * Redis IJobEvents — progress reporting via pub/sub so a cross-process SSE
 * route can stream job progress to the client. `emitProgress` publishes; a
 * single subscriber connection dispatches messages to per-job listeners. Only
 * constructed when REDIS_URL is set.
 */
export class RedisJobEvents implements IJobEvents {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners = new Map<string, Set<(e: ProgressEvent) => void>>();

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    this.sub.on("message", (ch, message) => {
      const set = this.listeners.get(ch);
      if (!set) return;
      let e: ProgressEvent;
      try {
        e = JSON.parse(message) as ProgressEvent;
      } catch {
        return;
      }
      for (const cb of set) cb(e);
    });
  }

  async emitProgress(jobId: string, pct: number, detail?: string): Promise<void> {
    await this.pub.publish(channel(jobId), JSON.stringify({ jobId, pct, detail }));
  }

  onProgress(jobId: string, cb: (e: ProgressEvent) => void): () => void {
    const ch = channel(jobId);
    let set = this.listeners.get(ch);
    if (!set) {
      set = new Set();
      this.listeners.set(ch, set);
      void this.sub.subscribe(ch);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(ch);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.listeners.delete(ch);
        void this.sub.unsubscribe(ch);
      }
    };
  }
}
