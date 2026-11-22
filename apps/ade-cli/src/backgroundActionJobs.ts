import { createHash } from "node:crypto";

/**
 * Long actions a caller follows instead of holding one request open.
 *
 * A desktop on a slow or unsteady link sends a long action (a lane create, a
 * pull) with `backgroundJob: { id, waitMs }`. This machine starts the action
 * once for that id and answers when it ends or after `waitMs`, whichever is
 * first. "Still running" tells the caller to send the same call again. A call
 * sent again after a dropped link joins the same run, so the action never runs
 * twice and its outcome is never lost. The finished outcome is kept a while
 * for a caller whose last answer was lost.
 */
export { BACKGROUND_JOB_PARAM } from "../../desktop/src/shared/backgroundActionJob";

/** The longest one call waits before it answers "still running". */
export const BACKGROUND_JOB_MAX_WAIT_MS = 30_000;
/** A finished outcome is kept this long for a call sent again. */
const FINISHED_KEEP_MS = 10 * 60_000;
/** Finished outcomes kept at once; the oldest go first. Running jobs always stay. */
const FINISHED_KEEP_MAX = 200;

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

type Job = {
  fingerprint: string;
  promise: Promise<void>;
  settled: Settled | null;
  settledAt: number;
};

export type BackgroundJobOutcome = { state: "running" } | { state: "done"; value: unknown };

export type BackgroundActionJobs = {
  run: (args: {
    key: string;
    /** What the job does; a second call with the same key must match it. */
    fingerprint: string;
    waitMs: number;
    start: () => Promise<unknown>;
  }) => Promise<BackgroundJobOutcome>;
};

/** A short, fixed-size name for one action call: its domain, action and arguments. */
export function backgroundJobFingerprint(domain: string, action: string, args: unknown): string {
  return createHash("sha256").update(JSON.stringify([domain, action, args ?? null])).digest("hex");
}

export function createBackgroundActionJobs(now: () => number = Date.now): BackgroundActionJobs {
  const jobs = new Map<string, Job>();

  const sweep = () => {
    const at = now();
    // Newest finished first: the oldest outcomes go, whatever order the jobs
    // were created in. A job that started early and ran long keeps its answer.
    const finished = [...jobs.entries()]
      .filter(([, job]) => job.settled)
      .sort((left, right) => right[1].settledAt - left[1].settledAt);
    finished.forEach(([key, job], index) => {
      if (index >= FINISHED_KEEP_MAX || at - job.settledAt > FINISHED_KEEP_MS) jobs.delete(key);
    });
  };

  return {
    async run({ key, fingerprint, waitMs, start }) {
      sweep();
      let job = jobs.get(key);
      if (job && job.fingerprint !== fingerprint) {
        throw new Error("This background job id already names another action.");
      }
      if (!job) {
        const created: Job = { fingerprint, promise: Promise.resolve(), settled: null, settledAt: 0 };
        created.promise = Promise.resolve()
          .then(start)
          .then(
            (value) => {
              created.settled = { ok: true, value };
              created.settledAt = now();
            },
            (error: unknown) => {
              created.settled = { ok: false, error };
              created.settledAt = now();
            },
          );
        jobs.set(key, created);
        job = created;
      }
      if (!job.settled) {
        const wait = Math.max(0, Math.min(BACKGROUND_JOB_MAX_WAIT_MS, waitMs));
        let timer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          job.promise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, wait);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      const settled = job.settled as Settled | null;
      if (!settled) return { state: "running" };
      if (!settled.ok) throw settled.error;
      return { state: "done", value: settled.value };
    },
  };
}
