import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Bonjour from "bonjour-service";
import { resolveTailscaleCliPath } from "../../../../../ade-cli/src/services/sync/resolveTailscaleCliPath";
import type {
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeDiscoveryDiagnostic,
  RemoteRuntimeDiscoveryResult,
} from "../../../shared/types/remoteRuntime";

export const ADE_SYNC_MDNS_SERVICE_TYPE = "ade-sync";
const TAILSCALE_SSH_PORT = 22;
const execFileAsync = promisify(execFile);

type BonjourClient = InstanceType<typeof Bonjour>;
type Browser = ReturnType<BonjourClient["find"]>;
type BonjourService = Parameters<NonNullable<Parameters<BonjourClient["find"]>[1]>>[0];
type BonjourServiceLike = Partial<BonjourService> & {
  rawTxt?: unknown;
};

type TxtRecord = Record<string, string>;
type TailscaleStatusPeer = {
  ID?: unknown;
  HostName?: unknown;
  DNSName?: unknown;
  OS?: unknown;
  TailscaleIPs?: unknown;
  Online?: unknown;
};

type TailscaleStatus = {
  Peer?: unknown;
};

function trimmed(value: unknown): string | null {
  if (value == null || value === false) return null;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const next = text.trim();
  return next.length > 0 ? next : null;
}

function normalizeTxtRecord(value: unknown): TxtRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record: TxtRecord = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = trimmed(key);
    const normalizedValue = trimmed(entry);
    if (!normalizedKey || normalizedValue == null) continue;
    record[normalizedKey] = normalizedValue;
  }
  return record;
}

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: unknown): number | null {
  const text = trimmed(value);
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const next = trimmed(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  return result;
}

function isLoopbackRoute(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "::1" ||
    lower === "0.0.0.0" ||
    lower.startsWith("127.")
  );
}

function isTailscaleRoute(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower.endsWith(".ts.net")) return true;
  const match = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!match) return false;
  const second = Number.parseInt(match[1] ?? "", 10);
  return second >= 64 && second <= 127;
}

function normalizeTailscaleDnsName(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  const normalized = text.replace(/\.$/, "");
  return normalized.endsWith(".ts.net") ? normalized : null;
}

function isSshCapableTailscalePeer(osValue: unknown): boolean {
  const os = trimmed(osValue)?.toLowerCase();
  if (!os) return true;
  return os !== "ios" && os !== "android" && os !== "tvos" && os !== "watchos";
}

function orderAddresses(addresses: string[]): string[] {
  const nonLoopback = addresses.filter((host) => !isLoopbackRoute(host));
  const loopback = addresses.filter(isLoopbackRoute);
  return [...nonLoopback, ...loopback];
}

function firstNonEmpty(values: Array<unknown>): string | null {
  for (const value of values) {
    const next = trimmed(value);
    if (next) return next;
  }
  return null;
}

export function discoveredRuntimeFromBonjourService(
  service: BonjourServiceLike,
  nowMs = Date.now(),
): RemoteRuntimeDiscoveredMachine | null {
  const txt = normalizeTxtRecord(service.txt);
  const serviceName =
    firstNonEmpty([service.name, service.fqdn, "ADE Sync"]) ?? "ADE Sync";
  const servicePort =
    parsePositiveInteger(service.port) ?? parsePositiveInteger(txt.port);
  const serviceKey =
    firstNonEmpty([
      service.fqdn,
      `${serviceName}@${firstNonEmpty([service.host, txt.host]) ?? "unknown"}:${servicePort ?? ""}`,
    ]) ?? serviceName;
  const hostName = firstNonEmpty([service.host]);
  const machineName =
    firstNonEmpty([txt.deviceName, hostName, serviceName]) ?? serviceName;
  const hostIdentity = firstNonEmpty([txt.deviceId]);
  const port = servicePort ?? 8787;
  const announcedAddresses = splitCsv(txt.addresses);
  const tailscaleAddress = firstNonEmpty(
    [txt.tailscaleDnsName, txt.tailscaleIp].filter((value): value is string =>
      Boolean(value && isTailscaleRoute(value)),
    ),
  );
  const addresses = orderAddresses(
    uniqueStrings([
      txt.host,
      ...(service.addresses ?? []),
      ...announcedAddresses,
      txt.tailscaleIp,
    ]),
  );
  const primaryRoute = firstNonEmpty([
    addresses.find(
      (address) => !isLoopbackRoute(address) && !isTailscaleRoute(address),
    ),
    tailscaleAddress,
    addresses.find((address) => !isLoopbackRoute(address)),
    hostName,
    addresses[0],
  ]);
  const projectIds = splitCsv(txt.projects);
  const projectCount =
    parsePositiveInteger(txt.projectCount) ??
    (projectIds.length > 0 ? projectIds.length : null);

  return {
    id: hostIdentity ? `${hostIdentity}::${serviceKey}` : serviceKey,
    serviceName,
    machineName,
    hostIdentity,
    hostName,
    port,
    addresses,
    primaryRoute,
    tailscaleAddress,
    runtimeKind: firstNonEmpty([txt.runtimeKind]),
    runtimeVersion: firstNonEmpty([txt.runtimeVersion]),
    projectIds,
    projectCount,
    lastSeenAt: nowMs,
  };
}

