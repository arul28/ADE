import type { AppResourceRoleUsage, AppResourceUsageSnapshot } from "../../shared/types";

export type ResourcePressureLevel = 0 | 1 | 2 | 3 | 4;

let resourceUsageRequest: Promise<AppResourceUsageSnapshot | null> | null = null;

export function getAppResourceUsageCoalesced(): Promise<AppResourceUsageSnapshot | null> {
  if (resourceUsageRequest) return resourceUsageRequest;
  const getResourceUsage = window.ade?.app?.getResourceUsage;
  if (typeof getResourceUsage !== "function") return Promise.resolve(null);

  const request = getResourceUsage()
    .catch(() => null)
    .finally(() => {
      if (resourceUsageRequest === request) resourceUsageRequest = null;
    });
  resourceUsageRequest = request;
  return request;
}

export function clampPressureLevel(value: number): ResourcePressureLevel {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 4) return 4;
  return Math.trunc(value) as ResourcePressureLevel;
}

export function pressureLevelForThresholds(
  value: number | null | undefined,
  thresholds: [number, number, number, number],
): ResourcePressureLevel {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value >= thresholds[3]) return 4;
  if (value >= thresholds[2]) return 3;
  if (value >= thresholds[1]) return 2;
  if (value >= thresholds[0]) return 1;
  return 0;
}

export function appResourcePressureLevel(usage: AppResourceUsageSnapshot | null): ResourcePressureLevel {
  if (!usage) return 0;
  const cpu = Math.max(
    usage.cpuPercent ?? 0,
    usage.mainCpuPercent ?? 0,
    usage.rendererCpuPercent ?? 0,
    usage.ptyCpuPercent ?? 0,
  );
  const cpuLevel = pressureLevelForThresholds(cpu, [30, 50, 70, 90]);
  const freeMemoryRatio = usage.freeMemoryMB != null && usage.totalMemoryMB
    ? usage.freeMemoryMB / usage.totalMemoryMB
    : null;
  const freeMemoryLevel = typeof freeMemoryRatio === "number"
    ? pressureLevelForThresholds(1 - freeMemoryRatio, [0.82, 0.88, 0.93, 0.96])
    : 0;
  const appMemoryRatio = usage.memoryMB != null && usage.totalMemoryMB
    ? usage.memoryMB / usage.totalMemoryMB
    : null;
  const appMemoryLevel = pressureLevelForThresholds(appMemoryRatio, [0.08, 0.14, 0.20, 0.28]);
  const hasAdeLoad = cpuLevel > 0 || appMemoryLevel > 0;
  return clampPressureLevel(Math.max(cpuLevel, hasAdeLoad ? freeMemoryLevel : 0, appMemoryLevel));
}

function formatPercent(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1) return null;
  return `${Math.round(value)}% CPU`;
}

function formatMemory(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1) return null;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function formatSystemMemory(usage: AppResourceUsageSnapshot | null): string | null {
  if (usage?.freeMemoryMB == null || usage.totalMemoryMB == null || usage.totalMemoryMB <= 0) return null;
  const usedRatio = 1 - (usage.freeMemoryMB / usage.totalMemoryMB);
  if (!Number.isFinite(usedRatio)) return null;
  return `${Math.round(usedRatio * 100)}% system memory used`;
}

function preferPositiveMetric(primary: number | null | undefined, fallback: number | null | undefined): number | null | undefined {
  return typeof primary === "number" && Number.isFinite(primary) && primary >= 1 ? primary : fallback;
}

function sumRoleGroup(
  roleUsage: AppResourceRoleUsage[],
  roles: AppResourceRoleUsage["role"][],
): { processCount: number; cpuPercent: number | null; memoryMB: number | null } {
  let processCount = 0;
  let cpuPercent: number | null = null;
  let memoryMB: number | null = null;
  for (const entry of roleUsage) {
    if (!roles.includes(entry.role)) continue;
    processCount += entry.processCount;
    if (typeof entry.cpuPercent === "number" && Number.isFinite(entry.cpuPercent)) {
      cpuPercent = (cpuPercent ?? 0) + entry.cpuPercent;
    }
    if (typeof entry.memoryMB === "number" && Number.isFinite(entry.memoryMB)) {
      memoryMB = (memoryMB ?? 0) + entry.memoryMB;
    }
  }
  return { processCount, cpuPercent, memoryMB };
}

function roleGroupDetail(
  label: string,
  group: { processCount: number; cpuPercent: number | null; memoryMB: number | null },
): string | null {
  const cpu = formatPercent(group.cpuPercent);
  const memory = formatMemory(group.memoryMB);
  const memoryResident = memory ? `${memory} resident` : null;
  const parts = [cpu, memoryResident].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return `${label} ${parts.join(" · ")}`;
}

// Memory figures are summed resident set sizes: shared pages count once per
// process, so these are honest aggregates of resident memory, not unique
// footprints — and never leak evidence.
function roleUsageDetails(usage: AppResourceUsageSnapshot): string[] | null {
  const roleUsage = usage.roleUsage;
  if (!roleUsage || roleUsage.length === 0) return null;
  const adeInfra = sumRoleGroup(roleUsage, [
    "electron-main",
    "electron-renderer",
    "electron-helper",
    "ade-runtime",
    "ade-pty-host",
  ]);
  const agents = sumRoleGroup(roleUsage, ["provider-agent"]);
  const other = sumRoleGroup(roleUsage, ["shell", "unknown"]);
  const details = [
    roleGroupDetail("ADE app", adeInfra),
    agents.processCount > 0
      ? roleGroupDetail(`${agents.processCount} agent process${agents.processCount === 1 ? "" : "es"}`, agents)
      : null,
    other.processCount > 0 ? roleGroupDetail("other terminal processes", other) : null,
  ].filter((part): part is string => Boolean(part));
  return details.length > 0 ? details : null;
}

function legacyDetails(usage: AppResourceUsageSnapshot | null): string[] {
  return [
    usage?.activePtyCount ? `${usage.activePtyCount} live terminal${usage.activePtyCount === 1 ? "" : "s"}` : null,
    usage?.ptyProcessCount ? `${usage.ptyProcessCount} terminal process${usage.ptyProcessCount === 1 ? "" : "es"}` : null,
    formatPercent(preferPositiveMetric(usage?.ptyCpuPercent, usage?.cpuPercent)),
    formatMemory(preferPositiveMetric(usage?.ptyMemoryMB, usage?.memoryMB)),
  ].filter((part): part is string => Boolean(part));
}

export function resourcePressureDescription(usage: AppResourceUsageSnapshot | null): string {
  const details = (usage ? roleUsageDetails(usage) : null) ?? legacyDetails(usage);
  const fallbackDetails = details.length > 0 ? details : [formatSystemMemory(usage)].filter((part): part is string => Boolean(part));
  const detailText = fallbackDetails.length > 0 ? ` (${fallbackDetails.join(", ")})` : "";
  const staleNote = usage?.processSample?.status === "unavailable"
    ? " Terminal process metrics are temporarily unavailable."
    : "";
  return `ADE is under load${detailText}.${staleNote} Background live refreshes are slowed; selected chats and terminals stay full speed.`;
}
