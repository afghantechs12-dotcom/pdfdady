/**
 * In-process concurrency limiter for the server-side tool API. Native document
 * conversions (LibreOffice, Ghostscript, OCR) are CPU- and memory-heavy; a
 * burst of uploads can exhaust the box. This caps simultaneous jobs and makes
 * excess requests wait briefly, then rejects if the queue is saturated.
 *
 * This is a single-instance guard. Behind multiple instances, enforce limits at
 * the load balancer / a shared queue as well.
 */

// Guard against a misconfigured env var: NaN or <= 0 would make every request
// queue for MAX_WAIT_MS and then 503, silently disabling all server tools.
const parsedMax = Number(process.env.TOOLS_MAX_CONCURRENCY);
const MAX_CONCURRENT =
  Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 4;
const MAX_WAIT_MS = 20_000;

let active = 0;
const waiters: Array<() => void> = [];

export class TooBusyError extends Error {
  constructor() {
    super("The server is busy processing other files. Please try again shortly.");
    this.name = "TooBusyError";
  }
}

/** Acquires a slot or throws TooBusyError if none frees up in time. */
export async function acquireSlot(): Promise<() => void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return release;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    const onFree = () => {
      if (timer) clearTimeout(timer);
      active++;
      resolve();
    };
    waiters.push(onFree);
    timer = setTimeout(() => {
      const idx = waiters.indexOf(onFree);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(new TooBusyError());
    }, MAX_WAIT_MS);
  });
  return release;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}
