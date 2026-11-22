import React from "react";
import type { AppInfo, AutoUpdateSnapshot } from "../../../../shared/types";
import type { DiskPressureSnapshot, RuntimeHealthSnapshot } from "../../../../shared/types/storage";
import type { ProjectHealthIssue, ProjectHealthReport } from "../../../../shared/types/projectHealth";
import type { UsageSnapshot } from "../../../../shared/types/usage";
import type { AiProviderConnectionStatus } from "../../../../shared/types/config";
import { isBackgroundItemBlocked } from "../../../../shared/types/core";
import { cloudMachineResting, selfUpdatingCloudMachineKeys } from "../../../../shared/adeCloud";
import { adeCloudEnabled } from "../../../state/cloudAccess";
import type { AiConfig } from "../../../../shared/types/config";
import type { ProviderInstance } from "../../../../shared/types/providerInstances";
import { isProviderDisabled } from "../../../../shared/providerEnablement";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { RELAY_HELD_BY_OTHER_ADE_APP } from "../../../../shared/connectionDiagnosis";
import { ACCOUNT_SCOPE_ALL } from "../../../../shared/accountSettingsScope";
import { MCP_SERVERS_SETTING_KEY, normalizeMcpRegistry } from "../../../../shared/mcpRegistry";
import { humanizeProvider } from "../../usage/usageProviderNames";
import {
  connectedMachinesFromSnapshot,
  knownAdeVersions,
  machinesBehindOnTheirTrack,
} from "../../remoteTargets/remoteMachineModel";
import { cloudBoxForMachine } from "../../remoteTargets/cloudMachineModel";
import { readSelfUpdatingCloudKeys, withoutSelfUpdatingCloud } from "../../remoteTargets/machineUpdates";
import { watchedCloudMachines } from "../../remoteTargets/useCloudMachines";
import { missingMcpSecrets } from "../mcp/useMcpRegistry";
import { settingsRouteFor } from "../settingsManifest";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { isDegradedSyncSnapshot } from "../../../lib/localSyncStatusReader";
import type { OpenProjectBinding } from "../../../../shared/types";
import { onlineCopyPin, settingsCopyScope, useProjectCopyPage, useThisComputerCopyPin } from "../ProjectCopyScope";

/**
 * Settings → General's "Needs attention": every problem ADE can see, from
 * the open project and from this computer, in one list.
 *
 * Read once when the page opens and again on "Check again"; never polled.
 * The cheap reads run at once; the ones that reach the network or spawn a
 * process (MCP sign-ins, Linear, Jira) run after the first paint so they
 * never hold the list back. A read missing on this build contributes nothing;
 * a read that fails adds one "couldn't check" row, so a failure never reads
 * as "Nothing needs attention".
 *
 * Remote machines: the project's reads are unpinned, which is the tab's own
 * binding, i.e. the machine that owns the open project. Everything about
 * "this computer" (service, updates, the ade command, disk, sync, other
 * machines) is plain IPC to the computer ADE runs on, so its rows say so.
 */

export type AttentionSeverity = "problem" | "warning" | "note";

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  title: string;
  /** One line under the title, also handed to the agent. */
  detail?: string;
  /** What the row counts, one line each (the failing calls, the folders). */
  items?: string[];
  /** Where it lives, before the detail: "Project", "This computer", "Providers"… */
  where: string;
  /** The settings page that holds it. */
  route: string;
  /** ADE's own fix, when there is one. */
  fix?: { label: string; run: () => Promise<void>; confirm?: string };
  /** The project check behind the row, when it is one. */
  projectIssue?: ProjectHealthIssue;
};

export type OverviewSources = {
  info: AppInfo | null;
  update: AutoUpdateSnapshot | null;
  pressure: DiskPressureSnapshot | null;
  runtimeHealth: RuntimeHealthSnapshot | null;
  report: ProjectHealthReport | null;
  usage: UsageSnapshot | null;
  providers: AiProviderConnectionStatus[];
};

const EMPTY_SOURCES: OverviewSources = {
  info: null,
  update: null,
  pressure: null,
  runtimeHealth: null,
  report: null,
  usage: null,
  providers: [],
};

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { problem: 0, warning: 1, note: 2 };

