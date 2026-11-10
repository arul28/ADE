import type { LaneSharePreset, LaneShareRisk } from "../../../account-directory/src/laneShares/contract";
import type { LaneShareMoveView } from "./laneShareMove";
import { AGENT_CHAT_PERMISSION_MODE_VALUES, type AgentChatPermissionMode } from "./types/chat";

/**
 * The rights one lane share gives its guest (lane sharing, package 5).
 *
 * Pure and shared: the host enforces these, the desktop and the web client
 * show and edit them. The host is the only authority. It keeps the rights of
 * each grant in its own local table and checks every guest action against
 * them, default refuse. The account directory only keeps a display preset and
 * a risk label (`laneSharePresetLabel`, `laneShareRiskLevel`).
 *
 * A rights object that comes from anywhere but this file's own builders is
 * untrusted: read it with `parseLaneShareRights`, which keeps only the keys
 * this version knows and treats every other value as off.
 */

const LANE_SHARE_RIGHTS_VERSION = 1;

/**
 * One switch per ADE action domain (`actionPolicy.ts`). "On" means READ
 * actions only, in the shared lane's own worktree, and only where
 * `LANE_SHARE_TOOL_READS` lists them. A domain with no list grants nothing
 * yet: its switch is kept so the owner's choice survives an upgrade, and the
 * host refuses every action of it.
 */
export const LANE_SHARE_TOOL_DOMAINS = [
  "file",
  "git",
  "diff",
  "pr",
  "terminal",
  "built_in_browser",
  "ios_simulator",
  "mac_desktop",
  "android_emulator",
  "app_control",
] as const;
export type LaneShareToolDomain = (typeof LANE_SHARE_TOOL_DOMAINS)[number];

/** What each tool switch lets a guest read, in words the share sheet can show. Empty: nothing yet. */
export const LANE_SHARE_TOOL_READS: Readonly<Record<LaneShareToolDomain, readonly string[]>> = Object.freeze({
  file: ["List and read the lane's files (ignored files stay hidden)", "Search the lane's files"],
  git: ["Read the lane's commits and file history"],
  diff: ["Read the lane's uncommitted and branch changes"],
  pr: ["Read the lane's pull request"],
  terminal: [],
  built_in_browser: [],
  ios_simulator: [],
  mac_desktop: [],
  android_emulator: [],
  app_control: [],
});

export type LaneShareRights = {
  /** The rights version that wrote this object. */
  version: number;
  see: {
    chats: boolean;
    subagentChats: boolean;
    cliSessions: boolean;
    /** Shells are always read only for a guest. */
    shells: boolean;
    /** Off: the guest sees only what happened from the share's start on. */
    historyBeforeShare: boolean;
  };
  speak: {
    /**
     * Comment on parts of an agent reply. A guest's comment never goes with
     * the owner's next send on its own: the owner includes it by name.
     */
    comment: boolean;
    /**
     * Write drafts. Only the owner sends one, and it then counts for the
     * owner. It goes as a plain prompt with the guest as its author, and only
     * to an existing chat.
     */
    drafts: boolean;
    /** Send messages that start or queue a turn. */
    send: boolean;
    /** Steer or interrupt a running turn that this guest started. */
    steer: boolean;
    /**
     * Interrupt or steer a running turn that someone else started (the owner
     * or another guest). Off in every preset. Medium risk.
     */
    interruptAnyTurn: boolean;
  };
  run: {
    startChats: boolean;
    startCliSessions: boolean;
    /**
     * Typing into a CLI session (never a shell). High risk: it gives the same
     * reach as a shell on this computer. Each submitted line counts as a
     * message. Refused when the host runs Windows.
     */
    typeInCliSessions: boolean;
    /**
     * The model ids a guest may use, which also name the provider of a new
     * chat. Empty: only the session's current model, with no change; a new
     * chat or CLI session then cannot be started (no provider default).
     */
    models: string[];
    /** Reasoning levels a guest may pick. Empty: the session's current level, no change. */
    reasoningLevels: string[];
    /** Permission modes a guest turn may run in. Empty: the session's current mode, no change. */
    permissionModes: AgentChatPermissionMode[];
  };
  decide: {
    /** Approve or deny the agent's actions (commands, edits, permissions, plans). */
    approvals: boolean;
    /** Answer the agent's questions. */
    questions: boolean;
  };
  tools: Record<LaneShareToolDomain, boolean>;
  limits: {
    /** Guest messages per local day of the host. Null: no daily limit. */
    messagesPerDay: number | null;
    /** Guest messages over the life of the share. Null: no total limit. */
    messagesTotal: number | null;
    /** Epoch ms when the share ends (also kept by the directory). Null: no end. */
    endsAt: number | null;
  };
  privacy: {
    /** The guest does not learn this machine's name or kind. */
    hideMachines: boolean;
    /** The guest sees only the models it may use. */
    hideModels: boolean;
  };
};

