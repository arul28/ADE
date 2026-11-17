/**
 * Lane mentions from the account lane index (`GET /account/lanes`): where a
 * pull request, a notification or a search result names a lane, the real
 * lane name and the machine it is on, with no computer on.
 *
 * The index is for mentions only. It never fills the Lanes tab, and a
 * mention never renames or deletes a lane (that lives in the Lanes tab and
 * the lane menu). A lane on two machines is two rows. A deleted lane, or a PR
 * whose branch has no lane, has no row, so it shows no lane.
 */

import { useMemo } from "react";
import type { AccountLaneIndexRow } from "../../../../../../account-directory/src/cloud/contract";
import { accountRepoScopeKey } from "../../../../shared/accountSettingsScope";
import { ADE_CLOUD_NAME } from "../../../../shared/adeCloudMachine";
import { PRIMARY_LANE_DISPLAY_NAME, laneDisplayName } from "../../../../shared/laneDisplayName";
import { useAdeCloudAccountRead } from "../../../lib/adeCloudAccountRead";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "../../../state/adeCloudLaneIndex";

export type LaneMention = {
  key: string;
  laneId: string;
  /** What the person reads: `laneDisplayName` rules ("Main checkout" for the primary lane). */
  laneName: string;
  /** "ADE Cloud" for a cloud computer, else the machine's own name. */
  machineName: string;
  /** An ADE Cloud computer: never offline (asleep is still readable). */
  cloud: boolean;
  /** An own computer that is connected to the account now. */
  online: boolean;
};

/** The index's project filter for a repository address: `github.com/owner/repo`. */
export function laneIndexProjectKey(origin: string | null | undefined): string | null {
  const scope = accountRepoScopeKey(origin);
  return scope ? scope.slice("repo:".length) : null;
}

export function laneMentionOf(
  row: AccountLaneIndexRow & { cloud?: boolean },
  isCloud: (machineKey: string) => boolean,
): LaneMention {
  const cloud = row.cloud === true || isCloud(row.machineKey);
  const laneName = row.isPrimary
    ? laneDisplayName({ name: row.name, laneType: "primary" }) || PRIMARY_LANE_DISPLAY_NAME
    : row.name;
  return {
    key: `${row.machineKey}\0${row.laneId}`,
    laneId: row.laneId,
    laneName,
    machineName: cloud ? ADE_CLOUD_NAME : row.machineName?.trim() || "another computer",
    cloud,
    online: cloud || row.online,
  };
}

/** What "Open lane" says for a lane whose own computer is offline. */
export function laneOfflineSentence(mention: Pick<LaneMention, "machineName">): string {
  return `This lane is on ${mention.machineName}, which is offline. Open it when ${mention.machineName} is on.`;
}

/**
 * The repository's lane mentions by PR number, from one read of the index
 * (never one read per row). `failed` keeps the rows read before it.
 */
export function useLaneMentionsByPr(origin: string | null | undefined, active: boolean): {
  byPr: ReadonlyMap<number, readonly LaneMention[]>;
  failed: { code: string; message: string } | null;
  retry: () => void;
} {
  const project = laneIndexProjectKey(origin);
  const { state, retry } = useAdeCloudAccountRead(active && project ? { call: "accountLanes" as const, project } : null);
  const cloudIndex = useAdeCloudLaneComputers();
  const byPr = useMemo(() => {
    const map = new Map<number, LaneMention[]>();
    const rows = state.data?.lanes ?? [];
    const isCloud = (machineKey: string) => isAdeCloudComputer({ machineKey }, cloudIndex);
    for (const row of rows) {
      if (row.prNumber == null) continue;
      const list = map.get(row.prNumber) ?? [];
      list.push(laneMentionOf(row, isCloud));
      map.set(row.prNumber, list);
    }
    return map;
  }, [cloudIndex, state.data]);
  const failed = state.status === "failed" ? { code: state.code, message: state.message } : null;
  return { byPr, failed, retry };
}