/** The read's value, or null when it is missing or fails; a failure adds `label` to `failed`. */
async function quiet<T>(read: (() => Promise<T>) | null | undefined, failed?: string[], label?: string): Promise<T | null> {
  if (!read) return null;
  try {
    return await read();
  } catch {
    if (failed && label) failed.push(label);
    return null;
  }
}

function readFailureItem(failed: string[], recheck: () => Promise<void>): AttentionItem[] {
  if (failed.length === 0) return [];
  const names = failed.length === 1 ? failed[0]! : `${failed.slice(0, -1).join(", ")} and ${failed[failed.length - 1]}`;
  return [{
    id: "overview-read-failed",
    severity: "warning",
    title: failed.length === 1 ? `ADE couldn't check ${names}` : `ADE couldn't check ${failed.length} things`,
    detail: `Couldn't read ${names}, so this list may be missing something.`,
    where: "General",
    route: settingsRouteFor("overview.attention"),
    fix: { label: "Check again", run: recheck },
  }];
}

// ── What each source says is wrong ────────────────────────────────────────

function serviceItems(info: AppInfo | null, health: RuntimeHealthSnapshot | null): AttentionItem[] {
  const runtime = info?.localRuntime;
  const route = settingsRouteFor("storage.diagnostics");
  const items: AttentionItem[] = [];
  const restart = isAdeAvailable(window.ade?.app?.restartBackgroundService)
    ? { label: "Restart service", run: () => window.ade.app.restartBackgroundService!() }
    : undefined;
  if (runtime) {
    if (isBackgroundItemBlocked(runtime)) {
      items.push({
        id: "service-blocked",
        severity: "problem",
        title: "macOS is blocking ADE's background service",
        detail: "Turn on ADE in System Settings → General → Login Items → Allow in the Background.",
        where: THIS_MACHINE_NAME,
        route,
      });
    } else if (runtime.connectionState !== "connected" || runtime.runtimeMode !== "primary" || runtime.serviceHealth.state === "error") {
      items.push({
        id: "service-down",
        severity: "problem",
        title: runtime.runtimeMode === "primary" ? "The background service isn't answering" : "ADE is running without its background service",
        detail: runtime.serviceHealth.message ?? runtime.serviceInstall.message ?? "Chats and terminals may not start, and other devices can't reach this computer.",
        where: THIS_MACHINE_NAME,
        route,
        fix: restart,
      });
    } else if (runtime.versionSkew.state === "runtime_older" || runtime.versionSkew.state === "runtime_newer" || runtime.versionSkew.state === "build_mismatch") {
      items.push({
        id: "service-version",
        severity: "warning",
        title: "The background service runs a different ADE version",
        detail: runtime.versionSkew.message ?? "Restart the service so it matches this app.",
        where: THIS_MACHINE_NAME,
        route,
        fix: restart,
      });
    }
  }
  const failed = health?.failedActions24h ?? 0;
  if (failed > 0) {
    const top = health?.failedActionsTop ?? [];
    const [first] = top;
    items.push({
      id: "service-failures",
      severity: "warning",
      title: failed === 1 ? "1 background service call failed today" : `${failed} background service calls failed today`,
      detail: first
        ? `Most often ${first.action}${first.count > 1 ? ` (${first.count} times)` : ""}. Errors and timeouts in the last 24 hours.`
        : "Errors and timeouts in the last 24 hours.",
      items: top.map((entry) => `${entry.action} × ${entry.count}${entry.lastError ? ` — ${entry.lastError}` : ""}`),
      where: THIS_MACHINE_NAME,
      route,
    });
  }
  return items;
}

