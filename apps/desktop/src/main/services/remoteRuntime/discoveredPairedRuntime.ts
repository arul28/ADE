import type {
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTargetRoute,
} from "../../../shared/types/remoteRuntime";
import {
  classifyPairedRuntimeEndpoint,
  isTailnetHostname,
  syncEndpointForHost,
} from "./pairedRuntimeRoutes";

function normalizedHost(value: string | null | undefined): string | null {
  const host = value?.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host || null;
}

function uniqueHosts(values: Array<string | null | undefined>): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const host = normalizedHost(value);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

export function isDiscoveredSyncRuntime(
  machine: RemoteRuntimeDiscoveredMachine,
): boolean {
  return machine.connectable !== false
    && Number.isInteger(machine.port)
    && machine.port >= 1
    && machine.port <= 65_535
    && !(machine.runtimeKind ?? "").startsWith("tailscale-peer");
}

export function syncEndpointsForDiscoveredRuntime(
  machine: RemoteRuntimeDiscoveredMachine,
): string[] {
  if (!isDiscoveredSyncRuntime(machine)) return [];
  return uniqueHosts([
    machine.primaryRoute,
    machine.tailscaleAddress,
    machine.hostName,
    ...machine.addresses,
  ]).flatMap((host) => {
    try {
      return [syncEndpointForHost(host, machine.port)];
    } catch {
      return [];
    }
  });
}

export function sshRoutesForPairedEndpoints(
  endpoints: string[],
): RemoteRuntimeTargetRoute[] {
  const routes: RemoteRuntimeTargetRoute[] = [];
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      continue;
    }
    if (classifyPairedRuntimeEndpoint(endpoint) === "relay") continue;
    const hostname = normalizedHost(url.hostname);
    if (!hostname || seen.has(hostname)) continue;
    seen.add(hostname);
    routes.push({
      hostname,
      port: null,
      source: classifyPairedRuntimeEndpoint(endpoint) === "tailnet"
        ? "tailscale"
        : "bonjour",
      lastSucceededAt: null,
    });
  }
  return routes;
}

export function sshRoutesForDiscoveredRuntime(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetRoute[] {
  const isTailscalePeer = (machine.runtimeKind ?? "").startsWith("tailscale-peer");
  return uniqueHosts([
    machine.primaryRoute,
    machine.tailscaleAddress,
    machine.hostName,
    ...machine.addresses,
  ]).map((hostname) => ({
    hostname,
    port: isTailscalePeer ? machine.port : null,
    source: isTailnetHostname(hostname) ? "tailscale" : "bonjour",
    lastSucceededAt: null,
  }));
}

export function findDiscoveredRuntimeForTargetInput(
  machines: RemoteRuntimeDiscoveredMachine[],
  input: RemoteRuntimeTargetInput,
): RemoteRuntimeDiscoveredMachine | null {
  const inputHosts = new Set(uniqueHosts([
    input.hostname,
    ...(input.routes ?? []).map((route) => route.hostname),
  ]));
  if (inputHosts.size === 0) return null;
  return machines.find((machine) => {
    if (!isDiscoveredSyncRuntime(machine)) return false;
    const machineHosts = uniqueHosts([
      machine.primaryRoute,
      machine.tailscaleAddress,
      machine.hostName,
      ...machine.addresses,
    ]);
    return machineHosts.some((host) => inputHosts.has(host));
  }) ?? null;
}
