import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type {
  DiskPressureSnapshot,
  DiskPressureState,
  DiskPressureThresholds,
} from "../../../shared/types/storage";
import { readVolumeSpace } from "./volume";

export type { DiskPressureSnapshot, DiskPressureState, DiskPressureThresholds } from "../../../shared/types/storage";

export type DiskPressureOperationKind =
  | "chat_turn"
  | "cli_launch"
  | "high_write_job"
  | "compression";

export type DiskPressureDecision =
  | { allowed: true; state: DiskPressureState }
  | { allowed: false; state: DiskPressureState; code: "disk_full"; message: string };

export type DiskPressureMonitor = {
  getSnapshot: (options?: { maxAgeMs?: number }) => DiskPressureSnapshot;
  canPerform: (kind: DiskPressureOperationKind) => DiskPressureDecision;
  subscribe: (listener: (snapshot: DiskPressureSnapshot) => void) => () => void;
};

export const DEFAULT_DISK_PRESSURE_THRESHOLDS: DiskPressureThresholds = {
  exhaustedBytes: 1 * 1024 ** 3,
  criticalBytes: 4 * 1024 ** 3,
  criticalFraction: 0.02,
  warningBytes: 12 * 1024 ** 3,
  warningFraction: 0.05,
};

export const DISK_PRESSURE_REFUSAL_MESSAGES = {
  chat_turn: "Your computer is almost out of storage. ADE paused new agent work to protect your chats and projects. Free up space, then resume.",
  cli_launch: "Your computer is almost out of storage. ADE can't safely start a new CLI session until you free up space.",
  high_write_job: "Your computer is almost out of storage. ADE didn't start this task to avoid writing more data. Free up space, then try again.",
  compression: "Your computer is almost out of storage. ADE didn't start this task to avoid writing more data. Free up space, then try again.",
} satisfies Record<DiskPressureOperationKind, string>;

const STATE_SEVERITY: Record<DiskPressureState, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
  exhausted: 3,
};

export function classifyDiskPressure(
  sample: Pick<DiskPressureSnapshot, "freeBytes" | "freeFraction">,
  thresholds: DiskPressureThresholds = DEFAULT_DISK_PRESSURE_THRESHOLDS,
): DiskPressureState {
  if (sample.freeBytes <= thresholds.exhaustedBytes) return "exhausted";
  if (
    sample.freeBytes <= thresholds.criticalBytes
    || sample.freeFraction <= thresholds.criticalFraction
  ) {
    return "critical";
  }
  if (
    sample.freeBytes <= thresholds.warningBytes
    || sample.freeFraction <= thresholds.warningFraction
  ) {
    return "warning";
  }
  return "normal";
}

export function createDiskPressureMonitor(options: {
  roots: string[];
  thresholds?: Partial<DiskPressureThresholds>;
  statfs?: typeof fs.statfsSync;
  logger?: Pick<Logger, "warn">;
  now?: () => number;
  sampleIntervalMs?: number;
}): DiskPressureMonitor {
  const roots = Array.from(new Set(
    options.roots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root)),
  ));
  const thresholds = {
    ...DEFAULT_DISK_PRESSURE_THRESHOLDS,
    ...options.thresholds,
  };
  const readSpace = options.statfs
    ? (root: string) => {
        const stats = options.statfs!(root, { bigint: true }) as {
          bavail: bigint;
          blocks: bigint;
          bsize: bigint;
        };
        return {
          freeBytes: Number(stats.bavail * stats.bsize),
          totalBytes: Number(stats.blocks * stats.bsize),
        };
      }
    : readVolumeSpace;
  const now = options.now ?? Date.now;
  const sampleIntervalMs = options.sampleIntervalMs ?? 30_000;
  const listeners = new Set<(snapshot: DiskPressureSnapshot) => void>();
  const statfsErrorsLogged = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let snapshot: DiskPressureSnapshot | null = null;
  let sampledAtMs = Number.NEGATIVE_INFINITY;
  let lowerSeveritySamples = 0;

  const sample = (): DiskPressureSnapshot => {
    const perRoot: DiskPressureSnapshot["perRoot"] = [];
    for (const root of roots) {
      try {
        const stats = readSpace(root);
        if (!stats) throw new Error("Storage space is unavailable.");
        perRoot.push({
          root,
          freeBytes: stats.freeBytes,
          totalBytes: stats.totalBytes,
        });
      } catch (error) {
        if (!statfsErrorsLogged.has(root)) {
          statfsErrorsLogged.add(root);
          options.logger?.warn("storage.disk_pressure_measure_failed", {
            root,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const sampledAtValue = now();
    const minFreeRoot = perRoot.reduce<(typeof perRoot)[number] | null>(
      (lowest, entry) => !lowest || entry.freeBytes < lowest.freeBytes ? entry : lowest,
      null,
    );
    const freeBytes = minFreeRoot?.freeBytes ?? 0;
    const totalBytes = minFreeRoot?.totalBytes ?? 0;
    const freeFraction = perRoot.length > 0
      ? Math.min(...perRoot.map((entry) => entry.totalBytes > 0 ? entry.freeBytes / entry.totalBytes : 1))
      : 1;
    const allRootsUnknown = perRoot.length === 0;
    const rawState = allRootsUnknown
      ? "normal"
      : classifyDiskPressure({ freeBytes, freeFraction }, thresholds);
    const previousState = snapshot?.state ?? null;
    let state = rawState;

    if (allRootsUnknown) {
      lowerSeveritySamples = 0;
    } else if (previousState) {
      if (STATE_SEVERITY[rawState] > STATE_SEVERITY[previousState]) {
        lowerSeveritySamples = 0;
      } else if (STATE_SEVERITY[rawState] < STATE_SEVERITY[previousState]) {
        lowerSeveritySamples += 1;
        if (lowerSeveritySamples < 2) state = previousState;
        else lowerSeveritySamples = 0;
      } else {
        lowerSeveritySamples = 0;
      }
    }

    const next: DiskPressureSnapshot = {
      state,
      freeBytes,
      totalBytes,
      freeFraction,
      perRoot,
      sampledAt: new Date(sampledAtValue).toISOString(),
    };
    snapshot = next;
    sampledAtMs = sampledAtValue;
    if (previousState && previousState !== next.state) {
      for (const listener of listeners) listener(next);
    }
    return next;
  };

  const getSnapshot = ({ maxAgeMs = sampleIntervalMs }: { maxAgeMs?: number } = {}) => {
    const ageMs = now() - sampledAtMs;
    if (snapshot && maxAgeMs > 0 && ageMs < maxAgeMs) return snapshot;
    return sample();
  };

  const canPerform = (kind: DiskPressureOperationKind): DiskPressureDecision => {
    const state = getSnapshot().state;
    const disallowed = state === "exhausted"
      || (state === "critical" && (kind === "high_write_job" || kind === "compression"));
    if (!disallowed) return { allowed: true, state };
    return {
      allowed: false,
      state,
      code: "disk_full",
      message: DISK_PRESSURE_REFUSAL_MESSAGES[kind],
    };
  };

  const subscribe = (listener: (snapshot: DiskPressureSnapshot) => void) => {
    listeners.add(listener);
    if (!timer) {
      timer = setInterval(() => {
        getSnapshot({ maxAgeMs: 0 });
      }, sampleIntervalMs);
      timer.unref?.();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  };

  return { getSnapshot, canPerform, subscribe };
}
