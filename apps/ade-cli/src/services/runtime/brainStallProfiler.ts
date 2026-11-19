import * as inspector from "node:inspector";
import { captureProblem } from "../../../../desktop/src/shared/sentry/capture";
import { BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS } from "./brainLoopWatchdog";

/**
 * Names the code behind a brain freeze.
 *
 * The loop watchdog (`brainLoopWatchdog.ts`) sees that the event loop froze
 * and how much CPU it spent, but not which code froze it. Freezes repeat (a
 * poll that runs a slow query every 30 s froze one brain for 10 s every 40 s),
 * so after a freeze this profiles the process for a minute, in process (no
 * debug port). A freeze shows in the profile as a long run of samples with
 * JavaScript on the stack and no idle sample between them: a blocking call
 * (SQLite, a sync file read, a sync spawn) keeps its JavaScript caller on the
 * stack while it waits, so both busy and waiting freezes are named.
 *
 * At most one profile an hour, and only after a freeze, so a healthy brain
 * never profiles. A cause becomes a Sentry issue only when the watchdog saw
 * another freeze during the profile, at most once per cause in a brain's life.
 */

const PROFILE_MS = 60_000;
const PROFILE_COOLDOWN_MS = 60 * 60_000;
/** Sampling interval in microseconds; coarse on purpose, a freeze is seconds long. */
const PROFILE_SAMPLING_US = 2_000;
/** A run of busy samples at least this long is a freeze, not ordinary work. */
const MIN_RUN_MS = 1_000;
/** Frames kept from the heaviest stack, leaf first. */
const STACK_FRAMES_KEPT = 12;
const TOP_FRAMES_KEPT = 5;

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] };
type BrainCpuProfile = {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
};

type BrainStallProfileSummary = {
  /** Time covered by long busy runs: the freezes the profile caught. */
  frozenMs: number;
  runs: number;
  longestRunMs: number;
  /** The deepest ADE frame of the heaviest stack: the code to fix. */
  culprit: string | null;
  /** The frame the culprit was inside: `all` (SQLite), `readFileSync`, `spawnSync`, or ADE code itself. */
  leaf: string | null;
  /** The leaf's function name alone, for grouping in Sentry. */
  leafName: string | null;
  /** The heaviest stack in the freezes, leaf first. */
  stack: string[];
  /** The frames with the most self time in the freezes. */
  topFrames: Array<{ frame: string; ms: number }>;
  /** Stable grouping for one cause: same culprit, same issue. */
  fingerprint: string[];
};

const IDLE = "(idle)";
const NON_CODE = new Set(["(root)", "(program)", "(garbage collector)", IDLE]);

function fileName(url: string): string {
  if (!url) return "";
  if (url.startsWith("node:")) return url;
  const parts = url.split(/[\\/]/);
  return parts[parts.length - 1] ?? url;
}