/** The directory's presets (`LaneSharePreset` in the contract), in the same order. */
export const LANE_SHARE_PRESET_NAMES = ["watch", "comment", "suggest", "collaborate"] as const satisfies readonly LaneSharePreset[];
export type LaneSharePresetName = LaneSharePreset;

export type LaneShareRiskLevel = LaneShareRisk;

const MAX_LIST_ENTRIES = 32;
const MAX_LIST_ENTRY_CHARS = 200;
const MAX_LIMIT = 1_000_000;

function noTools(): Record<LaneShareToolDomain, boolean> {
  return Object.fromEntries(LANE_SHARE_TOOL_DOMAINS.map((domain) => [domain, false])) as Record<LaneShareToolDomain, boolean>;
}

/** Every right off. What an unreadable rights object becomes. */
function laneShareRightsNone(): LaneShareRights {
  return {
    version: LANE_SHARE_RIGHTS_VERSION,
    see: { chats: false, subagentChats: false, cliSessions: false, shells: false, historyBeforeShare: false },
    speak: { comment: false, drafts: false, send: false, steer: false, interruptAnyTurn: false },
    run: {
      startChats: false,
      startCliSessions: false,
      typeInCliSessions: false,
      models: [],
      reasoningLevels: [],
      permissionModes: [],
    },
    decide: { approvals: false, questions: false },
    tools: noTools(),
    limits: { messagesPerDay: null, messagesTotal: null, endsAt: null },
    privacy: { hideMachines: false, hideModels: false },
  };
}

/**
 * The rights of a preset. Every preset sees the lane's chats, subagent chats,
 * CLI sessions and shells from the share's start on.
 *
 * - Watch: read only.
 * - Comment: Watch, plus comments on agent replies.
 * - Suggest: Comment, plus drafts the owner may send.
 * - Collaborate: Suggest, plus sending, steering and new chats, in turns that
 *   run only in the "default" (ask first) or "plan" permission mode. The owner
 *   still answers every approval and question; CLI sessions stay off. A
 *   guest turn spends the host's provider sign-ins, so Collaborate comes with
 *   a limit of `LANE_SHARE_DEFAULT_MESSAGES_PER_DAY` messages a day. The
 *   share sheet can change or remove it.
 */
const LANE_SHARE_DEFAULT_MESSAGES_PER_DAY = 50;
/** The longest line a guest may type into a CLI session, line end not counted. The host refuses a longer one. */
export const LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS = 4_000;

export function laneSharePresetRights(preset: LaneSharePresetName): LaneShareRights {
  const rights = laneShareRightsNone();
  rights.see = { chats: true, subagentChats: true, cliSessions: true, shells: true, historyBeforeShare: false };
  if (preset === "watch") return rights;
  rights.speak.comment = true;
  if (preset === "comment") return rights;
  rights.speak.drafts = true;
  if (preset === "suggest") return rights;
  rights.speak.send = true;
  rights.speak.steer = true;
  rights.run.startChats = true;
  rights.run.permissionModes = ["default", "plan"];
  rights.limits.messagesPerDay = LANE_SHARE_DEFAULT_MESSAGES_PER_DAY;
  return rights;
}

const flag = (value: unknown): boolean => value === true;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown, allowed?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_LIST_ENTRY_CHARS) continue;
    if (allowed && !allowed.has(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

function positiveLimit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, MAX_LIMIT);
}

const PERMISSION_MODES = new Set<string>(AGENT_CHAT_PERMISSION_MODE_VALUES);