function updateItems(update: AutoUpdateSnapshot | null): AttentionItem[] {
  if (!update) return [];
  const route = settingsRouteFor("general.auto-updates");
  if (update.installMode !== "manual" && update.lastInstallFailed && update.status === "ready" && update.lastInstallFailed.targetVersion === update.version) {
    return [{
      id: "update-install-failed",
      severity: "warning",
      title: `ADE ${update.lastInstallFailed.targetVersion} didn't install`,
      detail: "ADE restarted on the old version. Try again from ADE service.",
      where: THIS_MACHINE_NAME,
      route,
    }];
  }
  if (update.installMode !== "manual" && update.parked) {
    return [{
      id: "update-parked",
      severity: "warning",
      title: "An update is waiting and couldn't start",
      detail: "Open ADE service to install it.",
      where: THIS_MACHINE_NAME,
      route,
    }];
  }
  if (update.status === "error" || update.error) {
    return [{
      id: "update-error",
      severity: "warning",
      title: "ADE couldn't check for updates",
      detail: update.error ?? undefined,
      where: THIS_MACHINE_NAME,
      route,
      fix: { label: "Check again", run: () => window.ade.updateCheckForUpdates() },
    }];
  }
  return [];
}

function pressureItems(pressure: DiskPressureSnapshot | null): AttentionItem[] {
  if (!pressure || (pressure.state !== "warning" && pressure.state !== "critical" && pressure.state !== "exhausted")) return [];
  const urgent = pressure.state !== "warning";
  const gb = pressure.freeBytes / 1024 ** 3;
  return [{
    id: "disk-pressure",
    severity: urgent ? "problem" : "warning",
    title: urgent ? "The disk is almost full" : "The disk is getting full",
    detail: `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB free.${urgent ? " ADE is pausing heavy work." : ""}`,
    where: THIS_MACHINE_NAME,
    route: settingsRouteFor("storage.usage"),
  }];
}

/**
 * A provider is a problem only when you use it and it can't start chats.
 * "You use it" means you are signed in to it here, or ADE has a Claude or
 * Codex account of yours on this machine that names someone (an email or a
 * plan), that usage found signed out, or whose saved login broke. Only those
 * accounts (the ones with an `instanceId`) track ADE's own login: usage lists
 * a Cursor account from the Cursor editor's session, which says nothing about
 * ADE's Cursor key. Usage always lists each default account, named or not, so
 * an unnamed one is not "used". A login that left no trace reads the same as
 * one never made. A blocker alone
 * is not a problem: a provider you never set up has one ("not signed in"), so
 * does one whose runtime is still on its way ("downloads the first time it is
 * used"), and so does one that runs fine with a side note (a Codex token too
 * old for usage polling, a Muse login the Keychain hides). A provider you
 * switched off is your choice.
 */
function providerItems(
  providers: readonly AiProviderConnectionStatus[],
  ai: Pick<AiConfig, "disabledProviders"> | null | undefined,
  usage: UsageSnapshot | null,
  accounts: readonly ProviderInstance[],
): AttentionItem[] {
  // A provider whose signed-out account usage already lists (`usageItems`) is not listed twice.
  const listedByUsage = new Set<string>((usage?.balanceIssues ?? []).filter((issue) => issue.kind === "signed_out").map((issue) => issue.provider));
  const usedHere = new Set<string>([
    ...(usage?.accounts ?? [])
      .filter((account) => account.instanceId && !account.notSignedInHere
        && (account.email || account.plan || account.login === "signed_out"))
      .map((account) => account.provider),
    ...accounts.filter((account) => account.loginBroken).map((account) => account.provider),
  ].filter((provider) => !listedByUsage.has(provider)));
  return providers.flatMap((provider): AttentionItem[] => {
    if (provider.runtimeAvailable || provider.runtimeDownloadPending || isProviderDisabled(ai, provider.provider)) return [];
    const lostLogin = !provider.authAvailable && usedHere.has(provider.provider);
    if (!provider.authAvailable && !lostLogin) return [];
    const name = humanizeProvider(provider.provider);
    // A provider without its own page (Devin, for one) opens the Providers grid.
    const ownRoute = settingsRouteFor(`agents.provider.${provider.provider}`);
    const route = ownRoute === "/settings" ? settingsRouteFor("agents.providers") : ownRoute;
    return [{
      id: `provider-${provider.provider}`,
      severity: "warning",
      title: lostLogin ? `${name} is signed out` : `${name} can't start chats`,
      detail: provider.blocker ?? (lostLogin ? "Sign in again to use it here." : "You're signed in, but ADE couldn't start it."),
      where: "Providers",
      route,
    }];
  });
}

