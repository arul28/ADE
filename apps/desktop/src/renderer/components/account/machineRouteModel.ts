import type { AdeAccountMachine, MachineConnectionRoutes } from "../../../shared/types";
import { isTailnetHostname } from "../../../shared/tailnet";

export type MachineRouteKind = "lan" | "tailscale" | "https" | "relay";

/** `on` works now, `warn` needs a step, `off` is not there, `idle` is unknown or asleep. */
export type MachineRouteTone = "on" | "warn" | "off" | "idle";

export type MachineRouteItem = {
  kind: MachineRouteKind;
  label: string;
  tone: MachineRouteTone;
  /** One or two words: "Available", "Turned off", "Certificates off". */
  word: string;
  /** An address or a short reason, when there is one worth showing. */
  detail: string | null;
};

export const MACHINE_ROUTE_LABELS: Record<MachineRouteKind, string> = {
  lan: "Local network",
  tailscale: "Tailscale",
  https: "Tailscale HTTPS",
  relay: "ADE Relay",
};

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

/**
 * The four ways to reach one computer, in the order clients try them.
 *
 * `routes` is what the computer itself reported, and wins whenever it is
 * there. Without it (an offline machine, one not connected from here) the
 * account directory's published endpoints say what it last offered.
 */
export function machineRouteItems(
  machine: AdeAccountMachine | null,
  routes: MachineConnectionRoutes | null,
): MachineRouteItem[] {
  const endpoints = machine?.reachableEndpoints ?? [];
  const lanHost = endpoints.find((endpoint) => endpoint.kind === "lan")?.host ?? null;
  const tailnetHosts = endpoints
    .filter((endpoint) => endpoint.kind === "tailnet" && !endpoint.url && endpoint.host)
    .map((endpoint) => endpoint.host!);
  const tailnetName = tailnetHosts.find((host) => host.endsWith(".ts.net"))
    ?? tailnetHosts[0]
    ?? null;
  const directoryHttps = endpoints.find((endpoint) =>
    endpoint.kind === "tailnet" && endpoint.url && /^wss:\/\//i.test(endpoint.url) && (() => {
      try {
        return isTailnetHostname(new URL(endpoint.url!).hostname);
      } catch {
        return false;
      }
    })())?.url ?? null;
  const directoryRelay = endpoints.some((endpoint) => endpoint.kind === "relay");

  const lan: MachineRouteItem = lanHost
    ? { kind: "lan", label: MACHINE_ROUTE_LABELS.lan, tone: "on", word: "Available", detail: lanHost }
    : { kind: "lan", label: MACHINE_ROUTE_LABELS.lan, tone: "off", word: "Not seen", detail: null };

  let tailscale: MachineRouteItem;
  const ts = routes?.tailscale ?? null;
  if (ts && ts.state !== "running") {
    tailscale = {
      kind: "tailscale",
      label: MACHINE_ROUTE_LABELS.tailscale,
      tone: ts.state === "not_installed" ? "off" : "warn",
      word: ts.state === "not_installed"
        ? "Not installed"
        : ts.state === "needs_login"
          ? "Signed out"
          : ts.state === "stopped"
            ? "Turned off"
            : "Not connected",
      detail: null,
    };
  } else if (routes?.tailnet.observed ? routes.tailnet.published : tailnetHosts.length > 0) {
    tailscale = {
      kind: "tailscale",
      label: MACHINE_ROUTE_LABELS.tailscale,
      tone: "on",
      word: "Available",
      detail: ts?.dnsName ?? tailnetName,
    };
  } else {
    tailscale = {
      kind: "tailscale",
      label: MACHINE_ROUTE_LABELS.tailscale,
      tone: ts?.state === "running" && routes?.tailnet.observed ? "warn" : "off",
      word: ts?.state === "running" && routes?.tailnet.observed ? "Not published" : "Not seen",
      detail: ts?.state === "running" && routes?.tailnet.observed ? routes.tailnet.error : null,
    };
  }

  let https: MachineRouteItem;
  // Only the ADE that hosts sync publishes the HTTPS route, so an answer from
  // any other ADE process says nothing about it.
  const httpsRoute = routes?.tailnet.observed ? routes.tailnetHttps : null;
  if (httpsRoute) {
    switch (httpsRoute.state) {
      case "published":
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "on", word: "Available", detail: httpsRoute.url ? hostOf(httpsRoute.url) : null };
        break;
      case "publishing":
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "idle", word: "Starting", detail: null };
        break;
      case "needs_https_certs":
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "warn", word: "Certificates off", detail: null };
        break;
      case "needs_magic_dns":
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "warn", word: "MagicDNS off", detail: null };
        break;
      case "failed":
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "warn", word: "Didn't start", detail: httpsRoute.error };
        break;
      default:
        https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "off", word: "Not set up", detail: null };
    }
  } else if (directoryHttps) {
    https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "on", word: "Available", detail: hostOf(directoryHttps) };
  } else {
    https = { kind: "https", label: MACHINE_ROUTE_LABELS.https, tone: "off", word: "Not set up", detail: null };
  }

  let relay: MachineRouteItem;
  if (routes && (routes.relay.observed || !routes.relay.enabled)) {
    relay = !routes.relay.enabled
      ? { kind: "relay", label: MACHINE_ROUTE_LABELS.relay, tone: "off", word: "Turned off", detail: null }
      : routes.relay.connected
        ? { kind: "relay", label: MACHINE_ROUTE_LABELS.relay, tone: "on", word: "Connected", detail: null }
        : { kind: "relay", label: MACHINE_ROUTE_LABELS.relay, tone: "warn", word: "Not connected", detail: routes.relay.error };
  } else {
    relay = directoryRelay
      ? { kind: "relay", label: MACHINE_ROUTE_LABELS.relay, tone: "on", word: "Available", detail: null }
      : { kind: "relay", label: MACHINE_ROUTE_LABELS.relay, tone: "off", word: "Not offered", detail: null };
  }

  return [lan, tailscale, https, relay];
}

/** The route a client would use first: the earliest one that works. */
export function preferredRoute(items: readonly MachineRouteItem[]): MachineRouteItem | null {
  return items.find((item) => item.tone === "on") ?? null;
}