/**
 * Reads an untrusted rights object. Never throws. Only the keys this version
 * knows are read, and only an exact `true` turns a switch on, so a key from a
 * newer version, a misspelled key or a value of the wrong type is off. A
 * value that is not an object is every right off.
 */
export function parseLaneShareRights(value: unknown): LaneShareRights {
  const rights = laneShareRightsNone();
  const input = record(value);
  const see = record(input.see);
  const speak = record(input.speak);
  const run = record(input.run);
  const decide = record(input.decide);
  const tools = record(input.tools);
  const limits = record(input.limits);
  const privacy = record(input.privacy);
  rights.see = {
    chats: flag(see.chats),
    subagentChats: flag(see.subagentChats),
    cliSessions: flag(see.cliSessions),
    shells: flag(see.shells),
    historyBeforeShare: flag(see.historyBeforeShare),
  };
  rights.speak = {
    comment: flag(speak.comment),
    drafts: flag(speak.drafts),
    send: flag(speak.send),
    steer: flag(speak.steer),
    interruptAnyTurn: flag(speak.interruptAnyTurn),
  };
  rights.run = {
    startChats: flag(run.startChats),
    startCliSessions: flag(run.startCliSessions),
    typeInCliSessions: flag(run.typeInCliSessions),
    models: stringList(run.models),
    reasoningLevels: stringList(run.reasoningLevels),
    permissionModes: stringList(run.permissionModes, PERMISSION_MODES) as AgentChatPermissionMode[],
  };
  rights.decide = { approvals: flag(decide.approvals), questions: flag(decide.questions) };
  for (const domain of LANE_SHARE_TOOL_DOMAINS) {
    if (Object.prototype.hasOwnProperty.call(tools, domain)) rights.tools[domain] = flag(tools[domain]);
  }
  const endsAt = typeof limits.endsAt === "number" && Number.isFinite(limits.endsAt) && limits.endsAt > 0 ? limits.endsAt : null;
  rights.limits = {
    messagesPerDay: positiveLimit(limits.messagesPerDay),
    messagesTotal: positiveLimit(limits.messagesTotal),
    endsAt,
  };
  rights.privacy = { hideMachines: flag(privacy.hideMachines), hideModels: flag(privacy.hideModels) };
  return rights;
}

/** Permission modes in which an agent asks before it runs a tool that changes something. */
const ASK_FIRST_PERMISSION_MODES = new Set<AgentChatPermissionMode>(["default", "plan"]);

/** Whether a guest can make the agent act on this computer: a turn, a new chat, a new CLI session. */
function laneShareGuestCanRunTurns(rights: LaneShareRights): boolean {
  return rights.speak.send || rights.speak.steer || rights.run.startChats || rights.run.startCliSessions || rights.run.typeInCliSessions;
}

const TOOL_LABELS: Record<LaneShareToolDomain, string> = {
  file: "files",
  git: "git history",
  diff: "changes",
  pr: "pull request",
  terminal: "terminals",
  built_in_browser: "built-in browser",
  ios_simulator: "iOS simulator",
  mac_desktop: "Mac desktop",
  android_emulator: "Android emulator",
  app_control: "app control",
};

/**
 * The risk of a rights object and why, in plain sentences for the share sheet
 * and the "Confirm high risk share" dialog. High-risk reasons come first.
 *
 * High: typing into or starting CLI sessions, answering approvals, the
 * terminal switch, and turns that can run tools without the owner's approval
 * (any guest turn whose permission mode is not locked to ask-first modes).
 * Medium: any other way to start a turn, stopping or steering turns that
 * others started, answering questions, history from before the share, and
 * tool reads. Low: everything else.
 *
 * Some reasons only inform and do not change the level: a rights object that
 * allows turns and has no message limit, and the agent's reach outside the
 * lane (the agent's own tools are not limited to the lane's worktree).
 */
/**
 * One sentence on what a low-risk share lets the person do, read from the
 * rights (what they see, and whether they comment or write drafts). Shown when
 * `laneShareRiskLevel` gives no reasons.
 */