function usageItems(usage: UsageSnapshot | null): AttentionItem[] {
  if (!usage) return [];
  const route = settingsRouteFor("stats.usage");
  const items: AttentionItem[] = (usage.balanceIssues ?? [])
    .filter((issue) => issue.kind === "signed_out")
    .map((issue, index) => ({
      id: `usage-balance-${issue.provider}-${index}`,
      severity: "warning" as const,
      title: issue.title,
      detail: issue.detail,
      where: "Providers",
      route: settingsRouteFor("agents.providers"),
    }));
  if (usage.spendControlReached) {
    items.push({
      id: "usage-spend-cap",
      severity: "warning",
      title: "Your spend cap is reached",
      detail: "New agent work waits until the cap resets or you raise it.",
      where: "Usage",
      route,
    });
  }
  return items;
}

function cliItems(status: Awaited<ReturnType<typeof window.ade.adeCli.getStatus>> | null): AttentionItem[] {
  if (!status || !status.isPackaged) return [];
  if (status.agentPathReady) return [];
  return [{
    id: "ade-cli",
    severity: "warning",
    title: "Agents can't find the ade command",
    detail: status.nextAction ?? status.message,
    where: THIS_MACHINE_NAME,
    route: settingsRouteFor("general.ade-cli"),
    fix: status.installAvailable
      ? { label: "Install", run: async () => { await window.ade.adeCli.installForUser(); } }
      : undefined,
  }];
}

type ConnectionSnapshot = Awaited<ReturnType<typeof window.ade.remoteRuntime.getConnectionSnapshot>>;

const machineItemId = (targetId: string) => `machine-${targetId}`;

function unreachableConnections(snapshot: ConnectionSnapshot | null) {
  return snapshot?.connections.filter((connection) => connection.state === "error" || connection.state === "parked") ?? [];
}

/**
 * The "Can't reach" rows that are a cloud box resting
 * (`cloudMachineResting`): it can't answer by design, and wakes when it is
 * used. The
 * box list is a network read, so it runs after first paint and only when
 * something is unreachable; the rows show meanwhile and drop when it answers.
 */
async function restingCloudItemIds(snapshot: ConnectionSnapshot | null): Promise<Set<string>> {
  const unreachable = unreachableConnections(snapshot);
  const listMachines = window.ade?.cloud?.listMachines;
  if (unreachable.length === 0 || !adeCloudEnabled() || !isAdeAvailable(listMachines)) return new Set();
  const listed = await listMachines().catch((error: unknown) => {
    console.warn("[needs-attention] reading ADE Cloud boxes failed", error);
    return null;
  });
  const boxes = listed?.state === "ok" ? listed.machines : [];
  return new Set(unreachable
    .filter((connection) => {
      const box = cloudBoxForMachine(boxes, {
        machineKey: connection.target.pairedMachine?.machineKey,
        hostname: connection.target.hostname,
      });
      return box != null && cloudMachineResting(box.state);
    })
    .map((connection) => machineItemId(connection.target.id)));
}

/**
 * "N machines run an older ADE", on each machine's own track only (a Stable
 * machine is not "older" than this computer's Beta). A cloud computer that
 * updates itself (`selfUpdating`, its machine key) is never in it.
 */
function machinesBehindItem(snapshot: ConnectionSnapshot | null, update: AutoUpdateSnapshot | null, selfUpdating: ReadonlySet<string>): AttentionItem | null {
  if (!snapshot) return null;
  const behind = withoutSelfUpdatingCloud(machinesBehindOnTheirTrack(connectedMachinesFromSnapshot(snapshot), knownAdeVersions(update)), selfUpdating);
  if (behind.length === 0) return null;
  return {
    id: MACHINES_BEHIND_ITEM_ID,
    severity: "note",
    title: behind.length === 1 ? `${behind[0]!.name} runs an older ADE` : `${behind.length} machines run an older ADE`,
    detail: behind.map((machine) => `${machine.name}: ${machine.versionLabel ?? machine.version ?? "unknown"}`).join(", "),
    where: behind.length === 1 ? behind[0]!.name : "Your computers",
    route: settingsRouteFor("general.update-other-machines"),
  };
}

