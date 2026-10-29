import type {
  AdeAccountMachine,
  MachineConnectionRoutes,
  MachineTailnetHttpsState,
  MachineTailscaleState,
} from "../../../shared/types";
import { isTailnetHostname } from "../../../shared/tailnet";

export type MachineRouteKind = "lan" | "tailscale" | "https" | "relay";

/** `on` works now, `warn` needs a step, `off` is not there, `idle` is in between. */
export type MachineRouteTone = "on" | "warn" | "off" | "idle";

export type MachineRouteItem = {
  kind: MachineRouteKind;
  label: string;
  /** The pill's word. */
  short: string;
  tone: MachineRouteTone;
  /** One or two words: "Available", "Turned off", "Certificates off". */
  word: string;
  /** An address or a short reason, when there is one worth showing. */
  detail: string | null;
};

const ROUTE_NAMES: Record<MachineRouteKind, { label: string; short: string }> = {
  lan: { label: "Local network", short: "LAN" },
  tailscale: { label: "Tailscale", short: "Tailscale" },
  https: { label: "Tailscale HTTPS", short: "HTTPS" },
  relay: { label: "ADE Relay", short: "Relay" },
};

function route(
  kind: MachineRouteKind,
  tone: MachineRouteTone,
  word: string,
  detail: string | null = null,
): MachineRouteItem {
  return { kind, ...ROUTE_NAMES[kind], tone, word, detail };
}

/** How a computer whose Tailscale is not running says so. */
const TAILSCALE_DOWN: Record<Exclude<MachineTailscaleState, "running">, { tone: MachineRouteTone; word: string }> = {
  not_installed: { tone: "off", word: "Not installed" },
  needs_login: { tone: "warn", word: "Signed out" },
  stopped: { tone: "warn", word: "Turned off" },
  starting: { tone: "warn", word: "Not connected" },
  unknown: { tone: "warn", word: "Not connected" },
};

const HTTPS_STATES: Record<MachineTailnetHttpsState, { tone: MachineRouteTone; word: string }> = {
  published: { tone: "on", word: "Available" },
  publishing: { tone: "idle", word: "Starting" },
  needs_https_certs: { tone: "warn", word: "Certificates off" },
  needs_magic_dns: { tone: "warn", word: "MagicDNS off" },
  failed: { tone: "warn", word: "Didn't start" },
  unavailable: { tone: "off", word: "Not set up" },
};

function isTailnetWssUrl(url: string | undefined): url is string {
  if (!url || !/^wss:\/\//i.test(url)) return false;
  try {
    return isTailnetHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

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
 * `routes` is what the computer itself reported, and wins whenever it saw the
 * route. Without it (an offline machine, one not connected from here, or an
 * ADE process that doesn't host sync) the account directory's published
 * endpoints say what the computer last offered.
 */
export function machineRouteItems(
  machine: AdeAccountMachine | null,
  routes: MachineConnectionRoutes | null,
): MachineRouteItem[] {
  const endpoints = machine?.reachableEndpoints ?? [];
  const lanHost = endpoints.find((endpoint) => endpoint.kind === "lan")?.host ?? null;
  const tailnetHosts = endpoints.flatMap((endpoint) =>
    endpoint.kind === "tailnet" && !endpoint.url && endpoint.host ? [endpoint.host] : []);
  const tailnetName = tailnetHosts.find((host) => host.endsWith(".ts.net")) ?? tailnetHosts[0] ?? null;
  const directoryHttps = endpoints.find((endpoint) => endpoint.kind === "tailnet" && isTailnetWssUrl(endpoint.url))?.url ?? null;
  const directoryRelay = endpoints.some((endpoint) => endpoint.kind === "relay");

  const lan = lanHost ? route("lan", "on", "Available", lanHost) : route("lan", "off", "Not seen");

  const ts = routes?.tailscale ?? null;
  // Only the ADE that hosts sync publishes the Tailscale routes, so an answer
  // from any other ADE process says nothing about them.
  const observed = routes?.tailnet.observed === true ? routes : null;
  let tailscale: MachineRouteItem;
  if (ts && ts.state !== "running") {
    const down = TAILSCALE_DOWN[ts.state];
    tailscale = route("tailscale", down.tone, down.word);
  } else if (observed ? observed.tailnet.published : tailnetHosts.length > 0) {
    tailscale = route("tailscale", "on", "Available", ts?.dnsName ?? tailnetName);
  } else if (observed && ts?.state === "running") {
    tailscale = route("tailscale", "warn", "Not published", observed.tailnet.error);
  } else {
    tailscale = route("tailscale", "off", "Not seen");
  }

  let https: MachineRouteItem;
  if (observed) {
    const state = HTTPS_STATES[observed.tailnetHttps.state];
    const detail = observed.tailnetHttps.state === "published" && observed.tailnetHttps.url
      ? hostOf(observed.tailnetHttps.url)
      : observed.tailnetHttps.state === "failed" ? observed.tailnetHttps.error : null;
    https = route("https", state.tone, state.word, detail);
  } else {
    https = directoryHttps
      ? route("https", "on", "Available", hostOf(directoryHttps))
      : route("https", "off", "Not set up");
  }

  let relay: MachineRouteItem;
  if (routes && !routes.relay.enabled) {
    // The setting is authoritative whichever ADE process answered.
    relay = route("relay", "off", "Turned off");
  } else if (routes?.relay.observed) {
    relay = routes.relay.connected
      ? route("relay", "on", "Connected")
      : route("relay", "warn", "Not connected", routes.relay.error);
  } else {
    relay = directoryRelay ? route("relay", "on", "Available") : route("relay", "off", "Not offered");
  }

  return [lan, tailscale, https, relay];
}

/** "Reachable 3 of 4 ways": how many of a computer's routes work right now. */
export function machineReachHeadline(routes: MachineRouteItem[]): string {
  if (routes.length === 0) return "Checking connections…";
  const on = routes.filter((route) => route.tone === "on").length;
  return on === 0 ? "Not reachable from your other devices yet" : `Reachable ${on} of ${routes.length} ways`;
}
