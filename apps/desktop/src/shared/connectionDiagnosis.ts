import type {
  SyncHostStall,
  SyncRouteHealth,
} from "./types/sync";

/**
 * Plain-language answers to "why can't my devices reach that computer?".
 *
 * Every sentence a person reads about a broken connection is written here, from
 * facts, never from error text: which part failed (this device's network, the
 * relay, the other computer's ADE, its pairing) and what to do about it. The
 * desktop, the web client and the host's own self-check all use it, so the
 * same failure reads the same everywhere.
 */

export type DiagnosisTone = "success" | "warning" | "danger" | "info";

function machineLabel(name: string | null | undefined, fallback = "That computer"): string {
  return name?.trim() || fallback;
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  return `${minutes} min ago`;
}

export type HostStallSummary = {
  /** "Studio froze for 12s" */
  title: string;
  /** Why, and what that means: "Its CPU is overloaded (load 21 on 8 cores)." */
  detail: string;
};

/**
 * Explain a freeze the host reported after it recovered.
 *
 * A load average above the core count is the CPU being starved, and saying so
 * points at the cause (a build, a benchmark, too many agents). Without it the
 * honest answer is only that ADE there was too busy to answer.
 */
export function describeHostStall(
  stall: Pick<SyncHostStall, "durationMs" | "loadAverage1m" | "cpuCount" | "restarted"> & { agoMs?: number },
  machineName: string | null | undefined,
): HostStallSummary {
  const machine = machineLabel(machineName);
  const when = typeof stall.agoMs === "number" ? ` ${formatAgo(stall.agoMs)}` : "";
  if (stall.restarted) {
    return {
      title: `${machine} froze${when}`,
      detail: `ADE there stopped responding for ${formatSeconds(stall.durationMs)} and restarted itself.`,
    };
  }
  const load = stall.loadAverage1m;
  const cores = stall.cpuCount;
  const overloaded = typeof load === "number" && typeof cores === "number" && load > cores;
  return {
    title: `${machine} froze for ${formatSeconds(stall.durationMs)}${when}`,
    detail: overloaded
      ? `Its CPU is overloaded (load ${Math.round(load)} on ${cores} cores).`
      : `ADE on ${machine} was too busy to answer.`,
  };
}

// ---------------------------------------------------------------------------
// Host self-check: can other devices reach this computer?
// ---------------------------------------------------------------------------

export type HostReachabilityCheckId =
  | "listener"
  | "relay"
  | "tailnet"
  | "exit_node"
  | "account"
  | "freeze";

export type HostReachabilityCheck = {
  id: HostReachabilityCheckId;
  /** Short name of the part: "Relay", "Tailscale". */
  label: string;
  /** `off` is a route that is not set up, which is not a fault. */
  state: "ok" | "warning" | "failed" | "off";
  /** What we found, in one sentence. */
  detail: string;
  /** What to do, when there is something to do. */
  fix?: string;
};

export type HostReachabilityReport = {
  checkedAt: string;
  tone: DiagnosisTone;
  /** One sentence over all checks. */
  title: string;
  checks: HostReachabilityCheck[];
};

export type HostReachabilityFacts = {
  routeHealth: SyncRouteHealth;
  /** Whether this computer is signed in to an ADE account (relay needs it). */
  accountSignedIn: boolean;
  /** Result of dialing the relay as a client would, or null when not run. */
  relaySelfProbe: { ok: boolean; detail: string } | null;
  tailscale: {
    /** `tailscale` CLI answered. */
    installed: boolean;
    /** Tailscale's own state: "Running", "Stopped", "NeedsLogin"… */
    backendState: string | null;
    /** The exit node this computer sends its traffic through ("" when unnamed), or null for none. */
    exitNodeName: string | null;
  } | null;
  lastStall: SyncHostStall | null;
  machineName?: string | null;
};

function exitNodePhrase(name: string): string {
  return name ? `the Tailscale exit node "${name}"` : "a Tailscale exit node";
}

const RELAY_FIREWALL_FIX =
  "Check this computer's internet connection. A VPN, proxy or firewall that blocks secure WebSockets to ADE's relay stops it too.";

/** The relay's fix when an exit node is on: it names the exit node itself. */
function exitNodeRelayFix(facts: HostReachabilityFacts): string | null {
  const exitNode = facts.tailscale?.exitNodeName ?? null;
  return exitNode !== null
    ? `This computer sends its traffic through ${exitNodePhrase(exitNode)}. Turn the exit node off, or allow ADE's relay through it.`
    : null;
}

