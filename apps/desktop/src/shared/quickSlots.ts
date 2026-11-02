// Quick slots: nine user-assigned commands, invoked with one leader chord.
//
// The slot stores a command id and, when the command needs one, its arguments.
// The label is cached beside the id so a command that is renamed or removed can
// still be shown honestly ("action unavailable — pick another") instead of
// becoming a dead key.
//
// Pure: no React, no DOM reads. The renderer, the hosted web client, the TUI
// metadata reader, and the tests all share this file.

import { formatModelMentionToken } from "./modelMentions";

/** Exactly nine: one digit each, one 3×3 grid. */
export const QUICK_SLOT_COUNT = 9;

export const QUICK_SLOTS_STORAGE_KEY = "ade.quickSlots.v1";

/** The command ids the shipped defaults name. Other commands use their own ids. */
export const QUICK_SLOT_COMMAND_IDS = {
  chatNew: "chat.new",
  chatFocusComposer: "chat.focusComposer",
  chatInsertPrompt: "chat.insertPrompt",
  chatStopTurn: "chat.stopTurn",
  modelOpenPicker: "model.openPicker",
  modelCycleThinking: "model.cycleThinking",
  modelCyclePermission: "model.cyclePermission",
  modelToggleFast: "model.toggleFast",
  modelApplyProfile: "model.applyProfile",
  modelSaveProfile: "model.saveProfile",
  laneOpenPr: "lane.openPr",
  laneCreatePr: "lane.createPr",
  laneCopyBranch: "lane.copyBranch",
  lanePush: "lane.push",
  laneOpenWorktree: "lane.openWorktree",
  laneRebase: "lane.rebase",
  laneCreate: "lane.create",
  toolTerminal: "tool.terminal",
  toolBrowser: "tool.browser",
  toolGit: "tool.git",
  toolPr: "tool.pr",
  toolIssues: "tool.issues",
  toolFiles: "tool.files",
  toolIos: "tool.ios",
  toolAppControl: "tool.app-control",
  toolMacDesktop: "tool.mac-desktop",
  toolWindowsDesktop: "tool.windows-desktop",
  navWork: "nav.work",
  navLanes: "nav.lanes",
  navFiles: "nav.files",
  navPrs: "nav.prs",
  navSettings: "nav.settings",
  navCommandPalette: "nav.commandPalette",
} as const;

/** What a slot's command does. The HUD prints this under the label. */
export type QuickSlotKind = "run" | "set" | "go" | "write";

/** Where the command reads its target from. `chat` implies a registered composer. */
export type QuickSlotNeeds = "none" | "chat" | "lane";

/**
 * How much consequence one press carries.
 *
 * - `instant`: safe, reversible or purely navigational.
 * - `confirm`: the HUD arms on the first press and runs on the second.
 * - `surface`: opens the place where the action is configured; never performs
 *   the write itself (a rebase scope, a PR base branch, a lane name).
 */
export type QuickSlotSafety = "instant" | "confirm" | "surface";

export type QuickSlotArgs = Record<string, string>;

export type QuickSlot = {
  /** 1–9. */
  index: number;
  /** Null is an empty slot. */
  commandId: string | null;
  args?: QuickSlotArgs;
  /** The title the command had when it was assigned. Shown if the id is gone. */
  label?: string;
};

/**
 * A saved model setup. It is deliberately model + thinking only: permission
 * tiers belong to the harness and stay a live composer choice, the same rule
 * harness presets follow. A profile is what the `@model` chip names, minus the
 * permission half (the chip takes the composer's current permission).
 */
export type ModelProfile = {
  id: string;
  name: string;
  modelId: string;
  reasoningEffort: string | null;
};

export type QuickSlotCaretBehavior = "insert" | "set";

export type QuickSlotsPreferences = {
  version: 1;
  slots: QuickSlot[];
  profiles: ModelProfile[];
  /**
   * macOS only as an option today. `default` is Option+Command on macOS and
   * Control+Shift on Windows; `alternate` is Control+Option on macOS (the
   * Option+Command row conflicts with macOS Zoom on 8). Windows has one leader
   * because Control+Alt is AltGr on many layouts.
   */
  leader: "default" | "alternate";
  /** Keep the panel open after the keys are released (accessibility). */
  keepOpenAfterRelease: boolean;
  /** What a model-profile slot does when the caret is in the composer. */
  profileCaretBehavior: QuickSlotCaretBehavior;
};

