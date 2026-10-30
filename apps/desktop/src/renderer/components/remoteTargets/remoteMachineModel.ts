import { extractError } from "../../lib/format";
import { updateTrackOfVersion, type UpdateTrack } from "../../../shared/updateTrack";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectErrorInfo,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTargetRoute,
  RemoteRuntimeTargetRouteSource,
} from "../../../shared/types";
import { isTailnetHostname } from "../../../shared/tailnet";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import { formatMachineVersions, machineComparableVersion } from "../../../shared/machineVersions";
import {
  accountMachineConnectionState,
  accountMachineEndpointHost,
} from "../../../shared/accountDirectory";
import {
  buildPairingQrPayload,
  encodePairingQrUrl,
} from "../../../shared/pairingQr";
import type {
  SyncAccountDirectoryState,
  SyncAddressCandidate,
  SyncPeerPlatform,
} from "../../../shared/types/sync";
import { createSyncAccountDirectoryHealth } from "../../../shared/types/sync";
import {
  describeUnpublishedAccountDirectory,
  thisComputerAction,
  type ThisComputerAction,
} from "../../../shared/types/sync";
import { appPackageChannelDisplayName, normalizeAppPackageChannel, type AppPackageChannel } from "../../../shared/packageChannel";
import {
  readAccountRefusalCode,
  type AccountMachineRefusalCode,
} from "../../../shared/accountMachineRefusal";

// ---------------------------------------------------------------------------
// Route identity + discovered-machine helpers (framework-free, unit-tested via
// the panel). Kept in one module so the section model and the connect flow
// agree on how a saved target and a discovered machine map to the same box.
// ---------------------------------------------------------------------------

function normalizeRouteHost(hostname: string | null | undefined): string {
  return hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
}

function normalizeRoutePort(port: number | null | undefined): number {
  return port ?? 22;
}

export function routeIdentity(
  hostname: string | null | undefined,
  port: number | null | undefined,
): string | null {
  const host = normalizeRouteHost(hostname);
  if (!host) return null;
  return `${host}:${normalizeRoutePort(port)}`;
}

function discoveredRouteSource(
  machine: RemoteRuntimeDiscoveredMachine,
  hostname: string,
): RemoteRuntimeTargetRouteSource {
  if (
    (machine.runtimeKind ?? "").startsWith("tailscale-peer") ||
    hostname === machine.tailscaleAddress ||
    isTailnetHostname(hostname)
  ) {
    return "tailscale";
  }
  return "bonjour";
}

export function discoveredSshRoutes(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetRoute[] {
  const hostnames = [
    machine.tailscaleAddress,
    machine.primaryRoute,
    machine.hostName,
    ...machine.addresses,
  ];
  const routes: RemoteRuntimeTargetRoute[] = [];
  const seen = new Set<string>();
  for (const value of hostnames) {
    const hostname = value?.trim().replace(/\.$/, "");
    if (!hostname) continue;
    const key = hostname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      hostname,
      port: null,
      source: discoveredRouteSource(machine, hostname),
      lastSucceededAt: null,
    });
  }
  return routes;
}

export function discoveredRoute(
  machine: RemoteRuntimeDiscoveredMachine,
): string | null {
  return (
    machine.tailscaleAddress ??
    machine.primaryRoute ??
    machine.hostName ??
    machine.addresses[0] ??
    null
  );
}

function discoveredPlatform(machine: RemoteRuntimeDiscoveredMachine): SyncPeerPlatform {
  const value = machine.os?.trim().toLowerCase() ?? "";
  if (value.includes("darwin") || value.includes("mac")) return "macOS";
  if (value.includes("linux")) return "linux";
  if (value.includes("windows")) return "windows";
  return "unknown";
}

/**
 * Builds the same PIN-gated direct pairing payload a copied link carries, but
 * from an ADE runtime found on LAN/Tailscale. Raw tailnet peers are deliberately
 * excluded: merely appearing in a tailnet is not consent to an SSH setup.
 */
export function discoveredPairingInput(
  machine: RemoteRuntimeDiscoveredMachine,
): string | null {
  const deviceId = machine.hostIdentity?.trim();
  if (!deviceId || isSshOnlyDiscovered(machine) || machine.connectable === false) {
    return null;
  }

  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    const host = value?.trim().replace(/\.$/, "");
    if (!host || seen.has(host.toLowerCase())) return;
    if (/^(?:localhost|127(?:\.|$)|::1$)/i.test(host)) return;
    seen.add(host.toLowerCase());
    candidates.push({
      host,
      kind: host === machine.tailscaleAddress || isTailnetHostname(host)
        ? "tailscale"
        : "lan",
    });
  };

  addCandidate(machine.primaryRoute);
  addCandidate(machine.hostName);
  for (const address of machine.addresses) addCandidate(address);
  addCandidate(machine.tailscaleAddress);
  if (candidates.length === 0) return null;

  return encodePairingQrUrl(buildPairingQrPayload({
    connectInfo: {
      hostIdentity: {
        deviceId,
        siteId: "",
        name: machine.machineName,
        platform: discoveredPlatform(machine),
        deviceType: "desktop",
      },
      port: machine.port,
      addressCandidates: candidates,
    },
  }));
}

