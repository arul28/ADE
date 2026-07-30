import { spawn } from "node:child_process";
import type {
  AppResourceProcessRole,
  AppResourceProcessSampleInfo,
  AppResourceRoleUsage,
  AppResourceUsageSnapshot,
  PtyProcessResourceUsageSnapshot,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Machine process sampling (asynchronous, coalesced, bounded)
// ---------------------------------------------------------------------------

export type ProcessMetricRow = {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssKB: number;
};

const PROCESS_SAMPLE_TIMEOUT_MS = 1_000;
const PROCESS_SAMPLE_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const PROCESS_TREE_MAX_DEPTH = 12;

export function parseProcessMetricRows(stdout: string): ProcessMetricRow[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ppidRaw, cpuRaw, rssRaw] = line.split(/\s+/u);
      const pid = Number.parseInt(pidRaw ?? "", 10);
      const ppid = Number.parseInt(ppidRaw ?? "", 10);
      const cpuPercent = Number.parseFloat(cpuRaw ?? "");
      const rssKB = Number.parseInt(rssRaw ?? "", 10);
      if (
        !Number.isFinite(pid)
        || pid <= 0
        || !Number.isFinite(ppid)
        || ppid < 0
        || !Number.isFinite(cpuPercent)
        || !Number.isFinite(rssKB)
        || rssKB < 0
      ) {
        return null;
      }
      return { pid, ppid, cpuPercent, rssKB };
    })
    .filter((row): row is ProcessMetricRow => row != null);
}

export type ProcessMetricSample = {
  rows: ProcessMetricRow[] | null;
  status: "ok" | "unavailable";
  reason:
    | "timeout"
    | "spawn-error"
    | "exit-code"
    | "oversized-output"
    | "unsupported-platform"
    | null;
  sampledAt: string;
  durationMs: number;
};