export function defaultQuickSlots(): QuickSlot[] {
  const ids: Array<{ id: string; label: string }> = [
    { id: QUICK_SLOT_COMMAND_IDS.chatNew, label: "New chat" },
    { id: QUICK_SLOT_COMMAND_IDS.modelOpenPicker, label: "Model picker" },
    { id: QUICK_SLOT_COMMAND_IDS.modelCycleThinking, label: "Thinking up" },
    { id: QUICK_SLOT_COMMAND_IDS.toolGit, label: "Git" },
    { id: QUICK_SLOT_COMMAND_IDS.toolTerminal, label: "Terminal" },
    { id: QUICK_SLOT_COMMAND_IDS.laneOpenPr, label: "Open PR" },
    { id: QUICK_SLOT_COMMAND_IDS.laneCopyBranch, label: "Copy branch" },
    { id: QUICK_SLOT_COMMAND_IDS.navCommandPalette, label: "Command palette" },
    { id: QUICK_SLOT_COMMAND_IDS.chatFocusComposer, label: "Prompt box" },
  ];
  return ids.map((entry, index) => ({
    index: index + 1,
    commandId: entry.id,
    label: entry.label,
  }));
}

export function defaultQuickSlotsPreferences(): QuickSlotsPreferences {
  return {
    version: 1,
    slots: defaultQuickSlots(),
    profiles: [],
    leader: "default",
    keepOpenAfterRelease: false,
    profileCaretBehavior: "insert",
  };
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizeArgs(value: unknown): QuickSlotArgs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: QuickSlotArgs = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 8) break;
    const k = cleanString(key, 64);
    const v = cleanString(raw, 512);
    if (!k || v == null) continue;
    out[k] = v;
    count += 1;
  }
  return count ? out : undefined;
}

function normalizeSlot(raw: unknown, fallback: QuickSlot): QuickSlot {
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const index = Number(record.index);
  const safeIndex = Number.isInteger(index) && index >= 1 && index <= QUICK_SLOT_COUNT
    ? index
    : fallback.index;
  const commandId = record.commandId == null ? null : cleanString(record.commandId, 120);
  const label = cleanString(record.label, 80) ?? undefined;
  const args = normalizeArgs(record.args);
  return {
    index: safeIndex,
    commandId,
    ...(args ? { args } : {}),
    ...(label ? { label } : {}),
  };
}

function normalizeProfile(raw: unknown): ModelProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanString(record.id, 80);
  const name = cleanString(record.name, 60);
  const modelId = cleanString(record.modelId, 240);
  if (!id || !name || !modelId) return null;
  const effort = cleanString(record.reasoningEffort, 40);
  return { id, name, modelId, reasoningEffort: effort };
}

function normalizeLeader(raw: unknown): QuickSlotsPreferences["leader"] {
  return raw === "alternate" ? "alternate" : "default";
}

export function normalizeQuickSlots(raw: unknown): QuickSlotsPreferences {
  const defaults = defaultQuickSlotsPreferences();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Record<string, unknown>;

  const byIndex = new Map<number, QuickSlot>();
  if (Array.isArray(record.slots)) {
    for (const entry of record.slots.slice(0, QUICK_SLOT_COUNT * 3)) {
      const fallback = defaults.slots.find((slot) => slot.index === Number((entry as { index?: unknown })?.index))
        ?? { index: byIndex.size + 1, commandId: null };
      const slot = normalizeSlot(entry, fallback);
      if (!byIndex.has(slot.index)) byIndex.set(slot.index, slot);
    }
  }
  const slots = Array.from({ length: QUICK_SLOT_COUNT }, (_, i) => {
    const index = i + 1;
    return byIndex.get(index) ?? defaults.slots[i]!;
  });

  const profiles: ModelProfile[] = [];
  const seenProfiles = new Set<string>();
  if (Array.isArray(record.profiles)) {
    for (const entry of record.profiles.slice(0, 24)) {
      const profile = normalizeProfile(entry);
      if (!profile || seenProfiles.has(profile.id)) continue;
      seenProfiles.add(profile.id);
      profiles.push(profile);
    }
  }

  return {
    version: 1,
    slots,
    profiles,
    leader: normalizeLeader(record.leader),
    keepOpenAfterRelease: record.keepOpenAfterRelease === true,
    profileCaretBehavior: record.profileCaretBehavior === "set" ? "set" : "insert",
  };
}