export function discoveredTargetInput(
  machine: RemoteRuntimeDiscoveredMachine,
): RemoteRuntimeTargetInput | null {
  const route = discoveredRoute(machine);
  if (!route) return null;
  return {
    name: machine.machineName,
    hostname: route.replace(/\.$/, ""),
    sshUser: null,
    port: null,
    sshKeyPath: null,
    routes: discoveredSshRoutes(machine),
  };
}

export function targetRouteIdentities(
  target: RemoteRuntimeTarget,
): Set<string> {
  const identities = new Set<string>();
  const primary = routeIdentity(target.hostname, target.port);
  if (primary) identities.add(primary);
  for (const route of target.routes ?? []) {
    const identity = routeIdentity(route.hostname, route.port ?? target.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

function discoveredMachineRouteIdentities(
  machine: RemoteRuntimeDiscoveredMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const route of discoveredSshRoutes(machine)) {
    const identity = routeIdentity(route.hostname, route.port);
    if (identity) identities.add(identity);
  }
  return identities;
}

export function machineMatchesSavedTarget(
  machine: RemoteRuntimeDiscoveredMachine,
  target: RemoteRuntimeTarget,
): boolean {
  const discovered = discoveredMachineRouteIdentities(machine);
  if (discovered.size === 0) return false;
  const saved = targetRouteIdentities(target);
  for (const identity of discovered) {
    if (saved.has(identity)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Local "This computer" route-publish health
// ---------------------------------------------------------------------------

/** Publish-health slice the runtime status IPC exposes for this machine. */
export type LocalPublishHealth = {
  state: SyncAccountDirectoryState;
  failingSinceMs: number | null;
  /**
   * Last directory HTTP status and its bounded classified reason. Present on
   * current runtimes; a 403 refusal decodes from these so the banner can tell
   * "the directory answered and refused" from "we could not reach it".
   */
  lastHttpStatus?: number | null;
  lastHttpReason?: string | null;
};

/**
 * A refusal the directory answered with, decoded for the Machine banner. Null
 * when the failure is an ordinary transport/server error or nothing at all —
 * those keep the reachability wording.
 */
export type PublishRefusal = {
  code: AccountMachineRefusalCode;
  /** Lowercase, as the shared advice table words it. */
  summary: string;
  actionLabel: string;
};

export function describePublishRefusal(
  publishHealth: LocalPublishHealth | null | undefined,
): PublishRefusal | null {
  if (!publishHealth) return null;
  const code = readAccountRefusalCode(createSyncAccountDirectoryHealth(
    publishHealth.state,
    null,
    {
      lastHttpStatus: publishHealth.lastHttpStatus ?? null,
      lastHttpReason: publishHealth.lastHttpReason ?? null,
    },
  ));
  if (code === "machine_revoked") {
    return {
      code,
      summary: "this computer was removed from your ADE account",
      actionLabel: "Reconnect this computer",
    };
  }
  if (code === "pairing_authentication_required") {
    return {
      code,
      summary: "confirm it's you to reconnect this computer",
      actionLabel: "Confirm it's you",
    };
  }
  return null;
}

export type PublishHealthDisplay =
  | { kind: "none" }
  | { kind: "healthy" }
  | { kind: "failing"; minutes: number };

/** A publish failure must persist at least this long before we alarm the user. */
export const PUBLISH_FAILING_ALARM_MS = 2 * 60_000;

/**
 * Non-publishing states: this computer isn't advertising routes to the account
 * directory (sync off, not the host, signed out, …). There is nothing wrong to
 * surface, so these read as "none" rather than a failure.
 */
const PUBLISH_INACTIVE_STATES: ReadonlySet<SyncAccountDirectoryState> = new Set([
  "sync_disabled",
  // `sync_not_started` is deliberately NOT here. The brain reports it with
  // `failingSinceMs` set to when it first found no sync host on this computer,
  // so a boot-time blip stays quiet under the alarm threshold and a host that
  // never comes back (2026-09-21: a dev brain took the lease and exited) gets
  // the card with its Start sync button.
  "no_active_sync_scope",
  "not_host",
  "account_signed_out",
  "machine_key_unavailable",
  "missing_pairing_connect_info",
]);

/**
 * Classifies the local machine's route-publish health for the Machines panel.
 * "published" is healthy; the inactive states surface nothing; every other
 * state is a genuine failure but only alarms once it has persisted at least two
 * minutes (and only when we know since when), so a transient blip stays quiet.
 */
export function describePublishHealth(
  publishHealth: LocalPublishHealth | null | undefined,
  nowMs: number = Date.now(),
): PublishHealthDisplay {
  if (!publishHealth) return { kind: "none" };
  const { state, failingSinceMs } = publishHealth;
  if (state === "published") return { kind: "healthy" };
  if (PUBLISH_INACTIVE_STATES.has(state)) return { kind: "none" };
  if (failingSinceMs == null) return { kind: "none" };
  const elapsedMs = Math.max(0, nowMs - failingSinceMs);
  if (elapsedMs < PUBLISH_FAILING_ALARM_MS) return { kind: "none" };
  return { kind: "failing", minutes: Math.floor(elapsedMs / 60_000) };
}

/** The publisher health shape `thisComputerAction` needs to decode a refusal. */
function accountDirectoryHealthFromPublishHealth(
  publishHealth: LocalPublishHealth,
): ReturnType<typeof createSyncAccountDirectoryHealth> {
  return createSyncAccountDirectoryHealth(publishHealth.state, null, {
    lastHttpStatus: publishHealth.lastHttpStatus ?? null,
    lastHttpReason: publishHealth.lastHttpReason ?? null,
  });
}

export type ThisComputerCardModel = {
  tone: "healthy" | "warning";
  /** The one sentence of truth about this computer, from the shared advice table. */
  summary: string;
  /** The one button, its label already deciding Reconnect / Sign in / Retry. */
  action: ThisComputerAction;
};

/**
 * The single owner of this computer's publication state, shared by the
 * Connections popover's card and the Account tab's card. The sentence is the
 * shared advice table's, never a hand-written second copy; the button label is
 * `thisComputerAction`, which reads the brain's refusal code.
 *
 * Returns null when there is nothing worth a card: healthy machines and inactive
 * states (sync off, not this computer's turn) show no publication status.
 */
export function describeThisComputerCard(
  publishHealth: LocalPublishHealth | null | undefined,
): ThisComputerCardModel | null {
  if (!publishHealth) return null;
  const display = describePublishHealth(publishHealth);
  if (display.kind === "none") return null;
  const health = accountDirectoryHealthFromPublishHealth(publishHealth);
  if (display.kind === "healthy") {
    return {
      tone: "healthy",
      summary: "signed in and published to your ADE account",
      action: { label: null, needsSignIn: false, retry: false, startSync: false },
    };
  }
  return {
    tone: "warning",
    summary: describeUnpublishedAccountDirectory(publishHealth.state, health).summary,
    action: thisComputerAction(publishHealth.state, health),
  };
}

/**
 * The product word in front of a build: "ADE", "ADE Alpha", or "ADE Beta"
 * for a stable-channel build on the Beta track (read from its version).
 */
export function channelProductName(
  channel: AppPackageChannel | string | null | undefined,
  version?: string | null,
): string {
  const normalized = normalizeAppPackageChannel(channel);
  if (normalized !== "stable") return appPackageChannelDisplayName(normalized);
  return updateTrackOfVersion(version) === "beta" ? "ADE Beta" : "ADE";
}

/**
 * This computer's own version line, channel first: "ADE Alpha 1.2.75-alpha.…".
 * The brain's reported version is the one that matches what actually runs;
 * the desktop package version is only a fallback for a brain that cannot
 * answer, and the caller is told which one it got so it can say so.
 */
export function formatThisComputerVersion(args: {
  brainVersion: string | null | undefined;
  packageVersion: string | null | undefined;
  channel: AppPackageChannel | string | null | undefined;
}): { text: string; source: "brain" | "package" } | null {
  const brain = args.brainVersion?.trim();
  const packageVersion = args.packageVersion?.trim();
  const product = channelProductName(args.channel, args.brainVersion ?? args.packageVersion);
  // When the brain and this app differ, both: "ADE 1.2.123 · brain 1.2.125".
  if (brain) return { text: `${product} ${formatMachineVersions({ brainVersion: brain, appVersion: packageVersion })}`, source: "brain" };
  if (packageVersion) return { text: `${product} ${packageVersion}`, source: "package" };
  return null;
}

/**
 * A machine's versions as a connection reports them. `version` decides
 * whether it is behind: the older of its brain and its desktop app, so a
 * machine whose app is behind never reads as up to date. `versionLabel` is
 * what to show: one version, or both when they drift
 * ("1.2.123 · brain 1.2.125"). The app version is only trusted beside the
 * live version it was read with.
 */
export function machineVersionFacts(
  status: Pick<RemoteRuntimeConnectionStatus, "version" | "appVersion"> | null | undefined,
  target: Pick<RemoteRuntimeTarget, "runtimeBinaryVersion"> | null | undefined,
): { version: string | null; versionLabel: string | null } {
  const live = status?.version?.trim() || null;
  const versions = {
    brainVersion: live ?? target?.runtimeBinaryVersion ?? null,
    appVersion: live ? status?.appVersion ?? null : null,
  };
  return { version: machineComparableVersion(versions), versionLabel: formatMachineVersions(versions) };
}

// ---------------------------------------------------------------------------
// Labels + formatting
// ---------------------------------------------------------------------------

export function formatLastSeen(value: number | null): string {
  if (!value) return "Never connected";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Last connection unknown";
  const phrase = relativeLastSeenPhrase(value);
  return phrase ? `Last connected ${phrase}` : "Last connection unknown";
}

export function isVersionSkewWarning(warning: string): boolean {
  return /Remote ADE service reported|RPC capabilities (?:are compatible|match)|versions differ but their RPC|They can still connect — update the other machine/i.test(
    warning,
  );
}

/**
 * Relative last-seen bucket ("just now", "5m ago", "3h ago", "2d ago"), or
 * null when the machine has never been seen. Callers own the surrounding
 * framing ("Last seen …", "Seen …") so each surface keeps its voice.
 */
export function relativeLastSeenPhrase(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null;
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "kind · host" label for an account machine's advertised endpoint. */
export function formatMachineEndpoint(
  endpoint: AdeAccountMachine["reachableEndpoints"][number],
): string {
  const detail = endpoint.host ?? endpoint.url ?? "";
  return detail ? `${endpoint.kind} · ${detail}` : endpoint.kind;
}

export function connectionStateLabel(
  connection: RemoteRuntimeConnectionStatus | null,
  connectedFallback: boolean,
): string {
  if (connection?.state === "connected" || (!connection && connectedFallback))
    return "Connected";
  if (connection?.state === "connecting") return "Connecting";
  if (connection?.state === "error") return "Connection failed";
  return "Not connected";
}

/**
 * Why a saved machine that is not connected will not come back on its own, in
 * words for its row. Null when it will reconnect, or when it never connected
 * (a first Connect turns auto-connect on, so there is nothing to explain yet).
 * A manual disconnect is the stronger reason and wins over the preference.
 */
export function autoConnectOffReason(
  target: Pick<RemoteRuntimeTarget, "autoConnect" | "lastConnectedAt" | "manuallyDisconnectedAt">,
): string | null {
  if (target.manuallyDisconnectedAt != null) {
    const day = new Date(target.manuallyDisconnectedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    return `you disconnected it on ${day}`;
  }
  if (target.autoConnect === false && target.lastConnectedAt != null) {
    return "Reconnect automatically is off";
  }
  return null;
}

/** True when a discovered machine is a raw SSH peer with no ADE runtime. */
export function isSshOnlyDiscovered(
  machine: RemoteRuntimeDiscoveredMachine,
): boolean {
  return (machine.runtimeKind ?? "").startsWith("tailscale-peer");
}

export function formatRemoteTargetError(error: unknown): string {
  // Keep the raw IPC wrapper text for SSH detection. Stripping
  // `ade.remoteRuntime.getSshHostKeyTrust` first would leave a bare
  // `ECONNRESET` and incorrectly blame a paired ADE port.
  const raw = extractError(error).trim();
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  // No word-boundary: camelCase IPC names embed `Ssh` without `\b` edges.
  const sshHint = /ssh|sshd|remote login/i.test(raw);

  // The main process answers with a named, timed message well inside the IPC
  // ceiling, so this only shows when that answer was lost to the ceiling itself.
  if (/IPC handler for 'ade\.account\.pairMachine' timed out/i.test(message)) {
    return "ADE stopped waiting for that computer before it finished connecting. Make sure ADE is open on it, then try again.";
  }

  if (/ECONNRESET/i.test(message)) {
    return sshHint
      ? "SSH server closed the connection before ADE could finish the SSH handshake. Check that Remote Login/sshd is enabled on the remote machine and try again."
      : "The connection was reset before ADE could finish connecting. Check that the machine is awake and reachable, then try again.";
  }

  if (
    /permission denied|all configured authentication methods failed/i.test(
      message,
    )
  ) {
    return "SSH authentication failed. Check the SSH user, key path, and that this key is allowed on the remote machine.";
  }

  if (/host denied|verification failed|host key verification/i.test(message)) {
    return "SSH host-key verification failed. Check that this is the right machine, then update the saved SSH host key or trust the new key when ADE prompts.";
  }

  if (
    /timed out.*handshake|handshake.*timed out|connect.*timed out/i.test(
      message,
    )
  ) {
    return sshHint
      ? "SSH did not finish connecting. Check that the machine is awake, reachable on Tailscale or LAN, and Remote Login is enabled."
      : "ADE did not finish connecting. Check that the machine is awake and reachable on Tailscale or LAN.";
  }

  if (/ECONNREFUSED/i.test(message)) {
    return sshHint
      ? "The machine refused the SSH connection. Check the port and make sure Remote Login/sshd is running."
      : "The machine refused the connection. Check that ADE is running on that computer and reachable on the saved port.";
  }

  if (
    /ENOTFOUND|could not resolve hostname|name or service not known/i.test(
      message,
    )
  ) {
    return "ADE could not resolve that host. Check the hostname, or use the Tailscale 100.x address from discovery.";
  }

  return message || "Remote connection failed.";
}

// ---------------------------------------------------------------------------
// Error card selection
// ---------------------------------------------------------------------------

export type MachineErrorCard = {
  message: string;
  /** Capped, copyable technical detail from a structured error, when present. */
  detail: string | null;
  /** True when the message came straight from a structured `lastErrorInfo`. */
  structured: boolean;
  /**
   * What the connection actually failed on, straight from the main process.
   * Recovery actions key off this — the message is prose and is never parsed.
   */
  failure: RemoteRuntimeConnectionAttemptFailure | null;
  /** The structured error's kind, when there is one. */
  kind: RemoteRuntimeConnectErrorInfo["kind"] | null;
};

/**
 * A connect error that is the machine's state (asleep, out of disk) or the
 * person's to fix (SSH key, host key, sign-in), not ADE failing. Its banner
 * warns instead of alarming; it keeps Report so the raw error stays at hand.
 */
export function isMachineStateConnectError(kind: RemoteRuntimeConnectErrorInfo["kind"] | null | undefined): boolean {
  return kind != null && kind !== "generic";
}

/**
 * Chooses what a failed connection should show the user. A structured
 * `lastErrorInfo` wins and is shown verbatim (plain-language message + optional
 * technical detail); otherwise the raw error string is run through the
 * plain-English `formatRemoteTargetError` fallback. Returns null when there is
 * nothing to surface.
 */
export function selectMachineErrorCard(args: {
  errorInfo?: RemoteRuntimeConnectErrorInfo | null;
  rawError?: string | null;
  /** A locally-produced message (e.g. from a thrown connect call). */
  overrideMessage?: string | null;
}): MachineErrorCard | null {
  const { errorInfo, rawError, overrideMessage } = args;
  if (errorInfo?.message) {
    return {
      message: errorInfo.message,
      detail: errorInfo.detail?.trim() ? errorInfo.detail : null,
      structured: true,
      failure: errorInfo.failure ?? null,
      kind: errorInfo.kind,
    };
  }
  const fallback =
    overrideMessage?.trim() ||
    (rawError ? formatRemoteTargetError(rawError) : null);
  if (!fallback) return null;
  return { message: fallback, detail: null, structured: false, failure: null, kind: null };
}

// ---------------------------------------------------------------------------
// Section assignment
// ---------------------------------------------------------------------------

export type MachineSection = "connected" | "available" | "unavailable";

export type SavedMachineRow = {
  kind: "saved";
  id: string;
  target: RemoteRuntimeTarget;
  status: RemoteRuntimeConnectionStatus | null;
  connected: boolean;
  /**
   * ADE version on that machine, live when connected: the older of its brain
   * and its desktop app (`machineVersionFacts`). Decides "behind".
   */
  version: string | null;
  /** What to show: one version, or both when the brain and app drift. */
  versionLabel: string | null;
  /** Set only for the unavailable section (offline / unsupported). */
  unavailableReason: string | null;
};

/**
 * Parseability guard, not a comparator: the ordering itself is
 * `compareUpdateVersions`. Anything without a numeric dotted core (or missing)
 * answers null so an odd version string can never conjure an update prompt.
 * The prerelease is kept: every target is on the machine's own track now, so
 * `1.2.127-beta.1` really is behind `1.2.127-beta.2`.
 */
function comparableVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, "") ?? "";
  const core = trimmed.split(/[-+]/)[0] ?? "";
  if (!core) return null;
  return core.split(".").every((part) => part !== "" && Number.isFinite(Number(part))) ? trimmed : null;
}

/** True when `version` is strictly older than `newestVersion`. */
export function isMachineVersionOutdated(
  version: string | null | undefined,
  newestVersion: string | null | undefined,
): boolean {
  const left = comparableVersion(version);
  const right = comparableVersion(newestVersion);
  if (!left || !right) return false;
  return compareUpdateVersions(left, right) < 0;
}

/**
 * True when `version` is parseable and already `targetVersion` or newer.
 * Not the negation of `isMachineVersionOutdated`: an odd version string is
 * neither behind nor current, so a guard that skips "current" machines does
 * not skip it.
 */
export function isMachineVersionCurrent(
  version: string | null | undefined,
  targetVersion: string | null | undefined,
): boolean {
  const left = comparableVersion(version);
  const right = comparableVersion(targetVersion);
  if (!left || !right) return false;
  return compareUpdateVersions(left, right) >= 0;
}

/**
 * What "Update & restart" left behind for one machine. The host's reply is not
 * the outcome: an update that is still in flight (`pendingVersion`) is only
 * done when the machine comes back reporting that version.
 */
export type MachineUpdateAttempt = {
  ok: boolean;
  message: string;
  /** The version the machine should come back on; null when nothing is in flight. */
  pendingVersion: string | null;
  /** True while the far app is still downloading, which takes longer to land. */
  downloading: boolean;
  startedAtMs: number;
};

/** Long enough for an app swap plus the brain restart behind it. */
export const MACHINE_UPDATE_INSTALL_GRACE_MS = 5 * 60_000;
/** A download first, then the same install. */
export const MACHINE_UPDATE_DOWNLOAD_GRACE_MS = 35 * 60_000;

export function machineUpdateGraceMs(attempt: MachineUpdateAttempt): number {
  return attempt.downloading ? MACHINE_UPDATE_DOWNLOAD_GRACE_MS : MACHINE_UPDATE_INSTALL_GRACE_MS;
}

/** Turn the host's reply into an attempt the card can check against the machine. */
export function machineUpdateAttemptFromResult(
  result: {
    ok: boolean;
    message?: string | null;
    updateApplied?: boolean;
    targetVersion?: string | null;
    route?: string;
    pendingVersion?: string | null;
  },
  fallbackMessage: string,
  nowMs: number,
): MachineUpdateAttempt {
  // Hosts from before `pendingVersion` only had the standalone route, where an
  // applied update means the target is what should come back.
  const pendingVersion = !result.ok
    ? null
    : result.pendingVersion !== undefined
      ? result.pendingVersion?.trim() || null
      : result.updateApplied
        ? result.targetVersion?.trim() || null
        : null;
  return {
    ok: result.ok,
    message: result.message?.trim() || fallbackMessage,
    pendingVersion,
    // The terminal route has staged the runtime but still downloads the app
    // installer, so it gets the download grace too.
    downloading: result.ok
      && (result.route === "desktop_app" || result.route === "terminal")
      && result.updateApplied === false
      && pendingVersion != null,
    startedAtMs: nowMs,
  };
}

export type MachineUpdateStatus = {
  ok: boolean;
  message: string;
  /** Still waiting on the machine; the card keeps "Update & restart" busy. */
  inFlight: boolean;
};

/**
 * Check an attempt against the machine as it is now. Landed: the machine
 * reports the version (or newer). Not landed in time: say so plainly, with
 * the version it is actually on, instead of leaving "reconnecting…" up.
 */
export function describeMachineUpdateAttempt(
  attempt: MachineUpdateAttempt,
  machine: { connected: boolean; version: string | null },
  nowMs: number,
): MachineUpdateStatus {
  const pending = attempt.pendingVersion;
  if (!pending) return { ok: attempt.ok, message: attempt.message, inFlight: false };
  if (machine.connected && machine.version && !isMachineVersionOutdated(machine.version, pending)) {
    return { ok: true, message: `Updated to ${machine.version}.`, inFlight: false };
  }
  if (nowMs - attempt.startedAtMs < machineUpdateGraceMs(attempt)) {
    return { ok: true, message: attempt.message, inFlight: true };
  }
  if (machine.connected) {
    return {
      ok: false,
      message: `Still on ${machine.version ?? "an older version"} — the update to ${pending} didn't install on that machine. Press Update to try again.`,
      inFlight: false,
    };
  }
  return {
    ok: false,
    message: `Not back yet after the update to ${pending}. Check that ADE is running on that machine.`,
    inFlight: false,
  };
}

/**
 * The key a machine's color is picked from. The account's machine key when the
 * machine has one, so every device that can see it lands on the same color;
 * the saved target's id otherwise.
 */
export function machineColorKey(target: Pick<RemoteRuntimeTarget, "id" | "pairedMachine">): string {
  return target.pairedMachine?.machineKey?.trim() || target.id;
}

/**
 * Where an update to one machine is, for the row: being asked about, being
 * sent, or waiting on the machine to come back on the new version.
 */
export function machineUpdatePhase(args: {
  checking: boolean;
  sending: boolean;
  status: MachineUpdateStatus | null;
}): "checking" | "sending" | "restarting" | null {
  if (args.sending) return "sending";
  if (args.status?.inFlight) return "restarting";
  if (args.checking) return "checking";
  return null;
}

/** A connected machine and the ADE version it runs, as an update needs it. */
export type ConnectedMachine = {
  id: string;
  name: string;
  /** The older of its brain and desktop app (`machineVersionFacts`). */
  version: string | null;
  /** One version, or both when they drift. */
  versionLabel?: string | null;
  /**
   * The update track it follows, read from its brain's version (machines do
   * not report their saved choice). Absent: the track of `version`.
   */
  track?: UpdateTrack;
  /** What its tile is drawn from (`MachineAvatar`); absent where unknown. */
  colorKey?: string;
  arch?: string | null;
};

/** The machines a connection snapshot says are connected right now. */
export function connectedMachinesFromSnapshot(
  snapshot: RemoteRuntimeConnectionSnapshot | null | undefined,
): ConnectedMachine[] {
  return (snapshot?.connections ?? [])
    .filter((connection) => connection.state === "connected")
    .map((connection) => {
      const facts = machineVersionFacts(connection, connection.target);
      const brainVersion = connection.version?.trim() || connection.target.runtimeBinaryVersion || facts.version;
      return {
        id: connection.target.id,
        name: connection.target.name,
        ...facts,
        track: updateTrackOfVersion(brainVersion),
        colorKey: machineColorKey(connection.target),
        arch: connection.arch ?? connection.target.lastSeenArch ?? null,
      };
    });
}

/** The machines running an ADE older than `newestVersion`. */
export function outdatedMachines<T extends Pick<ConnectedMachine, "version">>(
  machines: readonly T[],
  newestVersion: string | null | undefined,
): T[] {
  return machines.filter((machine) => isMachineVersionOutdated(machine.version, newestVersion));
}

/** The track a machine follows: what it reports, else the track of its version. */
export function machineUpdateTrack(machine: Pick<ConnectedMachine, "version" | "track">): UpdateTrack {
  return machine.track ?? updateTrackOfVersion(machine.version);
}

/**
 * Every ADE version this computer knows exists: the one it runs, the one it
 * downloaded, and the newest its update feed named. During a track switch
 * these sit on both tracks (Beta running, Stable downloaded).
 */
export function knownAdeVersions(snapshot: {
  currentVersion?: string | null;
  latestKnownVersion?: string | null;
  version?: string | null;
} | null | undefined): string[] {
  return [snapshot?.currentVersion, snapshot?.version, snapshot?.latestKnownVersion]
    .map((version) => version?.trim() || "")
    .filter((version) => comparableVersion(version) != null);
}

/**
 * The newest version this computer knows on `track`, or null when it has seen
 * none there (a Beta computer knows no Stable build). Never a build from the
 * other track: "Update" never moves a machine across tracks.
 */
export function newestKnownVersionOnTrack(known: readonly string[], track: UpdateTrack): string | null {
  let newest: string | null = null;
  for (const version of known) {
    if (updateTrackOfVersion(version) !== track) continue;
    if (!newest || isMachineVersionOutdated(newest, version)) newest = version;
  }
  return newest;
}

/**
 * The version to offer `machine`: the newest this computer knows on the
 * machine's own track, when the machine is behind it. Null when it is level,
 * when its version cannot be read, or when this computer knows no build on
 * that track; it is then not called behind, since nothing here can say so.
 */
export function machineUpdateTargetVersion(
  machine: Pick<ConnectedMachine, "version" | "track">,
  known: readonly string[],
): string | null {
  const target = newestKnownVersionOnTrack(known, machineUpdateTrack(machine));
  return target && isMachineVersionOutdated(machine.version, target) ? target : null;
}

/** A machine to update, and the version on its own track it is sent. */
export type MachineUpdateTarget = ConnectedMachine & { targetVersion: string | null };

/** The machines behind the newest build this computer knows on their own track. */
export function machinesBehindOnTheirTrack<T extends ConnectedMachine>(
  machines: readonly T[],
  known: readonly string[],
): Array<T & { targetVersion: string }> {
  return machines.flatMap((machine) => {
    const targetVersion = machineUpdateTargetVersion(machine, known);
    return targetVersion ? [{ ...machine, targetVersion }] : [];
  });
}

export type DiscoveredMachineRow = {
  kind: "discovered";
  id: string;
  machine: RemoteRuntimeDiscoveredMachine;
  unavailableReason: string | null;
};

/**
 * A machine known only through the account directory (#814 Worker) — not saved
 * or discovered locally. Online rows can be adopted+connected via their best
 * reachable endpoint; offline rows grey out with a last-seen + "why offline?".
 */
export type AccountMachineRow = {
  kind: "account";
  id: string;
  machine: AdeAccountMachine;
  /** The saved target this account machine maps to, if any (enables the doctor). */
  matchedTargetId: string | null;
};

export type MachineRow = SavedMachineRow | DiscoveredMachineRow | AccountMachineRow;

export type MachineSections = {
  connected: MachineRow[];
  available: MachineRow[];
  unavailable: MachineRow[];
};

/**
 * Host identities advertised by an account machine's reachable endpoints, keyed
 * at the default SSH port. The advertised endpoint port is the ADE service port
 * (e.g. 8787), not an SSH port, so it is deliberately ignored when building the
 * identity — otherwise an account machine would never dedupe against its saved
 * SSH target or a discovered peer (both keyed at :22) and would surface as a
 * duplicate row.
 */
export function accountMachineRouteIdentities(
  machine: AdeAccountMachine,
): Set<string> {
  const identities = new Set<string>();
  for (const endpoint of machine.reachableEndpoints) {
    const host = accountMachineEndpointHost(endpoint);
    const identity = routeIdentity(host, null);
    if (identity) identities.add(identity);
  }
  return identities;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

/** True when an account machine is the same host as a saved target. */
export function accountMachineMatchesTarget(
  machine: AdeAccountMachine,
  target: RemoteRuntimeTarget,
): boolean {
  const pairedHostIdentity = target.pairedMachine?.hostIdentity?.trim();
  const pairedMachineKey = target.pairedMachine?.machineKey?.trim();
  if (
    (pairedHostIdentity && machine.deviceId?.trim() === pairedHostIdentity)
    || (pairedMachineKey && machine.machineKey.trim() === pairedMachineKey)
  ) {
    return true;
  }
  const machineIds = accountMachineRouteIdentities(machine);
  if (machineIds.size === 0) return false;
  return intersects(machineIds, targetRouteIdentities(target));
}

/** True when an account machine is the same host as a locally-discovered machine. */
export function accountMachineMatchesDiscovered(
  machine: AdeAccountMachine,
  discovered: RemoteRuntimeDiscoveredMachine,
): boolean {
  if (
    machine.deviceId?.trim()
    && discovered.hostIdentity?.trim() === machine.deviceId.trim()
  ) {
    return true;
  }
  const machineIds = accountMachineRouteIdentities(machine);
  if (machineIds.size === 0) return false;
  return intersects(machineIds, discoveredMachineRouteIdentities(discovered));
}

/**
 * Splits saved targets and discovered machines into the CONNECTED / AVAILABLE /
 * UNAVAILABLE buckets the panel renders. A discovered machine that is already
 * saved is represented by its saved row only (no duplicate). A saved target
 * that matches an unreachable discovered machine (offline / unsupported OS)
 * inherits that unavailability so it greys out with a concrete reason.
 */
export function assignMachineSections(args: {
  targets: RemoteRuntimeTarget[];
  statusById: Map<string, RemoteRuntimeConnectionStatus>;
  connectedFallbackId: string | null;
  discoveredMachines: RemoteRuntimeDiscoveredMachine[];
  /** Machines from the account directory, merged with saved/discovered. */
  accountMachines?: AdeAccountMachine[];
  /** Keep discovery useful for saved/account dedupe without rendering raw peers. */
  includeDiscoveredRows?: boolean;
}): MachineSections {
  const {
    targets,
    statusById,
    connectedFallbackId,
    discoveredMachines,
    accountMachines = [],
    includeDiscoveredRows = true,
  } = args;
  const sections: MachineSections = {
    connected: [],
    available: [],
    unavailable: [],
  };

  const claimedMachineIds = new Set<string>();

  for (const target of targets) {
    const status = statusById.get(target.id) ?? null;
    const connected = status
      ? status.state === "connected"
      : target.id === connectedFallbackId;

    const match = discoveredMachines.find((machine) =>
      machineMatchesSavedTarget(machine, target),
    );
    if (match) claimedMachineIds.add(match.id);

    if (connected) {
      sections.connected.push({
        kind: "saved",
        id: target.id,
        target,
        status,
        connected: true,
        ...machineVersionFacts(status, target),
        unavailableReason: null,
      });
      continue;
    }

    if (match && match.connectable === false) {
      sections.unavailable.push({
        kind: "saved",
        id: target.id,
        target,
        status,
        connected: false,
        ...machineVersionFacts(status, target),
        unavailableReason: match.unsupportedReason ?? "Offline",
      });
      continue;
    }

    sections.available.push({
      kind: "saved",
      id: target.id,
      target,
      status,
      connected: false,
      ...machineVersionFacts(status, target),
      unavailableReason: null,
    });
  }

  for (const machine of discoveredMachines) {
    if (claimedMachineIds.has(machine.id)) continue;
    if (targets.some((target) => machineMatchesSavedTarget(machine, target))) {
      continue;
    }
    if (!includeDiscoveredRows) continue;
    if (machine.connectable === false) {
      sections.unavailable.push({
        kind: "discovered",
        id: machine.id,
        machine,
        unavailableReason:
          machine.unsupportedReason ??
          (machine.os?.toLowerCase() === "windows"
            ? "Windows — not supported yet"
            : "Offline"),
      });
      continue;
    }
    sections.available.push({
      kind: "discovered",
      id: machine.id,
      machine,
      unavailableReason: null,
    });
  }

  // Account-directory machines are merged in as a third source. Any that already
  // map to a saved target or a discovered machine are represented by that local
  // row (no duplicate); the rest surface as their own rows — online in
  // AVAILABLE, offline greyed in UNAVAILABLE.
  for (const machine of accountMachines) {
    const matchedTarget = targets.find((target) =>
      accountMachineMatchesTarget(machine, target),
    );
    if (matchedTarget) {
      // A saved target already owns this host; only annotate offline account
      // machines whose target isn't otherwise flagged (rare) — otherwise skip.
      continue;
    }
    if (
      includeDiscoveredRows &&
      discoveredMachines.some((discovered) =>
        accountMachineMatchesDiscovered(machine, discovered),
      )
    ) {
      continue;
    }
    const row: AccountMachineRow = {
      kind: "account",
      id: `account:${machine.machineKey}`,
      machine,
      matchedTargetId: null,
    };
    if (accountMachineConnectionState(machine) === "available") {
      sections.available.push(row);
    } else {
      sections.unavailable.push(row);
    }
  }

  return sections;
}
