import { create } from "zustand";
import {
  QUICK_SLOTS_STORAGE_KEY,
  defaultQuickSlotsPreferences,
  normalizeQuickSlots,
  type ModelProfile,
  type QuickSlot,
  type QuickSlotArgs,
  type QuickSlotCaretBehavior,
  type QuickSlotsPreferences,
} from "../../shared/quickSlots";

/**
 * Quick slots are one app-wide preference, not a project setting: they act on
 * whatever chat, lane or tool is in front of you. They live in their own
 * localStorage key (rather than the account preferences blob) so the slot list
 * has one owner and a malformed value can never take the theme or chat prefs
 * down with it.
 */
function readPreferences(): QuickSlotsPreferences {
  try {
    const raw = window.localStorage.getItem(QUICK_SLOTS_STORAGE_KEY);
    if (!raw) return defaultQuickSlotsPreferences();
    return normalizeQuickSlots(JSON.parse(raw));
  } catch {
    return defaultQuickSlotsPreferences();
  }
}

function persist(preferences: QuickSlotsPreferences): void {
  try {
    window.localStorage.setItem(QUICK_SLOTS_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // localStorage can be unavailable or full; the in-memory list still works.
  }
}

export function newModelProfileId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `profile-${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type QuickSlotsState = QuickSlotsPreferences & {
  setSlot: (index: number, commandId: string | null, args?: QuickSlotArgs, label?: string) => void;
  setLeader: (leader: QuickSlotsPreferences["leader"]) => void;
  setKeepOpenAfterRelease: (keep: boolean) => void;
  setProfileCaretBehavior: (behavior: QuickSlotCaretBehavior) => void;
  upsertProfile: (profile: ModelProfile) => void;
  removeProfile: (id: string) => void;
  resetSlots: () => void;
  /** Re-read after another window wrote the key. */
  reload: () => void;
};

function writePreferences(
  get: () => QuickSlotsState,
  set: (partial: Partial<QuickSlotsState>) => void,
  patch: Partial<QuickSlotsPreferences>,
): void {
  const current = get();
  const next: QuickSlotsPreferences = normalizeQuickSlots({
    version: 1,
    slots: patch.slots ?? current.slots,
    profiles: patch.profiles ?? current.profiles,
    leader: patch.leader ?? current.leader,
    keepOpenAfterRelease: patch.keepOpenAfterRelease ?? current.keepOpenAfterRelease,
    profileCaretBehavior: patch.profileCaretBehavior ?? current.profileCaretBehavior,
  });
  persist(next);
  set(next);
}

export const useQuickSlotsStore = create<QuickSlotsState>((set, get) => ({
  ...readPreferences(),
  setSlot: (index, commandId, args, label) => {
    const slot: QuickSlot = {
      index,
      commandId,
      ...(args && Object.keys(args).length ? { args } : {}),
      ...(label ? { label } : {}),
    };
    const slots = get().slots.map((entry) => (entry.index === index ? slot : entry));
    writePreferences(get, set, { slots });
  },
  setLeader: (leader) => writePreferences(get, set, { leader }),
  setKeepOpenAfterRelease: (keepOpenAfterRelease) => writePreferences(get, set, { keepOpenAfterRelease }),
  setProfileCaretBehavior: (profileCaretBehavior) => writePreferences(get, set, { profileCaretBehavior }),
  upsertProfile: (profile) => {
    const trimmed: ModelProfile = {
      ...profile,
      name: profile.name.trim().slice(0, 60),
      modelId: profile.modelId.trim(),
      reasoningEffort: profile.reasoningEffort?.trim() || null,
    };
    if (!trimmed.name || !trimmed.modelId) return;
    const current = get().profiles;
    const index = current.findIndex((entry) => entry.id === trimmed.id);
    const profiles = index >= 0
      ? current.map((entry) => (entry.id === trimmed.id ? trimmed : entry))
      : [...current, trimmed].slice(-24);
    writePreferences(get, set, { profiles });
  },
  removeProfile: (id) => {
    const profiles = get().profiles.filter((entry) => entry.id !== id);
    const slots = get().slots.map((slot) =>
      slot.commandId === "model.applyProfile" && slot.args?.profileId === id
        ? { index: slot.index, commandId: null }
        : slot,
    );
    writePreferences(get, set, { profiles, slots });
  },
  resetSlots: () => writePreferences(get, set, { slots: defaultQuickSlotsPreferences().slots }),
  reload: () => set(readPreferences()),
}));

/** Read outside React (the dispatcher runs on a window event). */
export function getQuickSlotsPreferences(): QuickSlotsPreferences {
  return useQuickSlotsStore.getState();
}
