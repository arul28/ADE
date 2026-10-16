// A read-only snapshot of one ADE account machine: who it is, whether it is
// up, and what it has been working on.
//
// Two sources, both already on the brain and both token-free:
//   - the account machine directory row (`AdeAccountMachine`): name, platform,
//     presence, sleep state;
//   - the account-wide Activity snapshot (`AttentionSnapshot`): the chats each
//     machine published, with their project and lane.
//
// The directory row carries no project, lane, or chat roster at all (its
// `inventory` is provider and preset counts), so everything below the presence
// line comes from Activity. That makes it "what this machine has been doing
// lately", never a full listing, and the text says so. Nothing is guessed: a
// field neither source has is left out.
//
// Used by the `@mac:` mention expansion (chatMentionService) and by
// `ade machines show` (the brain's `account.showMachine`), so the agent sees
// the same facts whichever way it asked.

import { accountMachineDisplayName, accountMachineInstallLabel } from "./accountDirectory";
import { isChatMentionId } from "./chatMentions";
import type { AdeAccountMachine } from "./types/account";
import type { AttentionItem, AttentionMachineRef } from "./types/attention";

/** Chats listed per machine. The locked design caps a mention at five. */
export const ACCOUNT_MACHINE_SNAPSHOT_RECENT_CHATS = 5;
const MAX_PROJECTS = 12;
const MAX_LANES = 12;
const MAX_ACTIVITY_LINES = 3;
const MAX_LINE_CHARS = 200;

export type AccountMachineSnapshotChat = {
  sessionId: string | null;
  title: string;
  projectName: string | null;
  laneName: string | null;
  provider: string | null;
  model: string | null;
  /** Activity phase, e.g. `working`, `needs_input`, `done`. */
  phase: string;
  updatedAt: string;
  /** The publisher's short latest-output excerpt. Not a transcript. */
  preview: string | null;
  /** The publisher's last few activity lines, newest last. */
  recentActivity: string[];
};

export type AccountMachineSnapshot = {
  machineKey: string;
  deviceId: string | null;
  /** Token-safe id used in `@mac:<id>`. See `machineMentionId`. */
  mentionId: string;
  name: string;
  install: string | null;
  platform: string | null;
  deviceType: string | null;
  online: boolean;
  /** ISO time of the last directory heartbeat, when known. */
  lastSeenAt: string | null;
  sleepState: string | null;
  isThisMachine: boolean;
  /**
   * Whether the Activity feed could be read. When false, `projects`, `lanes`
   * and `recentChats` are empty because they are unknown, not because the
   * machine is idle.
   */
  activityAvailable: boolean;
  projects: Array<{ name: string; rootPath: string | null; chats: number }>;
  lanes: Array<{ name: string; projectName: string | null }>;
  recentChats: AccountMachineSnapshotChat[];
};

/**
 * The id a machine mention serializes. Mention ids must fit
 * `[A-Za-z0-9._-]+`; directory machine keys are 32 hex chars and always fit,
 * so this is the machine key in practice. A key that does not fit falls back
 * to the device id, and only then to a deterministic `x.` + UTF-16 hex
 * encoding of the key, so every machine is mentionable and the id never
 * changes between the menu and send time.
 */
