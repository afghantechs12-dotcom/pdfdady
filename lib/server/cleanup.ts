import { removeJobDir } from "./tempFiles";

/**
 * Removes a job's temporary directory and all files inside it.
 * Always call this in a route's `finally` block so user files never persist.
 */
export async function cleanupJob(jobDir: string | null): Promise<void> {
  if (jobDir) {
    await removeJobDir(jobDir);
  }
}