const MACHINES_BEHIND_ITEM_ID = "machines-behind";

/**
 * The behind item again once the account's cloud list says which computers
 * update themselves. Undefined when nothing changes (no item, or no cloud
 * computer among the behind ones). Never rejects.
 */
async function machinesBehindWithCloud(snapshot: ConnectionSnapshot | null, update: AutoUpdateSnapshot | null): Promise<AttentionItem | null | undefined> {
  if (!machinesBehindItem(snapshot, update, new Set())) return undefined;
  const keys = await readSelfUpdatingCloudKeys();
  return keys.size === 0 ? undefined : machinesBehindItem(snapshot, update, keys);
}

function machineItems(snapshot: ConnectionSnapshot | null, update: AutoUpdateSnapshot | null): AttentionItem[] {
  if (!snapshot) return [];
  const items: AttentionItem[] = [];
  for (const connection of unreachableConnections(snapshot)) {
    items.push({
      id: machineItemId(connection.target.id),
      severity: "warning",
      title: `Can't reach ${connection.target.name}`,
      detail: connection.lastError ?? undefined,
      where: connection.target.name,
      route: settingsRouteFor("account.computers"),
    });
  }
  // The cloud list already in memory, if a surface read it; the full read
  // after the list is on screen corrects it (`machinesBehindWithCloud`).
  const behind = machinesBehindItem(snapshot, update, selfUpdatingCloudMachineKeys(watchedCloudMachines()));
  if (behind) items.push(behind);
  return items;
}

function syncItems(status: Awaited<ReturnType<typeof window.ade.sync.getStatus>> | null): AttentionItem[] {
  const health = status?.routeHealth;
  if (!health) return [];
  const route = settingsRouteFor("account.computers");
  if (health.relay.relayControlSuppressed) {
    return [{
      id: "sync-relay",
      severity: "warning",
      title: RELAY_HELD_BY_OTHER_ADE_APP.title,
      detail: health.relay.relayControlSuppressedReason ?? "Phones and other machines may reach the other one instead.",
      where: "Sync",
      route,
    }];
  }
  if (health.tailscale.enabled && health.tailscale.tailscalePublished && !health.tailscale.tailscaleReachable) {
    return [{
      id: "sync-tailscale",
      severity: "note",
      title: "Other devices can't reach this computer over Tailscale",
      detail: health.tailscale.reason ?? undefined,
      where: "Sync",
      route,
    }];
  }
  return [];
}

function githubItems(status: Awaited<ReturnType<typeof window.ade.github.getStatus>> | null): AttentionItem[] {
  const failure = status?.authFailure;
  if (!failure || (failure.kind !== "invalid_token" && failure.kind !== "permission_denied")) return [];
  return [{
    id: "github-auth",
    severity: "problem",
    title: failure.kind === "invalid_token" ? "GitHub sign-in stopped working" : "GitHub refuses ADE's access",
    detail: failure.message,
    where: "Integrations",
    route: settingsRouteFor("integrations.github"),
  }];
}

function projectItems(report: ProjectHealthReport | null): AttentionItem[] {
  if (!report) return [];
  return report.issues.flatMap((issue): AttentionItem[] => {
    const lanes = issue.id === "stale-lanes" || issue.id === "stuck-sessions" || issue.id === "git-leftovers" || issue.id === "lane-folders";
    const route = lanes ? settingsRouteFor("lanes-git.lanes") : settingsRouteFor("storage.project-health");
    if (issue.id === "stale-lanes") {
      // A note, not a problem: done lanes take space. The Lanes page is the fix.
      // The service's sentence is long for a one-line row; the lane list it
      // describes says the same in a few words.
      const stale = report.lanes?.filter((lane) => lane.stale) ?? [];
      const safe = stale.filter((lane) => lane.safeToArchive).length;
      const detail = stale.length > 0
        ? `PR merged or closed, or idle. ${safe === stale.length ? "All" : safe} safe to archive.`
        : issue.detail;
      return [{ id: `project-${issue.id}`, severity: "note", title: issue.title, detail, where: "Project", route }];
    }
    if (issue.severity === "info") return [];
    return [{
      id: `project-${issue.id}`,
      severity: issue.severity === "problem" ? "problem" : "warning",
      title: issue.title,
      detail: issue.detail,
      where: "Project",
      route,
      projectIssue: issue,
    }];
  });
}