export type QuickSlotLeaderEvent = {
  code?: string;
  key?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * The leader for one platform. macOS has two options because Option+Command+8
 * is macOS Zoom; Windows has one because Control+Alt is AltGr on most layouts.
 */
export function quickSlotLeaderModifiers(
  leader: QuickSlotsPreferences["leader"],
  isMac: boolean,
): { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } {
  if (isMac) {
    return leader === "alternate"
      ? { meta: false, ctrl: true, alt: true, shift: false }
      : { meta: true, ctrl: false, alt: true, shift: false };
  }
  return { meta: false, ctrl: true, alt: false, shift: true };
}

export function quickSlotLeaderLabel(leader: QuickSlotsPreferences["leader"], isMac: boolean): string {
  if (!isMac) return "Ctrl+Shift";
  return leader === "alternate" ? "Ctrl+Option" : "Option+Command";
}

/** The `aria-keyshortcuts` grammar (DOM key names, not the display glyphs). */
export function quickSlotAriaShortcut(
  index: number,
  leader: QuickSlotsPreferences["leader"],
  isMac: boolean,
): string {
  const modifiers = isMac
    ? (leader === "alternate" ? ["Control", "Alt"] : ["Alt", "Meta"])
    : ["Control", "Shift"];
  return [...modifiers, String(index)].join("+");
}

/** True when the event carries exactly the leader modifiers and nothing else. */
export function quickSlotLeaderHeld(
  event: QuickSlotLeaderEvent,
  leader: QuickSlotsPreferences["leader"],
  isMac: boolean,
): boolean {
  const want = quickSlotLeaderModifiers(leader, isMac);
  return event.metaKey === want.meta
    && event.ctrlKey === want.ctrl
    && event.altKey === want.alt
    && event.shiftKey === want.shift;
}

const DIGIT_CODES = /^(?:Digit|Numpad)([1-9])$/;

/**
 * The slot digit the event names, or null.
 *
 * `code` is authoritative: Option+1 on macOS reports `key: "¡"`, and `code` is
 * what still says Digit1. The `key` fallback covers synthetic events (a test or
 * `dispatchEvent`) that carry no code.
 */
export function quickSlotDigitFromEvent(event: Pick<QuickSlotLeaderEvent, "code" | "key">): number | null {
  const fromCode = DIGIT_CODES.exec(event.code ?? "");
  if (fromCode) {
    // Num Lock off turns the numpad into End/Arrow keys. The code still says
    // Numpad1, but the key does not say 1, so it is not a slot digit.
    if ((event.code ?? "").startsWith("Numpad") && !/^[1-9]$/.test(event.key ?? "")) return null;
    return Number(fromCode[1]);
  }
  const key = (event.key ?? "").trim();
  return /^[1-9]$/.test(key) ? Number(key) : null;
}

/** The model token a profile would insert into a prompt, with the chat's own permission. */
export function modelProfileMentionToken(profile: ModelProfile, permission: string | null): string {
  return formatModelMentionToken({
    modelId: profile.modelId,
    effort: profile.reasoningEffort,
    permission,
  });
}

/** A compact "High" / "Default" label for the settings list and the HUD. */
export function reasoningEffortLabel(effort: string | null | undefined): string {
  if (!effort) return "Default";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Match a command to the slot that runs it, for tooltips and palette rows. */
export function slotForCommand(
  slots: readonly QuickSlot[],
  commandId: string,
  args?: QuickSlotArgs,
): QuickSlot | null {
  const argKey = args ? JSON.stringify(args) : null;
  return slots.find((slot) =>
    slot.commandId === commandId
    && (argKey == null || JSON.stringify(slot.args ?? {}) === argKey)) ?? null;
}