function relayCheck(facts: HostReachabilityFacts): HostReachabilityCheck {
  const relay = facts.routeHealth.relay;
  const exitNodeFix = exitNodeRelayFix(facts);
  if (!facts.accountSignedIn) {
    return {
      id: "relay",
      label: "Relay",
      state: "off",
      detail: "The relay needs this computer to be signed in to ADE.",
      fix: "Sign in to ADE to reach this computer from anywhere.",
    };
  }
  if (!relay.enabled) {
    return {
      id: "relay",
      label: "Relay",
      state: "off",
      detail: relay.skipReason?.trim() || "The relay is off on this computer.",
    };
  }
  if (relay.relayControlSuppressed) {
    return {
      id: "relay",
      label: "Relay",
      state: "failed",
      detail: "Another ADE on this computer took over the relay connection.",
      fix: "Quit the other ADE app on this computer (a beta, alpha or dev build), then restart ADE.",
    };
  }
  if (!relay.relayControlConnected) {
    return {
      id: "relay",
      label: "Relay",
      state: "failed",
      detail: "This computer is not connected to ADE's relay.",
      fix: exitNodeFix ?? RELAY_FIREWALL_FIX,
    };
  }
  if (!relay.relayBridgeValidated) {
    return {
      id: "relay",
      label: "Relay",
      state: "failed",
      detail: "The relay is connected, but it cannot hand connections to ADE here.",
      fix: "Restart ADE on this computer.",
    };
  }
  if (facts.relaySelfProbe && !facts.relaySelfProbe.ok) {
    return {
      id: "relay",
      label: "Relay",
      state: "failed",
      detail: "A test connection through the relay did not get through.",
      fix: exitNodeFix ?? RELAY_FIREWALL_FIX,
    };
  }
  return {
    id: "relay",
    label: "Relay",
    state: "ok",
    detail: facts.relaySelfProbe?.ok
      ? "A test connection through the relay reached this computer."
      : "Connected to ADE's relay.",
  };
}

function listenerCheck(health: SyncRouteHealth["listener"]): HostReachabilityCheck {
  if (!health.listenerBound) {
    return {
      id: "listener",
      label: "ADE",
      state: "failed",
      detail: "ADE is not accepting connections on this computer.",
      fix: "Restart ADE on this computer.",
    };
  }
  if (!health.loopbackAdeValidated) {
    return {
      id: "listener",
      label: "ADE",
      state: "failed",
      detail: health.port != null
        ? `Something other than ADE answered on port ${health.port}.`
        : "ADE could not confirm its own connection port.",
      fix: "Quit the program using that port, or restart ADE so it picks another.",
    };
  }
  return {
    id: "listener",
    label: "ADE",
    state: "ok",
    detail: health.port != null
      ? `Accepting connections on port ${health.port}.`
      : "Accepting connections.",
  };
}

function tailnetCheck(facts: HostReachabilityFacts): HostReachabilityCheck {
  const health = facts.routeHealth.tailscale;
  const tailscale = facts.tailscale;
  if (tailscale && !tailscale.installed) {
    return {
      id: "tailnet",
      label: "Tailscale",
      state: "off",
      detail: "Tailscale is not installed. Devices on other networks use the relay.",
    };
  }
  if (tailscale?.backendState && tailscale.backendState !== "Running") {
    return {
      id: "tailnet",
      label: "Tailscale",
      state: "warning",
      detail: tailscale.backendState === "NeedsLogin"
        ? "Tailscale is signed out on this computer."
        : "Tailscale is not connected on this computer.",
      fix: "Open Tailscale and connect it.",
    };
  }
  if (!health.enabled) {
    return {
      id: "tailnet",
      label: "Tailscale",
      state: "off",
      detail: health.reason?.trim() || "ADE is not offering this computer on your tailnet.",
    };
  }
  if (!health.tailscaleReachable) {
    return {
      id: "tailnet",
      label: "Tailscale",
      state: "warning",
      detail: health.reason?.trim() || "ADE could not offer this computer on your tailnet.",
      fix: "Open Tailscale, check that it is connected, then restart ADE.",
    };
  }
  return {
    id: "tailnet",
    label: "Tailscale",
    state: "ok",
    detail: "Devices on your tailnet can reach this computer.",
  };
}

/**
 * Read this computer's own connection facts as a person would want them:
 * every part that other devices go through, which ones work, and the one
 * thing to do about each that does not.
 */