async function mcpItems(): Promise<AttentionItem[]> {
  const settings = window.ade?.accountSettings;
  const registry = window.ade?.mcpRegistry;
  if (!isAdeAvailable(settings) || !isAdeAvailable(registry)) return [];
  const stored = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: MCP_SERVERS_SETTING_KEY });
  if (!stored.ok) return [];
  const servers = normalizeMcpRegistry(stored.value);
  if (servers.length === 0) return [];
  const checked = await registry.check({ servers });
  if (!checked.ok) return [];
  const route = settingsRouteFor("mcp.servers");
  const held = new Set(checked.value.heldSecretKeys);
  const items: AttentionItem[] = [];
  for (const signIn of checked.value.signIns) {
    if (signIn.state === "valid") continue;
    items.push({
      id: `mcp-signin-${signIn.server}`,
      severity: "warning",
      title: signIn.state === "expired" ? `${signIn.server}: sign-in expired` : `${signIn.server} needs you to sign in`,
      where: "MCP",
      route,
    });
  }
  for (const name of checked.value.missingCommands) {
    items.push({ id: `mcp-command-${name}`, severity: "warning", title: `${name}: its command isn't installed here`, where: "MCP", route });
  }
  for (const server of servers) {
    const missing = missingMcpSecrets(server, held);
    if (missing.length === 0) continue;
    items.push({
      id: `mcp-secret-${server.name}`,
      severity: "warning",
      title: `${server.name} is missing ${missing.length === 1 ? "a secret" : `${missing.length} secrets`} on this computer`,
      detail: missing.map((entry) => entry.name).join(", "),
      where: "MCP",
      route,
    });
  }
  return items;
}

/** `pin`: the copy Settings › Integrations shows, so a row agrees with the page it opens. */
async function integrationItems(pin: OpenProjectBinding | null, failed?: string[]): Promise<AttentionItem[]> {
  if (!pin) return [];
  const [linear, jira] = await Promise.all([
    quiet(window.ade.cto?.getLinearConnectionStatus ? () => window.ade.cto!.getLinearConnectionStatus(pin) : null, failed, "Linear"),
    quiet(() => window.ade.jira.getConnectionStatus(pin), failed, "Jira"),
  ]);
  const items: AttentionItem[] = [];
  if (linear && linear.tokenStored && !linear.connected) {
    items.push({
      id: "linear-auth",
      severity: "warning",
      title: "Linear isn't connected",
      detail: "ADE has a Linear sign-in for this project, but Linear refused it.",
      where: "Integrations",
      route: settingsRouteFor("integrations.linear"),
    });
  }
  if (jira?.error) {
    items.push({
      id: "jira-auth",
      severity: "warning",
      title: "Jira sign-in stopped working",
      detail: jira.error.message,
      where: "Integrations",
      route: settingsRouteFor("integrations.jira"),
    });
  }
  return items;
}

function connectedProviders(status: Awaited<ReturnType<typeof window.ade.ai.getStatus>> | null): AiProviderConnectionStatus[] {
  const connections = status?.providerConnections;
  if (!connections) return [];
  return Object.values(connections).filter((entry): entry is AiProviderConnectionStatus => entry != null);
}

export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => SEVERITY_ORDER[left.item.severity] - SEVERITY_ORDER[right.item.severity] || left.index - right.index)
    .map((entry) => entry.item);
}

/** The lines a row lists under its detail: its own, else its project check's. */
export function attentionLines(item: AttentionItem): readonly string[] {
  return item.items?.length ? item.items : item.projectIssue?.items ?? [];
}

