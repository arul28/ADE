import fs from "node:fs";
import path from "node:path";
import type { PrSummary, SessionLifecycleSettings } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { adeHomeDir } from "../skills/cursorAgentSkillShim";
import { writeFileAtomic } from "../state/durableFile";
import type { AdeDb } from "../state/kvDb";

const SETTINGS_KEY = "session:lifecycle-settings:v1";
const PR_MERGE_STATE_KEY = "session:pr-merge-auto-settle:v1";

const DEFAULT_SETTINGS: SessionLifecycleSettings = {
  autoSettleLaneSessionsOnPrMerge: true,
  releaseLaneResourcesOnSettle: false,
};

export type PrMergeAutoSettlementState = {
  enabledSince: string | null;
  handledPrIds: string[];
};

/** The one lifecycle setting that spans projects: a file in this machine's ADE home. */
function machineSettingsPath(): string {
  return path.join(adeHomeDir(), "session-lifecycle.json");
}

function readReleaseLaneResources(): boolean {
  try {
    const stored = JSON.parse(fs.readFileSync(machineSettingsPath(), "utf8")) as { releaseLaneResourcesOnSettle?: unknown };
    return stored?.releaseLaneResourcesOnSettle === true;
  } catch (error) {
    // Off unless the owner turned it on: this stops things. No file is the usual case.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") captureError(error, { tags: { area: "session-lifecycle-settings" } });
    return false;
  }
}

function mergedPrIds(prs: readonly PrSummary[]): string[] {
  return prs.filter((pr) => pr.state === "merged").map((pr) => pr.id);
}

export function getSessionLifecycleSettings(db: Pick<AdeDb, "getJson">): SessionLifecycleSettings {
  const stored = db.getJson<Partial<SessionLifecycleSettings>>(SETTINGS_KEY);
  return {
    autoSettleLaneSessionsOnPrMerge:
      stored?.autoSettleLaneSessionsOnPrMerge !== false,
    releaseLaneResourcesOnSettle: readReleaseLaneResources(),
  };
}

export function setSessionLifecycleSettings(args: {
  db: Pick<AdeDb, "getJson" | "setJson">;
  settings: SessionLifecycleSettings;
  currentPrs: readonly PrSummary[];
  now?: string;
}): SessionLifecycleSettings {
  const previousSettings = getSessionLifecycleSettings(args.db);
  const previousState = getPrMergeAutoSettlementState(args.db);
  const settings = {
    autoSettleLaneSessionsOnPrMerge:
      args.settings.autoSettleLaneSessionsOnPrMerge === true,
    releaseLaneResourcesOnSettle: args.settings.releaseLaneResourcesOnSettle === true,
  };
  // The file first: a failed write then changes nothing.
  if (settings.releaseLaneResourcesOnSettle !== previousSettings.releaseLaneResourcesOnSettle) {
    const file = machineSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify({ releaseLaneResourcesOnSettle: settings.releaseLaneResourcesOnSettle })}\n`);
  }
  args.db.setJson(SETTINGS_KEY, { autoSettleLaneSessionsOnPrMerge: settings.autoSettleLaneSessionsOnPrMerge });
  if (
    previousState
    && previousSettings.autoSettleLaneSessionsOnPrMerge === settings.autoSettleLaneSessionsOnPrMerge
  ) {
    return settings;
  }
  const now = args.now ?? new Date().toISOString();
  args.db.setJson(PR_MERGE_STATE_KEY, {
    enabledSince: settings.autoSettleLaneSessionsOnPrMerge ? now : null,
    handledPrIds: mergedPrIds(args.currentPrs),
  } satisfies PrMergeAutoSettlementState);
  return settings;
}

export function getPrMergeAutoSettlementState(
  db: Pick<AdeDb, "getJson">,
): PrMergeAutoSettlementState | null {
  const stored = db.getJson<Partial<PrMergeAutoSettlementState>>(PR_MERGE_STATE_KEY);
  if (!stored || !Array.isArray(stored.handledPrIds)) return null;
  return {
    enabledSince: typeof stored.enabledSince === "string" ? stored.enabledSince : null,
    handledPrIds: stored.handledPrIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  };
}

export function initializePrMergeAutoSettlementState(args: {
  db: Pick<AdeDb, "setJson">;
  currentPrs: readonly PrSummary[];
  now?: string;
  enabled: boolean;
}): PrMergeAutoSettlementState {
  const state: PrMergeAutoSettlementState = {
    enabledSince: args.enabled ? args.now ?? new Date().toISOString() : null,
    handledPrIds: mergedPrIds(args.currentPrs),
  };
  args.db.setJson(PR_MERGE_STATE_KEY, state);
  return state;
}

export function savePrMergeAutoSettlementState(
  db: Pick<AdeDb, "setJson">,
  state: PrMergeAutoSettlementState,
): void {
  db.setJson(PR_MERGE_STATE_KEY, state);
}
