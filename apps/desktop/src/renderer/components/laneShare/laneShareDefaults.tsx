import { useCallback, useEffect, useState } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import {
  LANE_SHARE_DEFAULT_RIGHTS_KEY,
  LANE_SHARE_PRESET_NAMES,
  laneSharePresetRights,
  laneShareRiskLevel,
  parseLaneShareRights,
  type LaneSharePresetName,
  type LaneShareRights,
} from "../../../shared/laneShareRights";
import { confirmDialog } from "../ui/dialog";

/**
 * "Default access": the start value of the share sheet for a new person.
 * One value per account, in the account settings store (scope `all`), so
 * every machine of the account starts from the same rights. The end date is
 * never part of it: an end is chosen per share.
 */
export { LANE_SHARE_DEFAULT_RIGHTS_KEY };

export type LaneShareDefaults = {
  preset: LaneSharePresetName | "custom";
  rights: LaneShareRights;
};

const FALLBACK: LaneShareDefaults = { preset: "comment", rights: laneSharePresetRights("comment") };

function withoutEnd(rights: LaneShareRights): LaneShareRights {
  return { ...rights, limits: { ...rights.limits, endsAt: null } };
}

export function parseLaneShareDefaults(value: unknown): LaneShareDefaults {
  if (!value || typeof value !== "object") return FALLBACK;
  const record = value as { preset?: unknown; rights?: unknown };
  const preset = typeof record.preset === "string" && (LANE_SHARE_PRESET_NAMES as readonly string[]).includes(record.preset)
    ? record.preset as LaneSharePresetName
    : "custom";
  return { preset, rights: withoutEnd(parseLaneShareRights(record.rights)) };
}

export async function readLaneShareDefaults(): Promise<LaneShareDefaults> {
  try {
    const result = await window.ade?.accountSettings?.get({ scope: ACCOUNT_SCOPE_ALL, key: LANE_SHARE_DEFAULT_RIGHTS_KEY });
    if (!result || result.ok !== true || result.value == null) return FALLBACK;
    return parseLaneShareDefaults(result.value);
  } catch {
    return FALLBACK;
  }
}

/** Saves the defaults. Returns a sentence when the account did not take it. */
export async function writeLaneShareDefaults(defaults: LaneShareDefaults): Promise<string | null> {
  const api = window.ade?.accountSettings;
  if (!api) return "Account settings aren't available here.";
  try {
    const result = await api.set({
      scope: ACCOUNT_SCOPE_ALL,
      key: LANE_SHARE_DEFAULT_RIGHTS_KEY,
      value: { preset: defaults.preset, rights: withoutEnd(defaults.rights) },
    });
    return result?.ok === true ? null : (result && "message" in result && typeof result.message === "string" ? result.message : "The default rights were not saved.");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The defaults, read once per mount. `loaded` turns true after the first read (or its failure). */
export function useLaneShareDefaults(): { defaults: LaneShareDefaults; loaded: boolean; reload: () => void } {
  const [state, setState] = useState<{ defaults: LaneShareDefaults; loaded: boolean }>({ defaults: FALLBACK, loaded: false });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void readLaneShareDefaults().then((defaults) => {
      if (!cancelled) setState({ defaults, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...state, reload };
}

/**
 * The "Confirm high risk share" dialog: the exact reasons, and a box the owner
 * must tick ("I trust <who> with this computer") before the share is sent.
 */
export async function confirmHighRiskShare(who: string, rights: LaneShareRights): Promise<boolean> {
  const { reasons } = laneShareRiskLevel(rights);
  return await confirmDialog({
    title: "Confirm high risk share",
    message: "These rights let this person act on your computer:",
    tone: "warning",
    size: "md",
    confirmLabel: "Share",
    children: (
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12px] leading-[1.45] text-fg/80" data-testid="lane-share-high-risk-reasons">
        {reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
    ),
    checkboxes: [{ key: "trust", label: `I trust ${who} with this computer`, defaultChecked: false, required: true }],
  });
}