export type ProcessMetricRowsCollector = {
  /** Coalesces callers onto a single in-flight process sample; never rejects. */
  collect(): Promise<ProcessMetricSample>;
  /** Kills any in-flight child. Subsequent collect() calls start fresh. */
  dispose(): void;
};

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    stdio: ["ignore", "pipe", "ignore"];
    windowsHide: boolean;
  },
) => {
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

export type ProcessMetricRowsCollectorOptions = {
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
};

export function createProcessMetricRowsCollector(
  options: ProcessMetricRowsCollectorOptions = {},
): ProcessMetricRowsCollector {
  const spawnImpl: SpawnLike = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const timeoutMs = options.timeoutMs ?? PROCESS_SAMPLE_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? PROCESS_SAMPLE_MAX_STDOUT_BYTES;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;

  let inFlight: Promise<ProcessMetricSample> | null = null;
  let activeChild: ReturnType<SpawnLike> | null = null;
  let disposed = false;

  const runSample = (): Promise<ProcessMetricSample> => new Promise((resolve) => {
    const startedAtMs = now();
    if (platform === "win32") {
      resolve({
        rows: null,
        status: "unavailable",
        reason: "unsupported-platform",
        sampledAt: new Date(startedAtMs).toISOString(),
        durationMs: 0,
      });
      return;
    }
    let settled = false;
    let stdoutBytes = 0;
    const chunks: string[] = [];
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let child: ReturnType<SpawnLike> | null = null;

    const finish = (
      rows: ProcessMetricRow[] | null,
      reason: ProcessMetricSample["reason"],
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (activeChild === child) activeChild = null;
      resolve({
        rows,
        status: rows ? "ok" : "unavailable",
        reason: rows ? null : reason,
        sampledAt: new Date(startedAtMs).toISOString(),
        durationMs: Math.max(0, now() - startedAtMs),
      });
    };

    const killChild = () => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Best effort; the child may already be gone.
      }
    };

    try {
      child = spawnImpl("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(null, "spawn-error");
      return;
    }
    activeChild = child;

    timeoutTimer = setTimeout(() => {
      killChild();
      finish(null, "timeout");
    }, timeoutMs);

    child.on("error", () => {
      finish(null, "spawn-error");
    });
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutBytes += text.length;
      if (stdoutBytes > maxStdoutBytes) {
        killChild();
        finish(null, "oversized-output");
        return;
      }
      chunks.push(text);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(null, "exit-code");
        return;
      }
      finish(parseProcessMetricRows(chunks.join("")), null);
    });
  });

  return {
    collect(): Promise<ProcessMetricSample> {
      if (disposed) {
        return Promise.resolve({
          rows: null,
          status: "unavailable",
          reason: "spawn-error",
          sampledAt: new Date(now()).toISOString(),
          durationMs: 0,
        });
      }
      if (inFlight) return inFlight;
      const sample = runSample().finally(() => {
        if (inFlight === sample) inFlight = null;
      });
      inFlight = sample;
      return sample;
    },
    dispose(): void {
      disposed = true;
      try {
        activeChild?.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      activeChild = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Disjoint process-role attribution
// ---------------------------------------------------------------------------

export type ResourceAttributionRootKind = "provider-agent" | "shell" | "unknown";

export type ResourceAttributionRoot = {
  pid: number;
  kind: ResourceAttributionRootKind;
};

export type ProcessRoleClassificationInput = {
  rows: ProcessMetricRow[] | null;
  /** PIDs owned by Electron (main/renderer/helper); claimed first and excluded from all tree walks. */
  electronPids: number[];
  /** ADE brain/runtime root PIDs (spawned or supervised by this desktop process). */
  adeRuntimePids: number[];
  /** Live PTY-owning ADE peer processes (session owners that are not the runtime pool roots). */
  adePtyHostPids: number[];
  /** Desktop-owned PTY roots with their explicit spawn metadata. */
  desktopPtyRoots: ResourceAttributionRoot[];
  activePtyCount: number;
};

export type ProcessRoleClassification = {
  /** Non-Electron role buckets, disjoint by construction. */
  roleUsage: AppResourceRoleUsage[];
  /** Legacy aggregate over every classified non-Electron PID (same tree membership as the historical sampler). */
  ptyUsage: PtyProcessResourceUsageSnapshot;
};

function roundUsageMetric(value: number | null | undefined, digits = 1): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizePids(pids: number[]): number[] {
  return Array.from(new Set(
    pids
      .map((pid) => Math.trunc(pid))
      .filter((pid) => Number.isFinite(pid) && pid > 0),
  ));
}

type RoleAccumulator = { processCount: number; cpuPercent: number; rssKB: number };

const NON_ELECTRON_ROLES: AppResourceProcessRole[] = [
  "ade-runtime",
  "ade-pty-host",
  "provider-agent",
  "shell",
  "unknown",
];

export function classifyProcessRoles(input: ProcessRoleClassificationInput): ProcessRoleClassification {
  const activePtyCount = Math.max(0, Math.trunc(input.activePtyCount));
  const emptyRoleUsage = NON_ELECTRON_ROLES.map((role) => ({
    role,
    processCount: 0,
    cpuPercent: null,
    memoryMB: null,
  }));
  const hasRoots = input.adeRuntimePids.length > 0
    || input.adePtyHostPids.length > 0
    || input.desktopPtyRoots.length > 0;

  if (!input.rows) {
    return {
      roleUsage: emptyRoleUsage,
      ptyUsage: activePtyCount === 0 && !hasRoots
        ? { activePtyCount: 0, ptyProcessCount: 0, ptyCpuPercent: 0, ptyMemoryMB: 0 }
        : { activePtyCount, ptyProcessCount: 0, ptyCpuPercent: null, ptyMemoryMB: null },
    };
  }

  const rowsByPid = new Map<number, ProcessMetricRow>();
  const childrenByPpid = new Map<number, number[]>();
  for (const row of input.rows) {
    rowsByPid.set(row.pid, row);
    const children = childrenByPpid.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByPpid.set(row.ppid, children);
  }

  const claimedRoleByPid = new Map<number, AppResourceProcessRole>();
  const claim = (pid: number, role: AppResourceProcessRole): boolean => {
    if (!rowsByPid.has(pid)) return false;
    if (claimedRoleByPid.has(pid)) return false;
    claimedRoleByPid.set(pid, role);
    return true;
  };

  // Electron PIDs are claimed first so no tree walk can absorb them; they are
  // excluded from the pty aggregate (Electron usage is reported separately).
  const electronPids = new Set(normalizePids(input.electronPids));
  for (const pid of electronPids) {
    if (rowsByPid.has(pid)) claimedRoleByPid.set(pid, "electron-main");
  }

  const walkDescendants = (rootPid: number, role: AppResourceProcessRole) => {
    let frontier = [rootPid];
    for (let depth = 0; depth < PROCESS_TREE_MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: number[] = [];
      for (const parent of frontier) {
        for (const childPid of childrenByPpid.get(parent) ?? []) {
          if (claimedRoleByPid.has(childPid) || electronPids.has(childPid)) continue;
          claimedRoleByPid.set(childPid, role);
          next.push(childPid);
        }
      }
      frontier = next;
    }
  };

  // Claim all roots before walking any tree so explicit identities always win
  // over descendant inference, regardless of process topology.
  const runtimePids = normalizePids(input.adeRuntimePids).filter((pid) => !electronPids.has(pid));
  const ptyHostPids = normalizePids(input.adePtyHostPids).filter((pid) => !electronPids.has(pid));
  const desktopRoots = input.desktopPtyRoots
    .map((root) => ({ pid: Math.trunc(root.pid), kind: root.kind }))
    .filter((root) => Number.isFinite(root.pid) && root.pid > 0 && !electronPids.has(root.pid));

  const claimedRuntime = runtimePids.filter((pid) => claim(pid, "ade-runtime"));
  const claimedPtyHosts = ptyHostPids.filter((pid) => claim(pid, "ade-pty-host"));
  const claimedDesktopRoots = desktopRoots.filter((root) => claim(root.pid, root.kind));

  // Descendant inference: provider trees stay provider (helpers belong to the
  // agent); everything else is "unknown" — a shell or an ADE runtime can host
  // arbitrary work, and pretending otherwise misattributes provider/shell load.
  for (const root of claimedDesktopRoots) {
    walkDescendants(root.pid, root.kind === "provider-agent" ? "provider-agent" : "unknown");
  }
  for (const pid of claimedPtyHosts) walkDescendants(pid, "unknown");
  for (const pid of claimedRuntime) walkDescendants(pid, "unknown");

  const accumulators = new Map<AppResourceProcessRole, RoleAccumulator>();
  let aggregateCpu = 0;
  let aggregateRssKB = 0;
  let aggregateCount = 0;
  for (const [pid, role] of claimedRoleByPid) {
    if (role === "electron-main") continue;
    const row = rowsByPid.get(pid);
    if (!row) continue;
    const acc = accumulators.get(role) ?? { processCount: 0, cpuPercent: 0, rssKB: 0 };
    acc.processCount += 1;
    acc.cpuPercent += row.cpuPercent;
    acc.rssKB += row.rssKB;
    accumulators.set(role, acc);
    aggregateCount += 1;
    aggregateCpu += row.cpuPercent;
    aggregateRssKB += row.rssKB;
  }

  const roleUsage: AppResourceRoleUsage[] = NON_ELECTRON_ROLES.map((role) => {
    const acc = accumulators.get(role);
    if (!acc) return { role, processCount: 0, cpuPercent: null, memoryMB: null };
    return {
      role,
      processCount: acc.processCount,
      cpuPercent: roundUsageMetric(acc.cpuPercent),
      memoryMB: roundUsageMetric(acc.rssKB / 1024),
    };
  });

  return {
    roleUsage,
    ptyUsage: {
      activePtyCount,
      ptyProcessCount: aggregateCount,
      ptyCpuPercent: roundUsageMetric(aggregateCpu),
      ptyMemoryMB: roundUsageMetric(aggregateRssKB / 1024),
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

export type ElectronProcessMetricLike = {
  pid: number;
  type?: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number };
};

export type AppResourceUsageAttributionSources = {
  adeRuntimePids: number[];
  adePtyHostPids: number[];
  desktopPtyRoots: ResourceAttributionRoot[];
  activePtyCount: number;
};

export type AppResourceUsageSnapshotDeps = {
  getElectronMetrics: () => ElectronProcessMetricLike[];
  getSystemMemoryMB: () => { freeMemoryMB: number | null; totalMemoryMB: number | null };
  collector: ProcessMetricRowsCollector;
};

function sumMetricCpu(metrics: ElectronProcessMetricLike[]): number | null {
  let total = 0;
  let seen = false;
  for (const metric of metrics) {
    const value = metric.cpu?.percentCPUUsage;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? roundUsageMetric(total) : null;
}

function sumMetricMemoryMB(metrics: ElectronProcessMetricLike[]): number | null {
  let totalKb = 0;
  let seen = false;
  for (const metric of metrics) {
    const value = metric.memory?.workingSetSize;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    totalKb += value;
    seen = true;
  }
  return seen ? roundUsageMetric(totalKb / 1024) : null;
}

function sumOptionalMetrics(...values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? roundUsageMetric(total) : null;
}

function processMetricKind(metric: ElectronProcessMetricLike): string {
  return String(metric.type ?? "").toLowerCase();
}

function isMainProcessMetric(metric: ElectronProcessMetricLike): boolean {
  return processMetricKind(metric) === "browser";
}

function isRendererProcessMetric(metric: ElectronProcessMetricLike): boolean {
  const kind = processMetricKind(metric);
  return kind === "renderer" || kind === "tab";
}

function electronRoleUsage(
  role: AppResourceProcessRole,
  metrics: ElectronProcessMetricLike[],
): AppResourceRoleUsage {
  return {
    role,
    processCount: metrics.length,
    cpuPercent: sumMetricCpu(metrics),
    memoryMB: sumMetricMemoryMB(metrics),
  };
}

export async function computeAppResourceUsageSnapshot(
  deps: AppResourceUsageSnapshotDeps,
  sources: AppResourceUsageAttributionSources,
): Promise<AppResourceUsageSnapshot> {
  const hasRoots = sources.adeRuntimePids.length > 0
    || sources.adePtyHostPids.length > 0
    || sources.desktopPtyRoots.length > 0;
  const shouldSample = hasRoots || sources.activePtyCount > 0;

  const sample: ProcessMetricSample | null = shouldSample ? await deps.collector.collect() : null;

  const metrics = deps.getElectronMetrics();
  const mainMetrics = metrics.filter(isMainProcessMetric);
  const rendererMetrics = metrics.filter(isRendererProcessMetric);
  const helperMetrics = metrics.filter((metric) => !isMainProcessMetric(metric) && !isRendererProcessMetric(metric));

  const classification = classifyProcessRoles({
    rows: sample?.rows ?? null,
    electronPids: metrics
      .map((metric) => metric.pid)
      .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0)
      .concat(process.pid),
    adeRuntimePids: sources.adeRuntimePids,
    adePtyHostPids: sources.adePtyHostPids,
    desktopPtyRoots: sources.desktopPtyRoots,
    activePtyCount: sources.activePtyCount,
  });
  const ptyUsage = classification.ptyUsage;

  const electronCpuPercent = sumMetricCpu(metrics);
  const electronMemoryMB = sumMetricMemoryMB(metrics);
  const memory = deps.getSystemMemoryMB();

  const processSample: AppResourceProcessSampleInfo = sample
    ? {
      status: sample.status,
      reason: sample.reason,
      sampledAt: sample.sampledAt,
      durationMs: sample.durationMs,
    }
    : { status: "skipped", reason: "idle", sampledAt: null, durationMs: null };

  return {
    ...ptyUsage,
    sampledAt: new Date().toISOString(),
    processCount: metrics.length + ptyUsage.ptyProcessCount,
    cpuPercent: sumOptionalMetrics(electronCpuPercent, ptyUsage.ptyCpuPercent),
    mainCpuPercent: sumMetricCpu(mainMetrics),
    rendererCpuPercent: sumMetricCpu(rendererMetrics),
    memoryMB: sumOptionalMetrics(electronMemoryMB, ptyUsage.ptyMemoryMB),
    mainMemoryMB: sumMetricMemoryMB(mainMetrics),
    rendererMemoryMB: sumMetricMemoryMB(rendererMetrics),
    freeMemoryMB: memory.freeMemoryMB,
    totalMemoryMB: memory.totalMemoryMB,
    processSample,
    roleUsage: [
      electronRoleUsage("electron-main", mainMetrics),
      electronRoleUsage("electron-renderer", rendererMetrics),
      electronRoleUsage("electron-helper", helperMetrics),
      ...classification.roleUsage,
    ],
  };
}