export function diagnoseHostReachability(
  facts: HostReachabilityFacts,
  now: Date = new Date(),
): HostReachabilityReport {
  const relayResult = relayCheck(facts);
  const checks: HostReachabilityCheck[] = [
    listenerCheck(facts.routeHealth.listener),
    relayResult,
    tailnetCheck(facts),
  ];
  const exitNode = facts.tailscale?.exitNodeName ?? null;
  // A failed relay already names the exit node in its fix; say it once.
  const relayBlamesExitNode = relayResult.state === "failed" && relayResult.fix === exitNodeRelayFix(facts);
  if (exitNode !== null && !relayBlamesExitNode) {
    checks.push({
      id: "exit_node",
      label: "Exit node",
      state: "warning",
      detail: `This computer sends its traffic through ${exitNodePhrase(exitNode)}.`,
      fix: "If devices can't reach this computer through the relay, turn the exit node off.",
    });
  }
  if (!facts.accountSignedIn) {
    checks.push({
      id: "account",
      label: "ADE account",
      state: "warning",
      detail: "Not signed in, so only devices on your network or tailnet can connect.",
      fix: "Sign in to ADE.",
    });
  }
  if (facts.lastStall) {
    const stall = describeHostStall(facts.lastStall, "This computer");
    checks.push({
      id: "freeze",
      label: "Responsiveness",
      state: "warning",
      detail: `${stall.title}. ${stall.detail}`,
      fix: "Devices drop their connection while it is frozen. Close heavy builds or agents if this keeps happening.",
    });
  }

  const byId = new Map(checks.map((check) => [check.id, check]));
  const listener = byId.get("listener");
  const relay = byId.get("relay");
  const tailnet = byId.get("tailnet");
  let tone: DiagnosisTone;
  let title: string;
  if (listener?.state === "failed") {
    tone = "danger";
    title = "Other devices can't reach this computer.";
  } else if (relay?.state === "ok") {
    const anyWarning = checks.some((check) => check.state === "warning" || check.state === "failed");
    tone = anyWarning ? "warning" : "success";
    title = "Your devices can reach this computer from anywhere.";
  } else if (tailnet?.state === "ok") {
    tone = "warning";
    title = "Devices on your network or tailnet can reach this computer. Others can't.";
  } else {
    tone = relay?.state === "failed" ? "danger" : "warning";
    title = "Only devices on this computer's network can reach it.";
  }
  return { checkedAt: now.toISOString(), tone, title, checks };
}

/**
 * The host writes its report about "this computer". Read from another
 * machine, that would point at the wrong one, so name the machine instead.
 */
export function describeReportForMachine(
  report: HostReachabilityReport,
  machineName: string | null | undefined,
): HostReachabilityReport {
  const name = machineName?.trim() || "that machine";
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  const rename = (text: string) => text.replace(/\bthis computer\b/g, name).replace(/\bThis computer\b/g, capitalized);
  return {
    ...report,
    title: rename(report.title),
    checks: report.checks.map((check) => ({
      ...check,
      label: rename(check.label),
      detail: rename(check.detail),
      ...(check.fix ? { fix: rename(check.fix) } : {}),
    })),
  };
}

/** Parse what we need from `tailscale status --json`. Tolerates any shape. */
export function readTailscaleStatus(payload: unknown): {
  backendState: string | null;
  exitNodeName: string | null;
} {
  if (!payload || typeof payload !== "object") return { backendState: null, exitNodeName: null };
  const record = payload as Record<string, unknown>;
  const backendState = typeof record.BackendState === "string" ? record.BackendState : null;
  let exitNodeName: string | null = null;
  const peers = record.Peer;
  if (peers && typeof peers === "object") {
    for (const peer of Object.values(peers as Record<string, unknown>)) {
      if (!peer || typeof peer !== "object") continue;
      const value = peer as Record<string, unknown>;
      if (value.ExitNode !== true) continue;
      const host = typeof value.HostName === "string" && value.HostName.trim()
        ? value.HostName.trim()
        : typeof value.DNSName === "string"
          ? value.DNSName.split(".")[0]?.trim() ?? ""
          : "";
      exitNodeName = host;
      break;
    }
  }
  if (!exitNodeName) {
    const status = record.ExitNodeStatus;
    if (status && typeof status === "object" && (status as Record<string, unknown>).ID) {
      exitNodeName = "";
    }
  }
  return { backendState, exitNodeName };
}

/**
 * The freeze a host reported in its handshake, pinned to this computer's
 * clock. Tolerates older hosts (no field) and malformed values.
 */
export function hostStallFromHello(
  hello: { hostHealth?: { lastStall?: SyncHostStall | null } | null } | null | undefined,
  nowMs: number,
): {
  durationMs: number;
  endedAt: number;
  loadAverage1m?: number;
  cpuCount?: number;
  restarted?: boolean;
} | null {
  const stall = hello?.hostHealth?.lastStall;
  if (!stall || typeof stall !== "object") return null;
  const durationMs = Number(stall.durationMs);
  const agoMs = Number(stall.agoMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(agoMs) || agoMs < 0) return null;
  const load = Number(stall.loadAverage1m);
  const cores = Number(stall.cpuCount);
  return {
    durationMs,
    endedAt: nowMs - agoMs,
    ...(Number.isFinite(load) && load > 0 ? { loadAverage1m: load } : {}),
    ...(Number.isInteger(cores) && cores > 0 ? { cpuCount: cores } : {}),
    ...(stall.restarted === true ? { restarted: true } : {}),
  };
}