export function machineMentionId(machine: Pick<AdeAccountMachine, "machineKey" | "deviceId">): string {
  const key = machine.machineKey.trim();
  if (key && isChatMentionId(key)) return key;
  const deviceId = machine.deviceId?.trim() ?? "";
  if (deviceId && isChatMentionId(deviceId)) return deviceId;
  return `x.${Array.from(key, (char) => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
}

/** Find the directory row a mention id (or machine key / device id) names. */
export function findMachineByMentionId(
  machines: readonly AdeAccountMachine[],
  id: string,
): AdeAccountMachine | null {
  const needle = id.trim();
  if (!needle) return null;
  return machines.find((machine) => machineMentionId(machine) === needle)
    ?? machines.find((machine) => machine.machineKey === needle)
    ?? machines.find((machine) => machine.deviceId != null && machine.deviceId === needle)
    ?? null;
}

function sameMachine(ref: AttentionMachineRef, machine: AdeAccountMachine): boolean {
  if (ref.accountMachineKey && ref.accountMachineKey === machine.machineKey) return true;
  if (ref.machineKey === machine.machineKey) return true;
  return Boolean(machine.deviceId && ref.deviceId && ref.deviceId === machine.deviceId);
}

function clip(value: string | null | undefined, max = MAX_LINE_CHARS): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function toIso(epochMs: number | null | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  return new Date(epochMs).toISOString();
}

/** The project label Activity uses, preferring its display name. */
function projectLabel(item: AttentionItem): string | null {
  return clip(item.project?.name, 120) ?? clip(item.project?.rootPath, 160);
}

export function buildAccountMachineSnapshot(args: {
  machine: AdeAccountMachine;
  /** Account Activity items, or null when the feed could not be read. */
  activityItems: readonly AttentionItem[] | null;
  /** This brain's own directory key, to label "this machine". */
  localMachineKey?: string | null;
  recentChatLimit?: number;
}): AccountMachineSnapshot {
  const { machine } = args;
  const items = (args.activityItems ?? []).filter((item) => item.machine && sameMachine(item.machine, machine));
  const newestFirst = [...items].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));

  const projects = new Map<string, { name: string; rootPath: string | null; chats: number }>();
  const lanes = new Map<string, { name: string; projectName: string | null }>();
  for (const item of newestFirst) {
    const name = projectLabel(item);
    if (name) {
      const key = item.project.canonicalId ?? item.project.rootPath ?? name;
      const entry = projects.get(key) ?? { name, rootPath: clip(item.project.rootPath, 240), chats: 0 };
      if (item.kind === "agent") entry.chats += 1;
      projects.set(key, entry);
    }
    const laneName = clip(item.laneName, 120);
    if (laneName) {
      const key = `${name ?? ""}\u0000${laneName}`;
      if (!lanes.has(key)) lanes.set(key, { name: laneName, projectName: name });
    }
  }

  const limit = Math.max(0, args.recentChatLimit ?? ACCOUNT_MACHINE_SNAPSHOT_RECENT_CHATS);
  const recentChats = newestFirst
    .filter((item) => item.kind === "agent")
    .slice(0, limit)
    .map((item): AccountMachineSnapshotChat => ({
      sessionId: item.destination?.kind === "session" ? item.destination.sessionId : null,
      title: clip(item.title, 160) ?? "Untitled chat",
      projectName: projectLabel(item),
      laneName: clip(item.laneName, 120),
      provider: clip(item.provider, 40),
      model: clip(item.model, 80),
      phase: item.phase,
      updatedAt: item.updatedAt,
      preview: clip(item.preview),
      recentActivity: (item.recentActivity ?? [])
        .map((line) => clip(line))
        .filter((line): line is string => Boolean(line))
        .slice(-MAX_ACTIVITY_LINES),
    }));

  const localKey = args.localMachineKey?.trim() || null;
  return {
    machineKey: machine.machineKey,
    deviceId: machine.deviceId,
    mentionId: machineMentionId(machine),
    name: accountMachineDisplayName(machine) ?? "Unnamed machine",
    install: accountMachineInstallLabel(machine),
    platform: machine.platform,
    deviceType: machine.deviceType,
    online: machine.online,
    lastSeenAt: toIso(machine.lastSeenAt),
    sleepState: machine.sleepState ?? null,
    isThisMachine: Boolean(localKey && localKey === machine.machineKey),
    activityAvailable: args.activityItems != null,
    projects: [...projects.values()].slice(0, MAX_PROJECTS),
    lanes: [...lanes.values()].slice(0, MAX_LANES),
    recentChats,
  };
}

/** "online", "asleep · last seen 3h ago", "offline · last seen 2d ago". */
export function describeAccountMachinePresence(
  snapshot: Pick<AccountMachineSnapshot, "online" | "lastSeenAt" | "sleepState">,
  nowMs: number = Date.now(),
): string {
  if (snapshot.online && snapshot.sleepState !== "asleep") return "online";
  const state = snapshot.sleepState === "asleep" ? "asleep" : "offline";
  const seen = snapshot.lastSeenAt ? Date.parse(snapshot.lastSeenAt) : NaN;
  if (!Number.isFinite(seen)) return state;
  return `${state} · last seen ${formatAgo(nowMs - seen)}`;
}

function formatAgo(deltaMs: number): string {
  const minutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Plain-text rendering shared by `ade machines show --text` and the `@mac:`
 * mention preview. Deterministic for a given snapshot and `nowMs`.
 */
export function formatAccountMachineSnapshotText(
  snapshot: AccountMachineSnapshot,
  nowMs: number = Date.now(),
  options: {
    /**
     * Mention-preview form: fits the 1 KB `<ade-mention>` preview cap by
     * dropping the ids (the block attributes carry the key), capping lanes,
     * and keeping one short latest-output line per chat.
     */
    compact?: boolean;
  } = {},
): string {
  const compact = options.compact === true;
  const lines: string[] = [];
  const header = [snapshot.name, snapshot.install, snapshot.isThisMachine ? "this machine" : null]
    .filter(Boolean)
    .join(" · ");
  lines.push(header);
  lines.push(`Status: ${describeAccountMachinePresence(snapshot, nowMs)}`);
  const platform = [snapshot.platform, snapshot.deviceType].filter(Boolean).join(" · ");
  if (platform) lines.push(`Platform: ${platform}`);
  if (!compact) {
    lines.push(`Machine key: ${snapshot.machineKey}`);
    if (snapshot.deviceId) lines.push(`Device id: ${snapshot.deviceId}`);
  }

  if (!snapshot.activityAvailable) {
    lines.push("Recent work: unavailable (ADE Activity could not be read).");
    return lines.join("\n");
  }
  if (!snapshot.projects.length && !snapshot.recentChats.length) {
    lines.push("Recent work: none published to ADE Activity.");
    return lines.join("\n");
  }
  if (snapshot.projects.length) {
    lines.push("Projects with recent activity:");
    for (const project of snapshot.projects) {
      const chats = project.chats ? ` (${project.chats} chat${project.chats === 1 ? "" : "s"})` : "";
      const root = !compact && project.rootPath ? ` — ${project.rootPath}` : "";
      lines.push(`  - ${project.name}${chats}${root}`);
    }
  }
  if (snapshot.lanes.length) {
    lines.push("Lanes with recent activity:");
    for (const lane of compact ? snapshot.lanes.slice(0, 6) : snapshot.lanes) {
      lines.push(`  - ${lane.name}${lane.projectName ? ` (${lane.projectName})` : ""}`);
    }
  }
  if (snapshot.recentChats.length) {
    lines.push("Recent chats:");
    for (const chat of snapshot.recentChats) {
      const where = [chat.projectName, chat.laneName].filter(Boolean).join(" / ");
      if (compact) {
        const updated = Date.parse(chat.updatedAt);
        const when = Number.isFinite(updated) ? ` · ${formatAgo(nowMs - updated)}` : "";
        lines.push(`  - ${chat.title} [${chat.phase}]${where ? ` · ${where}` : ""}${when}`);
        const latest = chat.preview ?? chat.recentActivity[chat.recentActivity.length - 1] ?? null;
        if (latest) lines.push(`      latest: ${clip(latest, 100)}`);
        continue;
      }
      const who = [chat.provider, chat.model].filter(Boolean).join(" ");
      lines.push(
        `  - ${chat.title} [${chat.phase}]${where ? ` · ${where}` : ""}${who ? ` · ${who}` : ""}`
          + ` · updated ${chat.updatedAt}${chat.sessionId ? ` · session ${chat.sessionId}` : ""}`,
      );
      if (chat.preview) lines.push(`      latest: ${chat.preview}`);
      for (const activity of chat.recentActivity) lines.push(`      · ${activity}`);
    }
  }
  return lines.join("\n");
}