export function discoveredRuntimesFromTailscaleStatus(
  value: unknown,
  nowMs = Date.now(),
): RemoteRuntimeDiscoveredMachine[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const peers = (value as TailscaleStatus).Peer;
  if (!peers || typeof peers !== "object" || Array.isArray(peers)) return [];

  const discovered: RemoteRuntimeDiscoveredMachine[] = [];
  for (const [peerKey, rawPeer] of Object.entries(
    peers as Record<string, unknown>,
  )) {
    if (!rawPeer || typeof rawPeer !== "object" || Array.isArray(rawPeer))
      continue;
    const peer = rawPeer as TailscaleStatusPeer;
    if (!isSshCapableTailscalePeer(peer.OS)) continue;
    const tailscaleIps = Array.isArray(peer.TailscaleIPs)
      ? peer.TailscaleIPs.map((entry) => trimmed(entry)).filter(
          (entry): entry is string => Boolean(entry && isTailscaleRoute(entry)),
        )
      : [];
    const dnsName = normalizeTailscaleDnsName(peer.DNSName);
    const tailscaleAddress = firstNonEmpty([dnsName, tailscaleIps[0]]);
    if (!tailscaleAddress) continue;

    const hostName = trimmed(peer.HostName) ?? dnsName;
    const machineName = trimmed(peer.HostName) ?? dnsName ?? tailscaleAddress;
    const hostIdentity = trimmed(peer.ID) ?? trimmed(peerKey);
    const online = peer.Online === true;
    const addresses = uniqueStrings([...tailscaleIps, dnsName]);
    discovered.push({
      id: `tailscale:${hostIdentity ?? tailscaleAddress}`,
      serviceName: "Tailscale peer",
      machineName,
      hostIdentity,
      hostName,
      port: TAILSCALE_SSH_PORT,
      addresses,
      primaryRoute: tailscaleAddress,
      tailscaleAddress,
      runtimeKind: online ? "tailscale-peer" : "tailscale-peer-offline",
      runtimeVersion: null,
      projectIds: [],
      projectCount: null,
      lastSeenAt: nowMs,
    });
  }

  return discovered;
}

async function discoverTailscalePeers(
  timeoutMs = 1_200,
): Promise<{
  machines: RemoteRuntimeDiscoveredMachine[];
  diagnostics: RemoteRuntimeDiscoveryDiagnostic[];
}> {
  try {
    const { stdout } = await execFileAsync(
      resolveTailscaleCliPath(),
      ["status", "--json"],
      {
        timeout: Math.max(500, timeoutMs),
        maxBuffer: 1024 * 1024,
      },
    );
    return {
      machines: discoveredRuntimesFromTailscaleStatus(
        JSON.parse(stdout),
        Date.now(),
      ),
      diagnostics: [],
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      nodeError.killed === true ||
      /timed out|timeout|ETIMEDOUT/i.test(message);
    const notFound =
      nodeError.code === "ENOENT" ||
      /ENOENT|not found|no such file/i.test(message);
    let code: string;
    let summary: string;
    if (timedOut) {
      code = "tailscale-timeout";
      summary = "Tailscale discovery timed out; LAN discovery still ran.";
    } else if (notFound) {
      code = "tailscale-unavailable";
      summary = "Tailscale CLI was not found; only LAN discovery ran.";
    } else {
      code = "tailscale-status-failed";
      summary = "Tailscale discovery failed; LAN discovery still ran.";
    }
    return {
      machines: [],
      diagnostics: [
        {
          source: "tailscale",
          severity: "warning",
          code,
          message: summary,
          detail: message || null,
        },
      ],
    };
  }
}

export async function discoverLanRuntimes(
  timeoutMs = 1_200,
): Promise<RemoteRuntimeDiscoveryResult> {
  const bonjour = new Bonjour();
  const discovered = new Map<string, RemoteRuntimeDiscoveredMachine>();
  const diagnostics: RemoteRuntimeDiscoveryDiagnostic[] = [];
  let browser: Browser | null = null;

  const remember = (service: BonjourService): void => {
    const machine = discoveredRuntimeFromBonjourService(service);
    if (!machine) return;
    discovered.set(machine.id, machine);
  };

  await Promise.all([
    (async () => {
      try {
        browser = bonjour.find({ type: ADE_SYNC_MDNS_SERVICE_TYPE });
        browser.on("up", remember);
        browser.on("txt-update", remember);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(100, timeoutMs)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          source: "bonjour",
          severity: "warning",
          code: "bonjour-discovery-failed",
          message: "LAN discovery failed; Tailscale discovery still ran.",
          detail: message || null,
        });
      } finally {
        browser?.stop();
        await new Promise<void>((resolve) => {
          bonjour.destroy(() => resolve());
          setTimeout(resolve, 250);
        });
      }
    })(),
    (async () => {
      const tailscale = await discoverTailscalePeers(timeoutMs);
      diagnostics.push(...tailscale.diagnostics);
      for (const machine of tailscale.machines) {
        discovered.set(machine.id, machine);
      }
    })(),
  ]);

  return {
    machines: [...discovered.values()].sort((a, b) => {
      const name = a.machineName.localeCompare(b.machineName);
      if (name !== 0) return name;
      return a.serviceName.localeCompare(b.serviceName);
    }),
    diagnostics,
  };
}