export function laneShareLowRiskSummary(rights: LaneShareRights): string {
  const seen: string[] = [];
  if (rights.see.chats) seen.push(rights.see.subagentChats ? "chats and subagent chats" : "chats");
  if (rights.see.cliSessions) seen.push("CLI sessions");
  if (rights.see.shells) seen.push("shells (read only)");
  const see = seen.length === 0
    ? "This person sees nothing in the lane yet."
    : `This person can see the lane's ${seen.length === 1 ? seen[0] : `${seen.slice(0, -1).join(", ")} and ${seen[seen.length - 1]}`}.`;
  const comment = rights.speak.comment;
  const drafts = rights.speak.drafts;
  if (!comment && !drafts) return `Watch only. ${see}`;
  const act = comment && drafts
    ? "They can comment on replies and write drafts. Only you send a draft."
    : comment
      ? "They can comment on replies."
      : "They can write drafts. Only you send a draft.";
  return `${see} ${act} Nothing they do starts a turn.`;
}

export function laneShareRiskLevel(rights: LaneShareRights): { level: LaneShareRiskLevel; reasons: string[] } {
  const high: string[] = [];
  const medium: string[] = [];
  if (rights.run.typeInCliSessions) {
    high.push("Typing into a CLI session gives the same reach as a shell on this computer.");
  }
  if (rights.run.startCliSessions) high.push("Can start CLI sessions on this computer.");
  if (rights.decide.approvals) high.push("Can approve the agent's actions, such as commands and file edits.");
  if (rights.tools.terminal) high.push("The terminal tools switch is on.");
  const turns = rights.speak.send || rights.speak.steer || rights.run.startChats;
  if (turns) {
    const modes = rights.run.permissionModes;
    const askFirstOnly = modes.length > 0 && modes.every((mode) => ASK_FIRST_PERMISSION_MODES.has(mode));
    if (!askFirstOnly) {
      high.push("Can start agent turns that run tools without your approval. Lock the permission mode to ask first to lower this.");
    }
    medium.push("Can start agent turns on this computer, with your provider sign-ins.");
  }
  if (rights.speak.interruptAnyTurn) medium.push("Can stop or steer turns that you or other guests started.");
  if (rights.run.startChats) medium.push("Can start new chats in this lane.");
  if (rights.decide.questions) medium.push("Can answer the agent's questions.");
  if (rights.see.historyBeforeShare) medium.push("Can read the lane's history from before the share.");
  for (const domain of LANE_SHARE_TOOL_DOMAINS) {
    if (domain === "terminal" || !rights.tools[domain]) continue;
    medium.push(LANE_SHARE_TOOL_READS[domain].length > 0
      ? `Can read the lane's ${TOOL_LABELS[domain]}.`
      : `The ${TOOL_LABELS[domain]} switch is on. It gives no access yet.`);
  }
  const level: LaneShareRiskLevel = high.length > 0 ? "high" : medium.length > 0 ? "medium" : "low";
  // Information only: these do not move the level.
  const notes: string[] = [];
  if (laneShareGuestCanRunTurns(rights)) {
    notes.push("The agent can read files on this computer that the guest cannot open directly.");
    if (rights.limits.messagesPerDay === null && rights.limits.messagesTotal === null) {
      notes.push("No message limit. Each guest turn uses your provider sign-ins.");
    }
  }
  return { level, reasons: [...high, ...medium, ...notes] };
}

/** Every switch of `preset` that is on is also on in `rights`. */
function covers(rights: LaneShareRights, preset: LaneShareRights): boolean {
  const groups = ["see", "speak", "decide"] as const;
  for (const group of groups) {
    const want = preset[group] as Record<string, boolean>;
    const have = rights[group] as Record<string, boolean>;
    for (const key of Object.keys(want)) if (want[key] && !have[key]) return false;
  }
  return !(preset.run.startChats && !rights.run.startChats);
}

/**
 * The preset name the directory shows for `rights`: the largest preset whose
 * switches are all on in `rights`. A label only; the host decides by rights.
 */
/**
 * The high-risk rule for rights a person chose: null when they may be stored,
 * else the sentence that asks for the confirmation. High risk needs the
 * person's explicit confirmation (`confirmHighRisk: true`).
 */
export function laneShareHighRiskRefusal(rights: LaneShareRights, confirmHighRisk: unknown): string | null {
  const risk = laneShareRiskLevel(rights);
  return risk.level === "high" && confirmHighRisk !== true
    ? `These rights are high risk: ${risk.reasons.join("; ")}. Confirm them to continue.`
    : null;
}

