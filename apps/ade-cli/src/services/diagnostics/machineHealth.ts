import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostMemorySignals, runHostTool } from "../../../../desktop/src/main/services/machineStats/hostMemorySignals";
import {
  readProcessGroups,
  type ProcessGroupUsage,
} from "../../../../desktop/src/main/services/machineStats/processGroups";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import {
  memoryOf,
  readResourcePressureRecord,
  type ResourcePressureEpisode,
  type ResourcePressureMemory,
} from "../runtime/resourcePressureMonitor";

/*
 * The "Machine health" and hardware lines of a diagnostic report: how much
 * memory and swap this computer has left, what ADE, emulators and simulators
 * are holding, the brain's last read of its databases' write-ahead logs, and
 * the last resource-pressure episodes (`resourcePressureMonitor.ts`). Group
 * names and numbers only; the process listing never leaves as names.
 */

export type DiagnosticMachineHardware = {
  /** `MacBookPro18,3`, `XPS 13 9310`: the maker's model name, never a serial. */
  model: string | null;
  cpuModel: string | null;
  cpuCount: number;
  ramGb: number;
};

export type DiagnosticMachineHealth = {
  memory: ResourcePressureMemory | null;
  /** 1, 5 and 15 minutes; null on Windows, which has none. */
  loadAverage: number[] | null;
  cpuCount: number;
  processes: ProcessGroupUsage[] | null;
  emulatorCount: number | null;
  /** The machine brain's last read of each open database's `-wal`, MB. */
  walMb: number[] | null;
  walSampledAt: string | null;
  episodes: ResourcePressureEpisode[];
};

const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ,._()+-]{0,79}$/;

function cleanModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!trimmed || /^(?:to be filled|default string|system product name|none|unknown)/i.test(trimmed)) return null;
  return MODEL_VALUE.test(trimmed) ? trimmed : null;
}

/** The maker's model name. One `sysctl`, one file, or one `reg` read. Never throws. */
export async function readMachineHardware(platform: NodeJS.Platform = process.platform): Promise<DiagnosticMachineHardware> {
  const base = basicMachineHardware();
  let model: string | null = null;
  try {
    if (platform === "darwin") {
      model = cleanModel(await runHostTool("/usr/sbin/sysctl", ["-n", "hw.model"], 2_000));
    } else if (platform === "linux") {
      const read = (name: string) => fs.promises.readFile(path.join("/sys/devices/virtual/dmi/id", name), "utf8").catch(() => "");
      const [vendor, product] = await Promise.all([read("sys_vendor"), read("product_name")]);
      model = cleanModel([cleanModel(vendor), cleanModel(product)].filter(Boolean).join(" "));
    } else if (platform === "win32") {
      const output = await runHostTool(
        resolveTrustedWindowsTool("reg"),
        ["query", String.raw`HKLM\HARDWARE\DESCRIPTION\System\BIOS`, "/v", "SystemProductName"],
        2_000,
      );
      const line = output?.split(/\r?\n/).find((row) => /^\s*SystemProductName\s+REG_/i.test(row));
      model = cleanModel(line?.replace(/^\s*SystemProductName\s+REG_[A-Z_]+\s+/i, ""));
    }
  } catch {
    model = null;
  }
  return { ...base, model };
}

/**
 * A short fingerprint of this machine's sync key (`sync-cloud-relay.json`), so
 * a report can be matched to its account-directory row without the key itself.
 */
export function readMachineKeyFingerprint(secretsDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(secretsDir, "sync-cloud-relay.json"), "utf8")) as { machineKey?: unknown };
    const key = typeof parsed.machineKey === "string" ? parsed.machineKey.trim() : "";
    return key ? createHash("sha256").update(`ade-machine-key:${key}`).digest("hex").slice(0, 12) : null;
  } catch {
    return null;
  }
}

/**
 * The machine-health section's facts. `live` reads memory and the process
 * groups now (a `sysctl` and a `ps` with `footprint` on macOS, PowerShell on
 * Windows); without it, only what the brain already recorded. Never throws.
 */
export async function collectMachineHealth(args: {
  runtimeDir: string;
  live: boolean;
  platform?: NodeJS.Platform;
}): Promise<DiagnosticMachineHealth> {
  const platform = args.platform ?? process.platform;
  const recorded = recordedMachineHealth(args.runtimeDir);
  if (!args.live) return recorded;
  const [memory, processes] = await Promise.all([
    readHostMemorySignals({ platform, pagingSampleMs: 0 }).then(memoryOf, () => null),
    readProcessGroups({ platform }).catch(() => null),
  ]);
  return {
    ...recorded,
    memory: memory ?? recorded.memory,
    loadAverage: platform === "win32" ? null : os.loadavg().map((value) => Math.round(value * 100) / 100),
    processes: processes?.groups ?? null,
    emulatorCount: processes?.emulatorCount ?? null,
  };
}

/**
 * What the machine brain last recorded; file reads only, and nothing that moves
 * between two reads (so the two CLI builders produce the same report).
 */
export function recordedMachineHealth(runtimeDir: string): DiagnosticMachineHealth {
  const record = readResourcePressureRecord(runtimeDir);
  return {
    memory: record?.lastSample?.memory ?? null,
    loadAverage: null,
    cpuCount: os.cpus().length,
    processes: null,
    emulatorCount: null,
    walMb: record?.lastSample?.walMb ?? null,
    walSampledAt: record?.lastSample ? new Date(record.lastSample.atMs).toISOString() : null,
    episodes: record?.episodes ?? [],
  };
}

/** The base hardware lines without the model, for a caller that cannot wait on a spawn. */
export function basicMachineHardware(): DiagnosticMachineHardware {
  const cpus = os.cpus();
  return {
    model: null,
    cpuModel: cpus[0]?.model?.trim().replace(/\s+/g, " ") || null,
    cpuCount: cpus.length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}
