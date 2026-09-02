import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Thrown when a command is killed because its AbortSignal fired (job
 * cancellation). Distinct from CommandError so callers can map it to a
 * "cancelled" outcome rather than a generic processing failure.
 */
export class CommandAbortedError extends Error {
  constructor() {
    super("Command aborted.");
    this.name = "CommandAbortedError";
  }
}

/**
 * Safely runs an external binary using execFile with an ARGUMENT ARRAY.
 * User input is never interpolated into a shell string, which prevents
 * command injection. A timeout guards against hung processes. An optional
 * AbortSignal lets the caller kill a running process mid-flight (used by the
 * job worker to implement cancellation): on abort the child is SIGKILLed and
 * the promise rejects with CommandAbortedError.
 */
export function runCommand(
  binary: string,
  args: string[],
  options: {
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const { timeoutMs = 120_000, cwd, env, signal } = options;

  return new Promise((resolve, reject) => {
    let aborted = false;
    let onAbort: (() => void) | undefined;

    const child = execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        if (aborted) {
          reject(new CommandAbortedError());
          return;
        }
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number };
          if (err.code === "ENOENT") {
            reject(
              new CommandError(
                `Binary "${binary}" was not found.`,
                stderr?.toString() ?? "",
                null,
              ),
            );
            return;
          }
          reject(
            new CommandError(
              `Command "${binary}" failed.`,
              stderr?.toString() ?? "",
              typeof err.code === "number" ? err.code : null,
            ),
          );
          return;
        }
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      },
    );

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* process already exited */
        }
      } else {
        onAbort = () => {
          aborted = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* process already exited */
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