/** The prompt "Ask an agent" starts from: every row, where it lives, and the ask-first rule. */
export function attentionAgentPrompt(items: readonly AttentionItem[], projectRoot: string | null): string {
  const lines = items.map((item, index) => {
    const head = `${index + 1}. [${item.where}] ${item.title}`;
    const detail = item.detail ? `\n   ${item.detail}` : "";
    const entries = attentionLines(item);
    const list = entries.length ? `\n${entries.slice(0, 15).map((entry) => `   - ${entry}`).join("\n")}` : "";
    const fix = item.fix ? `\n   ADE's own fix: "${item.fix.label}" in Settings.` : item.projectIssue?.fix ? `\n   ADE's own fix: "${item.projectIssue.fix.label}": ${item.projectIssue.fix.description}` : "";
    return `${head}${detail}${list}${fix}`;
  });
  return [
    `ADE's Settings lists ${items.length === 1 ? "one thing" : `${items.length} things`} that need attention${projectRoot ? ` (project at \`${projectRoot}\`)` : ""}. Go through ${items.length === 1 ? "it" : "them"} with me: explain what each means and what happens if it is left, check it yourself, and offer a fix. Ask me before you change anything.`,
    "",
    ...lines,
    "",
    "Rules:",
    "- Where ADE has its own fix, say so; I can press it in Settings. Do it by hand only if I ask.",
    "- Don't delete files, branches or lanes, sign anything out, or run installs without my OK.",
    "- Keep the report short: what you checked, what you fixed (only with my OK), what I need to do.",
  ].join("\n");
}

/**
 * What Settings › General lists. Project rows read the copy each project page
 * shows (Location for the checks and provider settings, Integrations for the
 * connections), so a row and the page it opens agree. Provider rows read this
 * computer's copy when it has one, the machine General is about.
 */
export function useNeedsAttention({ hasProject }: { hasProject: boolean }) {
  // Only a copy whose computer is online: an offline one is not called.
  const locationPin = onlineCopyPin(useProjectCopyPage(settingsCopyScope("location"), hasProject));
  const integrationsPin = onlineCopyPin(useProjectCopyPage(settingsCopyScope("integrations"), hasProject));
  const thisComputerPin = useThisComputerCopyPin(hasProject);
  const projectPin = hasProject ? locationPin : null;
  const connectionsPin = hasProject ? integrationsPin : null;
  // Null (no copy here) keeps the machine-global route for this computer.
  const providersPin = hasProject ? thisComputerPin : null;
  const projectKey = projectPin?.key ?? null;
  const connectionsKey = connectionsPin?.key ?? null;
  const providersKey = providersPin?.key ?? null;
  const pinsRef = React.useRef({ projectPin, connectionsPin, providersPin });
  pinsRef.current = { projectPin, connectionsPin, providersPin };
  const [sources, setSources] = React.useState<OverviewSources>(EMPTY_SOURCES);
  const [items, setItems] = React.useState<AttentionItem[]>([]);
  const [lateItems, setLateItems] = React.useState<AttentionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [checking, setChecking] = React.useState(false);
  const request = React.useRef(0);

  const load = React.useCallback(async (opts: { force?: boolean } = {}) => {
    const current = ++request.current;
    if (opts.force) setChecking(true);
    const ade = window.ade;
    const failed: string[] = [];
    const { projectPin: reportPin, connectionsPin: githubPin, providersPin: aiPin } = pinsRef.current;
    const [info, update, pressure, runtimeHealth, report, usage, ai, cli, machines, sync, github, projectConfig, providerAccounts] = await Promise.all([
      quiet(() => ade.app.getInfo(), failed, "ADE's service"),
      quiet(ade.updateGetState ? () => ade.updateGetState() : null, failed, "updates"),
      quiet(isAdeAvailable(ade.storage?.getPressure) ? () => ade.storage.getPressure() : null, failed, "disk space"),
      quiet(isAdeAvailable(ade.app?.getRuntimeHealth) ? () => ade.app.getRuntimeHealth() : null, failed, "ADE's service health"),
      reportPin ? quiet(isAdeAvailable(ade.projectHealth?.getReport) ? () => ade.projectHealth.getReport({ forceRefresh: opts.force }, reportPin) : null, failed, "this project") : Promise.resolve(null),
      quiet(ade.usage?.getSnapshot ? () => ade.usage.getSnapshot() : null, failed, "usage"),
      quiet(ade.ai?.getStatus ? () => ade.ai.getStatus(undefined, aiPin) : null, failed, "providers"),
      quiet(ade.adeCli?.getStatus ? () => ade.adeCli.getStatus() : null, failed, "the ade command"),
      quiet(ade.remoteRuntime?.getConnectionSnapshot ? () => ade.remoteRuntime.getConnectionSnapshot() : null, failed, "other machines"),
      quiet(ade.sync?.getStatus ? async () => {
        const snapshot = await ade.sync.getStatus({ includeTransferReadiness: false });
        // A synthesized snapshot is a read that did not finish, not a healthy one.
        if (isDegradedSyncSnapshot(snapshot)) throw new Error(snapshot.degradedReason);
        return snapshot;
      } : null, failed, "sync"),
      githubPin ? quiet(ade.github?.getStatus ? () => ade.github.getStatus({}, githubPin) : null, failed, "GitHub") : Promise.resolve(null),
      // Only for the providers you switched off; without it they show, and the list says it couldn't check.
      reportPin ? quiet(ade.projectConfig?.get ? () => ade.projectConfig.get(reportPin) : null, failed, "provider settings") : Promise.resolve(null),
      // Same machine as `ai.getStatus`, so the two describe one provider set.
      // With a project open but no copy on this computer, a call with no pin
      // would go to the tab's computer, so the accounts are not read.
      hasProject && !aiPin
        ? Promise.resolve(null)
        : quiet(ade.providerInstances?.list ? () => ade.providerInstances.list(undefined, aiPin) : null, failed, "provider accounts"),
    ]);
    if (current !== request.current) return;
    const providers = connectedProviders(ai);
    setSources({ info, update, pressure, runtimeHealth, report, usage, providers });
    setItems([
      ...projectItems(report),
      ...serviceItems(info, runtimeHealth),
      ...updateItems(update),
      ...pressureItems(pressure),
      ...cliItems(cli),
      ...providerItems(providers, projectConfig?.effective.ai, usage, providerAccounts ?? []),
      ...usageItems(usage),
      ...githubItems(github),
      ...machineItems(machines, update),
      ...syncItems(sync),
      ...readFailureItem(failed, () => load({ force: true })),
    ]);
    setLoading(false);
    setChecking(false);
    // The slow ones, after the list is on screen.
    // The provider read can take long; it never holds back the other rows.
    void restingCloudItemIds(machines).then((resting) => {
      if (current !== request.current || resting.size === 0) return;
      setItems((currentItems) => currentItems.filter((item) => !resting.has(item.id)));
    });
    // A cloud computer that updates itself never counts as behind.
    void machinesBehindWithCloud(machines, update).then((behind) => {
      if (current !== request.current || behind === undefined) return;
      setItems((currentItems) => [
        ...currentItems.filter((item) => item.id !== MACHINES_BEHIND_ITEM_ID),
        ...(behind ? [behind] : []),
      ]);
    });
    const late = await Promise.all([
      quiet(mcpItems, failed, "MCP servers"),
      quiet(() => integrationItems(githubPin, failed), failed, "integrations"),
    ]);
    if (current !== request.current) return;
    setLateItems(late.flatMap((entry) => entry ?? []));
    setItems((currentItems) => [
      ...currentItems.filter((item) => item.id !== "overview-read-failed"),
      ...readFailureItem(failed, () => load({ force: true })),
    ]);
    // The pins are read from the ref; the keys restart the read when a copy changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasProject, projectKey, connectionsKey, providersKey]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const setReport = React.useCallback((report: ProjectHealthReport) => {
    setSources((current) => ({ ...current, report }));
    setItems((current) => [...projectItems(report), ...current.filter((item) => !item.id.startsWith("project-"))]);
  }, []);

  const all = React.useMemo(() => sortAttention([...items, ...lateItems]), [items, lateItems]);
  return { items: all, sources, loading, checking, reload: load, setReport, projectPin };
}