function frameLabel(frame: CallFrame): string {
  const name = frame.functionName || "(anonymous)";
  const file = fileName(frame.url);
  return file ? `${name} ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : name;
}

/** ADE's own code: a script with a file, not Node's internals and not native. */
function isAdeFrame(frame: CallFrame): boolean {
  return Boolean(frame.url) && !frame.url.startsWith("node:") && !NON_CODE.has(frame.functionName);
}

/** A minified bundle renames most functions to two or three letters: those do not group across releases. */
function stableName(name: string): boolean {
  return name.length >= 4 && name !== "(anonymous)";
}

function summarizeBrainStallProfile(profile: BrainCpuProfile): BrainStallProfileSummary | null {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length === 0) return null;
  const byId = new Map(profile.nodes.map((node) => [node.id, node] as const));
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);

  // Long runs of busy samples, as [start, end) sample indexes.
  const runs: Array<{ start: number; end: number; ms: number }> = [];
  let start = -1;
  let runUs = 0;
  const closeRun = (end: number) => {
    if (start >= 0 && runUs / 1_000 >= MIN_RUN_MS) runs.push({ start, end, ms: runUs / 1_000 });
    start = -1;
    runUs = 0;
  };
  for (let index = 0; index < samples.length; index += 1) {
    const node = byId.get(samples[index]!);
    const idle = !node || node.callFrame.functionName === IDLE;
    if (idle) {
      closeRun(index);
      continue;
    }
    if (start < 0) start = index;
    else runUs += Math.max(0, deltas[index] ?? 0);
  }
  closeRun(samples.length);
  if (runs.length === 0) return null;

  // Time per leaf node and self time per frame, inside the runs only.
  const leafUs = new Map<number, number>();
  const selfUs = new Map<string, number>();
  for (const run of runs) {
    for (let index = run.start; index < run.end; index += 1) {
      const id = samples[index]!;
      const us = Math.max(0, deltas[index + 1] ?? deltas[index] ?? 0);
      leafUs.set(id, (leafUs.get(id) ?? 0) + us);
      const node = byId.get(id);
      if (node && !NON_CODE.has(node.callFrame.functionName)) {
        const label = frameLabel(node.callFrame);
        selfUs.set(label, (selfUs.get(label) ?? 0) + us);
      }
    }
  }
  // The heaviest stack: the leaf node with the most time, then its callers.
  let heaviest: number | null = null;
  for (const [id, us] of leafUs) {
    const node = byId.get(id);
    if (!node || NON_CODE.has(node.callFrame.functionName)) continue;
    if (heaviest == null || us > (leafUs.get(heaviest) ?? 0)) heaviest = id;
  }
  const frames: CallFrame[] = [];
  for (let id: number | undefined = heaviest ?? undefined; id != null; id = parentOf.get(id)) {
    const node = byId.get(id);
    if (!node || node.callFrame.functionName === "(root)") break;
    frames.push(node.callFrame);
  }
  const culpritFrame = frames.find(isAdeFrame) ?? null;
  const leafFrame = frames[0] ?? null;
  const fingerprint = culpritFrame
    ? stableName(culpritFrame.functionName)
      ? ["brain-stall", culpritFrame.functionName, fileName(culpritFrame.url)]
      : ["brain-stall", frameLabel(culpritFrame)]
    : ["brain-stall", leafFrame ? frameLabel(leafFrame) : "unknown"];
  return {
    frozenMs: Math.round(runs.reduce((sum, run) => sum + run.ms, 0)),
    runs: runs.length,
    longestRunMs: Math.round(Math.max(...runs.map((run) => run.ms))),
    culprit: culpritFrame ? frameLabel(culpritFrame) : null,
    leaf: leafFrame ? frameLabel(leafFrame) : null,
    leafName: leafFrame ? leafFrame.functionName || "(anonymous)" : null,
    stack: frames.slice(0, STACK_FRAMES_KEPT).map(frameLabel),
    topFrames: [...selfUs]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_FRAMES_KEPT)
      .map(([frame, us]) => ({ frame, ms: Math.round(us / 1_000) })),
    fingerprint,
  };
}

export type BrainStallProfiler = {
  /** A freeze ended: profile the next minute, unless one ran within the hour. */
  noteStall(): void;
  dispose(): void;
};

/**
 * `log` gets the summary as a log line (`brain.stall_profile`); the logger
 * mirrors it to Sentry Logs.
 */
export function createBrainStallProfiler(deps: {
  log: (event: string, meta: Record<string, unknown>) => void;
}): BrainStallProfiler {
  let lastStartedAt: number | null = null;
  let session: inspector.Session | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Freezes the watchdog saw while the profile ran. */
  let stallsInProfile = 0;
  let disposed = false;
  const reportedCauses = new Set<string>();

  const post = (target: inspector.Session, method: string, params?: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      target.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
    });

  const logFailure = (error: unknown) => {
    // Stopping the brain disconnects the session under a profile in flight.
    if (disposed) return;
    deps.log("brain.stall_profile_failed", { error: error instanceof Error ? error.message : String(error) });
  };

  const end = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      session?.disconnect();
    } catch {
      // Already gone.
    }
    session = null;
  };

  /** One Sentry issue for each cause, and only for a freeze long enough to be a near miss. */
  const report = (summary: BrainStallProfileSummary, sawStall: boolean) => {
    const key = summary.fingerprint.join("|");
    if (!sawStall || summary.longestRunMs < BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS || reportedCauses.has(key)) return;
    reportedCauses.add(key);
    captureProblem(`Brain froze in ${summary.culprit ?? summary.leaf ?? "unknown code"}`, {
      level: "warning",
      fingerprint: summary.fingerprint,
      tags: { stall_leaf: summary.leafName },
      extra: {
        frozenMs: summary.frozenMs,
        runs: summary.runs,
        longestRunMs: summary.longestRunMs,
        stack: summary.stack,
        topFrames: summary.topFrames,
      },
    });
  };

  const finish = async (target: inspector.Session) => {
    const sawStall = stallsInProfile > 0;
    try {
      const stopped = (await post(target, "Profiler.stop")) as { profile?: BrainCpuProfile } | undefined;
      const summary = stopped?.profile ? summarizeBrainStallProfile(stopped.profile) : null;
      if (!summary) {
        deps.log("brain.stall_profile", { caught: false, profiledMs: PROFILE_MS, stallsInProfile });
        return;
      }
      deps.log("brain.stall_profile", {
        caught: true,
        profiledMs: PROFILE_MS,
        stallsInProfile,
        frozenMs: summary.frozenMs,
        runs: summary.runs,
        longestRunMs: summary.longestRunMs,
        culprit: summary.culprit,
        leaf: summary.leaf,
        stack: summary.stack.join(" < "),
        topFrames: summary.topFrames.map((entry) => `${entry.frame} ${entry.ms}ms`).join(" | "),
      });
      report(summary, sawStall);
    } catch (error) {
      logFailure(error);
    } finally {
      if (session === target) end();
    }
  };

  return {
    noteStall() {
      if (disposed) return;
      if (session) {
        stallsInProfile += 1;
        return;
      }
      if (process.env.ADE_DISABLE_STALL_PROFILE === "1") return;
      const startedAt = Date.now();
      if (lastStartedAt != null && startedAt - lastStartedAt < PROFILE_COOLDOWN_MS) return;
      lastStartedAt = startedAt;
      stallsInProfile = 0;
      let target: inspector.Session;
      try {
        target = new inspector.Session();
        target.connect();
      } catch (error) {
        logFailure(error);
        return;
      }
      session = target;
      void (async () => {
        try {
          await post(target, "Profiler.enable");
          await post(target, "Profiler.setSamplingInterval", { interval: PROFILE_SAMPLING_US });
          await post(target, "Profiler.start");
        } catch (error) {
          logFailure(error);
          if (session === target) end();
          return;
        }
        if (disposed || session !== target) return;
        timer = setTimeout(() => void finish(target), PROFILE_MS);
        timer.unref?.();
      })();
    },
    dispose() {
      disposed = true;
      end();
    },
  };
}
