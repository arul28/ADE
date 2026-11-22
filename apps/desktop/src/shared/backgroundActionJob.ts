/**
 * The `ade/actions/call` param that asks a brain to run a long action as a
 * job the caller follows (`apps/ade-cli/src/backgroundActionJobs.ts`):
 * `{ id, waitMs }`. A brain that announces `backgroundActionJobs` honours it.
 */
export const BACKGROUND_JOB_PARAM = "backgroundJob";

/** The answer field that says the job still runs: send the same call again. */
export type BackgroundJobRunningReply = { backgroundJob: { id: string; state: "running" } };

export function isBackgroundJobRunningReply(value: Record<string, unknown>): boolean {
  const job = value.backgroundJob;
  return Boolean(job && typeof job === "object" && (job as { state?: unknown }).state === "running");
}
