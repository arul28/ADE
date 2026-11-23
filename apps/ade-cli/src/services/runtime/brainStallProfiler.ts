import * as inspector from "node:inspector";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { captureProblem } from "../../../../desktop/src/shared/sentry/capture";
import { BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS } from "./brainLoopWatchdog";
import { BRAIN_LOOP_FREEZE_LIMITS, brainLoopFreezeCause } from "./brainLoopWatchdogWorker";

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
 * another freeze start during the profile, at most once per cause in a
 * brain's life, and only when the brain froze itself: while the machine is
 * paging the brain back in from swap, any code it happens to be in stalls,
 * and the profile names that code for nothing.
 *
 * The brain is a minified bundle, so the profile's own names (`Zji
 * cli.cjs:1263:132`) change with every build; an issue titled or grouped by
 * them is a new issue, and an email, per build (ADE-BRAIN-8D … 95). The issue
 * is grouped by what kind of work held the loop (a SQLite query, a process
 * start, a file call, network interfaces, garbage collection, ADE's own
 * code), which every build names the same. The heaviest stack goes along as
 * the event's stack trace, which Sentry maps back to ADE's source through the
 * bundle's source map, so each event still shows the code to fix.
 */

const PROFILE_MS = 60_000;
const PROFILE_COOLDOWN_MS = 60 * 60_000;
/** Sampling interval in microseconds; coarse on purpose, a freeze is seconds long. */
const PROFILE_SAMPLING_US = 2_000;
/** A run of busy samples at least this long is a freeze, not ordinary work. */
const MIN_RUN_MS = 1_000;
/** Frames kept from the heaviest stack, leaf first. */
const STACK_FRAMES_KEPT = 12;
/** Frames the event's stack trace carries: enough to reach the ADE code that called in. */
const TRACE_FRAMES_KEPT = 40;
const TOP_FRAMES_KEPT = 5;
/**
 * How long a finished profile waits for the watchdog's word on a freeze that
 * started inside it. The watchdog holds a lag that looks like a sleep for up
 * to 3 s (`BRAIN_LOOP_SLEEP_PROOF_GRACE_MS`) before it says it was a freeze.
 */
const LATE_STALL_WAIT_MS = 10_000;

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
  /** What kind of work held the loop; the same in every build. */
  cause: BrainStallCause;
  /** The innermost frame of the heaviest stack whose name survives minification (`getStatus`), or null. */
  anchor: string | null;
  /** The heaviest stack as the profile has it, leaf first, for the event's stack trace. */
  frames: CallFrame[];
  /** Stable grouping for one cause: the same in every build. */
  fingerprint: string[];
};

/**
 * What kind of work held the loop. `library:<package>` names a dependency's
 * own code; everything else is a closed list.
 */
type BrainStallCause = FixedBrainStallCause | `library:${string}`;

/** The words after "Brain froze in" for each cause; a new cause must name its title here. */
const FIXED_CAUSE_TITLES = {
  sqlite: "a SQLite query",
  "process-spawn": "a child process call",
  "file-system": "a synchronous file call",
  "network-interfaces": "reading the network interfaces",
  os: "an operating system call",
  "garbage-collection": "garbage collection",
  crypto: "hashing or crypto",
  network: "a network request",
  "worker-message": "a worker message",
  "node-internals": "Node's own code",
  "ade-code": "ADE code",
  unknown: "unknown code",
} as const;

type FixedBrainStallCause = keyof typeof FIXED_CAUSE_TITLES;

function causeTitle(cause: BrainStallCause): string {
  return cause.startsWith("library:")
    ? `the ${cause.slice("library:".length)} package`
    : FIXED_CAUSE_TITLES[cause as FixedBrainStallCause];
}

const IDLE = "(idle)";
const GARBAGE_COLLECTOR = "(garbage collector)";
const NON_CODE = new Set(["(root)", "(program)", GARBAGE_COLLECTOR, IDLE]);
/** Frames that cannot name a freeze. Garbage collection can: a freeze that is mostly GC is named after it. */
const NOT_A_CAUSE = new Set(["(root)", "(program)", IDLE]);

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

/** node:sqlite's native statement and database methods, as the profiler names them (no script). */
const SQLITE_NATIVE_METHODS = new Set(["prepare", "all", "get", "run", "exec", "iterate"]);

/** `fs` for `node:fs`, `child_process` for `node:internal/child_process`, `crypto` for `node:internal/crypto/hash`. */
function nodeModuleOf(url: string): string | null {
  if (!url.startsWith("node:")) return null;
  const parts = url.slice("node:".length).split("/");
  if (parts[0] === "internal" || parts[0] === "electron") {
    // `node:internal/deps/undici/undici` is undici; `node:internal/fs/utils` is fs.
    return parts[1] === "deps" ? parts[2] ?? null : parts[1] ?? null;
  }
  return parts[0] ?? null;
}

/** The npm package a script belongs to, from the last `node_modules` in its path. */
function packageOf(url: string): string | null {
  const match = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*[\\/]node_modules[\\/])/.exec(url);
  return match ? match[1]!.replace(/\\/g, "/") : null;
}

function causeOfNodeModule(module: string, frames: readonly CallFrame[]): BrainStallCause {
  if (module === "fs") return "file-system";
  if (module === "child_process") return "process-spawn";
  if (module === "os") return frames.some((frame) => frame.functionName === "networkInterfaces") ? "network-interfaces" : "os";
  if (module === "crypto") return "crypto";
  if (/^(?:net|http|https|_http_\w+|tls|_tls_\w+|dns|undici)$/.test(module)) return "network";
  if (module === "worker" || module === "worker_threads") return "worker-message";
  return "node-internals";
}

/**
 * What the heaviest stack was doing, read from the leaf outwards: the first
 * Node module on it before ADE's own code (a native call is named by the Node
 * function that made it), then node:sqlite's native methods, then whose
 * script the code is.
 */
function stallCause(frames: readonly CallFrame[]): BrainStallCause {
  const leaf = frames[0];
  if (!leaf) return "unknown";
  if (leaf.functionName === GARBAGE_COLLECTOR) return "garbage-collection";
  for (const frame of frames) {
    if (isAdeFrame(frame)) break;
    const module = nodeModuleOf(frame.url);
    if (module) return causeOfNodeModule(module, frames);
  }
  if (!leaf.url && SQLITE_NATIVE_METHODS.has(leaf.functionName)) return "sqlite";
  const code = frames.find(isAdeFrame);
  if (!code) return "unknown";
  const pkg = packageOf(code.url);
  return pkg ? `library:${pkg}` : "ade-code";
}

/** The script path a stack trace would print for a profile URL (`file:///…` → `/…`, `C:\…` on Windows). */
function scriptPathOf(url: string): string {
  if (!url.startsWith("file:")) return url;
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

/**
 * The heaviest stack as a V8 stack trace, so the SDK attaches the bundle's
 * debug id and Sentry resolves each frame through the source map. A profile
 * frame's position is where its function starts, which resolves to that
 * function in ADE's source.
 */
function stallStackTrace(title: string, frames: readonly CallFrame[]): string | null {
  const lines = frames.slice(0, TRACE_FRAMES_KEPT).flatMap((frame) => {
    if (NON_CODE.has(frame.functionName)) return [];
    if (!frame.url) return frame.functionName ? [`    at ${frame.functionName} (native)`] : [];
    const location = `${scriptPathOf(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    return [frame.functionName ? `    at ${frame.functionName} (${location})` : `    at ${location}`];
  });
  return lines.length > 0 ? `AdeProblem: ${title}\n${lines.join("\n")}` : null;
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

  // The freezes long enough to report name the cause; shorter runs only when
  // there is no such freeze. Five 1.1 s calls must not outweigh one 3 s freeze.
  const nearMisses = runs.filter((run) => run.ms >= BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS);
  const blamed = nearMisses.length > 0 ? nearMisses : runs;
  // Time per leaf node and self time per frame, inside those runs only.
  const leafUs = new Map<number, number>();
  const selfUs = new Map<string, number>();
  for (const run of blamed) {
    for (let index = run.start; index < run.end; index += 1) {
      const id = samples[index]!;
      const us = Math.max(0, deltas[index + 1] ?? deltas[index] ?? 0);
      leafUs.set(id, (leafUs.get(id) ?? 0) + us);
      const node = byId.get(id);
      if (node && !NOT_A_CAUSE.has(node.callFrame.functionName)) {
        const label = frameLabel(node.callFrame);
        selfUs.set(label, (selfUs.get(label) ?? 0) + us);
      }
    }
  }
  // The heaviest stack: the leaf node with the most time, then its callers.
  let heaviest: number | null = null;
  for (const [id, us] of leafUs) {
    const node = byId.get(id);
    if (!node || NOT_A_CAUSE.has(node.callFrame.functionName)) continue;
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
  const cause = stallCause(frames);
  const anchor = frames.slice(0, TRACE_FRAMES_KEPT).find((frame) => isAdeFrame(frame) && stableName(frame.functionName))?.functionName ?? null;
  // The cause alone for Node's and SQLite's work: the stack trace says which
  // ADE code asked. ADE's own code and a package's are split by the anchor,
  // since two of them freezing are two bugs.
  const splitByAnchor = cause === "ade-code" || cause.startsWith("library:");
  const fingerprint = ["brain-stall", cause, ...(splitByAnchor && anchor ? [anchor] : [])];
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
    cause,
    anchor,
    frames,
    fingerprint,
  };
}

export type BrainStallProfiler = {
  /**
   * The watchdog saw a freeze that started `startedAgoMs` ago: profile the
   * next minute, unless one ran within the hour.
   */
  noteStall(stall: { startedAgoMs: number }): void;
  dispose(): void;
};

type UsageSample = { majorFaults: number; cpuMs: number; atMs: number };

type MachinePressure = {
  freezeCause: ReturnType<typeof brainLoopFreezeCause>;
  majorFaultsPer30s: number | null;
  cpuMs: number;
};

function usageNow(): UsageSample {
  const usage = process.resourceUsage();
  return {
    majorFaults: usage.majorPageFault,
    cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1_000,
    atMs: performance.now(),
  };
}

/**
 * Who froze the brain during the profile, by the watchdog's own rule
 * (brainLoopFreezeCause): memory when it read pages back from swap at a
 * starved rate. Only major faults count here: the minor-fault rule needs the
 * CPU share of the freeze alone, and the profile's minute also holds idle
 * time. libuv counts every Windows fault as major, so Windows is never
 * judged memory-starved.
 */
function machinePressure(start: UsageSample): MachinePressure {
  const end = usageNow();
  const windowMs = Math.max(1, end.atMs - start.atMs);
  const majorFaults = Math.max(0, end.majorFaults - start.majorFaults);
  const cpuMs = Math.max(0, end.cpuMs - start.cpuMs);
  const faultsMeaningful = process.platform !== "win32";
  return {
    freezeCause: brainLoopFreezeCause({
      majorFaults: faultsMeaningful ? majorFaults : null,
      minorFaults: null,
      cpuMs,
      windowMs,
      syncFsCallBlockedMs: null,
    }, BRAIN_LOOP_FREEZE_LIMITS),
    majorFaultsPer30s: faultsMeaningful ? Math.round((majorFaults * 30_000) / windowMs) : null,
    cpuMs: Math.round(cpuMs),
  };
}

/**
 * `log` gets the summary as a log line (`brain.stall_profile`); the logger
 * mirrors it to Sentry Logs.
 */
export function createBrainStallProfiler(deps: {
  log: (event: string, meta: Record<string, unknown>) => void;
}): BrainStallProfiler {
  let lastStartedAt: number | null = null;
  let session: inspector.Session | null = null;
  /** Process counters when the profile started: what paging the minute cost. */
  let usageAtStart: UsageSample | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Freezes the watchdog saw while the profile ran. */
  let stallsInProfile = 0;
  /** A finished profile that caught a freeze, waiting for the watchdog's late word on it. */
  let awaitingStall: {
    summary: BrainStallProfileSummary;
    pressure: MachinePressure | null;
    stoppedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let disposed = false;
  const reportedCauses = new Set<string>();

  const stopAwaitingStall = () => {
    if (awaitingStall) clearTimeout(awaitingStall.timer);
    awaitingStall = null;
  };

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

  /** A freeze in the profile long enough to be a near miss. */
  const reportable = (summary: BrainStallProfileSummary) => summary.longestRunMs >= BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS;


  /** One Sentry issue for each cause the brain owns. */
  const report = (summary: BrainStallProfileSummary, pressure: MachinePressure | null) => {
    if (pressure?.freezeCause === "memory") return;
    const key = summary.fingerprint.join("|");
    if (reportedCauses.has(key)) return;
    reportedCauses.add(key);
    const title = `Brain froze in ${causeTitle(summary.cause)}`;
    const memory = process.memoryUsage();
    captureProblem(title, {
      level: "warning",
      stack: stallStackTrace(title, summary.frames),
      fingerprint: summary.fingerprint,
      tags: { stall_cause: summary.cause, stall_leaf: summary.leafName, stall_anchor: summary.anchor },
      extra: {
        // The minified names, for a build whose source map Sentry lacks.
        culprit: summary.culprit,
        leaf: summary.leaf,
        frozenMs: summary.frozenMs,
        runs: summary.runs,
        longestRunMs: summary.longestRunMs,
        stack: summary.stack,
        topFrames: summary.topFrames,
        freezeCause: pressure?.freezeCause ?? null,
        majorFaultsPer30s: pressure?.majorFaultsPer30s ?? null,
        cpuMsInProfile: pressure?.cpuMs ?? null,
        // A garbage-collection freeze is about the heap's size.
        heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
        heapTotalMb: Math.round(memory.heapTotal / 1_048_576),
        rssMb: Math.round(memory.rss / 1_048_576),
      },
    });
  };

  const finish = async (target: inspector.Session) => {
    try {
      const stopped = (await post(target, "Profiler.stop")) as { profile?: BrainCpuProfile } | undefined;
      // Read after the stop: a freeze noted while it ran is in the profile.
      const sawStall = stallsInProfile > 0;
      const pressure = usageAtStart ? machinePressure(usageAtStart) : null;
      const summary = stopped?.profile ? summarizeBrainStallProfile(stopped.profile) : null;
      if (!summary) {
        deps.log("brain.stall_profile", { caught: false, profiledMs: PROFILE_MS, stallsInProfile, ...pressure });
        return;
      }
      deps.log("brain.stall_profile", {
        caught: true,
        profiledMs: PROFILE_MS,
        stallsInProfile,
        ...pressure,
        frozenMs: summary.frozenMs,
        runs: summary.runs,
        longestRunMs: summary.longestRunMs,
        cause: summary.cause,
        culprit: summary.culprit,
        leaf: summary.leaf,
        stack: summary.stack.join(" < "),
        topFrames: summary.topFrames.map((entry) => `${entry.frame} ${entry.ms}ms`).join(" | "),
      });
      if (!reportable(summary) || disposed) return;
      if (sawStall) {
        report(summary, pressure);
        return;
      }
      // A freeze that ended just before the stop reaches `noteStall` later
      // (one loop turn, or seconds for a lag the watchdog held).
      stopAwaitingStall();
      const timer = setTimeout(stopAwaitingStall, LATE_STALL_WAIT_MS);
      timer.unref?.();
      awaitingStall = { summary, pressure, stoppedAt: performance.now(), timer };
    } catch (error) {
      logFailure(error);
    } finally {
      if (session === target) end();
    }
  };

  return {
    noteStall({ startedAgoMs }) {
      if (disposed) return;
      if (session) {
        stallsInProfile += 1;
        return;
      }
      if (awaitingStall && performance.now() - startedAgoMs <= awaitingStall.stoppedAt) {
        const { summary, pressure } = awaitingStall;
        stopAwaitingStall();
        report(summary, pressure);
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
          usageAtStart = usageNow();
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
      stopAwaitingStall();
      end();
    },
  };
}
