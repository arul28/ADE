import type { AdeCodeProvider } from "../../types";
import type { CursorModelAvailability } from "../../../../../desktop/src/shared/modelRegistry";

export type ModelPickerRailKind = "favorites" | "recents" | "provider";

export type ModelPickerRailEntry =
  | { kind: "favorites"; label: string }
  | { kind: "recents"; label: string }
  | { kind: "provider"; provider: AdeCodeProvider; label: string };

export type ModelPickerEntry = {
  /** Canonical ADE model id (matches modelRegistry.id). Empty string for placeholder. */
  modelId: string;
  /** Provider/runtime model ref (for selection commit). */
  runtimeModelId: string;
  displayName: string;
  family: AdeCodeProvider;
  /** Optional sub-provider label (e.g. "anthropic via OpenCode"). */
  subProvider?: string;
  subProviderKey?: string;
  isFavorite: boolean;
  isAvailable: boolean;
  serviceTiers?: string[];
  cursorAvailability?: CursorModelAvailability;
};

export type ModelPickerProviderTab = {
  key: string;
  label: string;
};

export type ModelPickerState = {
  query: string;
  searchMode: boolean;
  railEntries: ModelPickerRailEntry[];
  railIndex: number;
  entries: ModelPickerEntry[];
  providerTabs: ModelPickerProviderTab[];
  providerTabIndex: number;
  focusedIndex: number;
  activeModelId: string | null;
};