/** Whether a guest may move work between its machine and the owner's: Collaborate (send and start chats). */
export function laneShareMayMove(rights: Pick<LaneShareRights, "speak" | "run"> | null | undefined): boolean {
  return Boolean(rights?.speak.send && rights.run.startChats);
}

/** The share's own end date (`rights.limits.endsAt`) has passed. */
export function laneShareRightsEnded(rights: Pick<LaneShareRights, "limits">, nowMs: number): boolean {
  return rights.limits.endsAt != null && nowMs >= rights.limits.endsAt;
}

export function laneSharePresetLabel(rights: LaneShareRights): LaneSharePresetName {
  for (const name of [...LANE_SHARE_PRESET_NAMES].reverse()) {
    if (covers(rights, laneSharePresetRights(name))) return name;
  }
  return "watch";
}

/**
 * A person's name as a guest sees it in a message, a presence list or a commit
 * trailer. Same rule as the invite email's sender name: nothing that reads as
 * a link, a host name or an address, no markup, control or format characters,
 * at most 60 characters. Null when nothing is left.
 */
export function laneShareDisplayName(label: string | null | undefined): string | null {
  if (typeof label !== "string" || !label) return null;
  const words = label
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, " ")
    .split(/\s+/)
    .filter((word) =>
      word
      && !/[:/\\]/.test(word)
      && !/^www\b/i.test(word)
      && !/[\p{L}\p{N}][.。．｡][\p{L}\p{N}]/u.test(word))
    .map((word) => word.replace(/[@<>"'`{}[\]|=&]/g, ""))
    .filter(Boolean);
  const name = words.join(" ").slice(0, 60).trim();
  return name || null;
}

// ---------------------------------------------------------------------------
// The daily message window.
//
// A daily limit counts guest messages per LOCAL day of the host machine: from
// midnight to midnight in the host's time zone at the moment of the message.
// The day key is that date, `YYYY-MM-DD`. The count starts again only when
// the day key moves FORWARD past the stored one:
//   - a host clock moved back keeps the stored count (no fresh day for free);
//   - a time zone change that repeats a date keeps counting it;
//   - one that skips ahead starts the new day at once.
// `timeZone` is for tests; the host passes nothing and uses its own zone.

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = dayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(key, formatter);
  }
  return formatter;
}

/** The host's local date at `ms`, `YYYY-MM-DD`. */
export function laneShareLocalDayKey(ms: number, timeZone?: string): string {
  const parts = dayFormatter(timeZone).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** The first millisecond after `ms` whose local date is later than the date at `ms`. */
export function laneShareNextDayStart(ms: number, timeZone?: string): number {
  const today = laneShareLocalDayKey(ms, timeZone);
  let low = ms;
  // A local day is at most 26 hours long (time zone transitions included).
  let high = ms + 27 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (laneShareLocalDayKey(middle, timeZone) > today) high = middle;
    else low = middle;
  }
  return high;
}

// ---------------------------------------------------------------------------
// What a guest reads about its own share (`laneShare.getGuestState`).

export type LaneShareGuestPresence = {
  kind: "owner" | "guest";
  /** Null when the owner hides its machines, or no trusted name exists. */
  name: string | null;
  /** True for the asking guest's own entry. */
  self?: boolean;
};

export type LaneShareGuestState = {
  grantId: string;
  laneId: string;
  /** `paused`: the lane is archived on the host. */
  state: "active" | "paused";
  endsAt: number | null;
  /** The rights, as the host enforces them. */
  rights: LaneShareRights;
  /** Models the guest may use (`run.models`); with hidden models, nothing else of the host's is named. */
  models: string[];
  limits: {
    messagesPerDay: number | null;
    messagesTotal: number | null;
    /** Null: no such limit. */
    messagesLeftToday: number | null;
    messagesLeftTotal: number | null;
    /** When the daily count starts again (host clock). Null without a daily limit. */
    dailyResetAt: number | null;
  };
  /** Null when the owner hides its machines. */
  machine: { name: string; platform: string } | null;
  present: LaneShareGuestPresence[];
  /**
   * The move of a chat to or from this guest that is live or just ended
   * (`shared/laneShareMove.ts`). Absent from an older host.
   */
  move?: (LaneShareMoveView & { received?: number }) | null;
};
