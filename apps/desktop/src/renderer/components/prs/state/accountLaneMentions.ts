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
  /** The account key of the lane's computer. */
  machineKey: string;
  /** An ADE Cloud computer: never offline (asleep is still readable). */
  cloud: boolean;
  /** False only for an own computer that is not connected: the offline sentence. */
  online: boolean;
  /** An ADE Cloud computer that is asleep: opening the lane wakes it. */
  resting: boolean;
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
    machineKey: row.machineKey,
    cloud,
    online: cloud || row.online,
    resting: cloud && !row.online,
  };
}

/** What "Open lane" says for a lane whose own computer is offline. */
export function laneOfflineSentence(mention: Pick<LaneMention, "machineName">): string {
  return `This lane is on ${mention.machineName}, which is offline. Open it when ${mention.machineName} is on.`;
}

type LaneMentionsRead = {
  /** Every lane of the repository in the index, in the server's order. */
  mentions: readonly (LaneMention & { prNumber: number | null })[];
  byPr: ReadonlyMap<number, readonly LaneMention[]>;
  failed: { code: string; message: string } | null;
  retry: () => void;
};

/**
 * The repository's lane mentions, from one read of the index while `active`
 * (never one read per row). A surface reads it once when it opens. `failed`
 * keeps the rows read before it.
 */
export function useLaneMentions(origin: string | null | undefined, active: boolean): LaneMentionsRead {
  const project = laneIndexProjectKey(origin);
  const { state, retry } = useAdeCloudAccountRead(active && project ? { call: "accountLanes" as const, project } : null);
  const cloudIndex = useAdeCloudLaneComputers();
  const { mentions, byPr } = useMemo(() => {
    const rows = state.data?.lanes ?? [];
    const isCloud = (machineKey: string) => isAdeCloudComputer({ machineKey }, cloudIndex);
    const all = rows.map((row) => ({ ...laneMentionOf(row, isCloud), prNumber: row.prNumber ?? null }));
    const map = new Map<number, LaneMention[]>();
    for (const mention of all) {
      if (mention.prNumber == null) continue;
      const list = map.get(mention.prNumber) ?? [];
      list.push(mention);
      map.set(mention.prNumber, list);
    }
    return { mentions: all, byPr: map };
  }, [cloudIndex, state.data]);
  const failed = state.status === "failed" ? { code: state.code, message: state.message } : null;
  return { mentions, byPr, failed, retry };
}

/** The repository's lane mentions by PR number (`useLaneMentions`). */
export function useLaneMentionsByPr(origin: string | null | undefined, active: boolean): Omit<LaneMentionsRead, "mentions"> {
  const { byPr, failed, retry } = useLaneMentions(origin, active);
  return { byPr, failed, retry };
}

/** Shortest lane name a free text is matched against: shorter names match too many words. */
const MIN_NAMED_LANE_CHARS = 4;

/**
 * The lanes a free text (a CTO message) names by their full name, as whole
 * words, case-insensitive, in the order of the index. The main checkout is
 * never matched: its name is a common phrase.
 */
export function lanesNamedInText<M extends LaneMention>(text: string, mentions: readonly M[]): M[] {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return [];
  const found: M[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const name = mention.laneName.trim().toLowerCase();
    if (name.length < MIN_NAMED_LANE_CHARS || name === PRIMARY_LANE_DISPLAY_NAME.toLowerCase()) continue;
    if (seen.has(mention.key)) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(name, from);
      if (at < 0) break;
      const before = at === 0 ? "" : haystack[at - 1]!;
      const after = haystack[at + name.length] ?? "";
      if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)) {
        found.push(mention);
        seen.add(mention.key);
        break;
      }
      from = at + 1;
    }
  }
  return found;
}

/** How a search row names a lane on another machine: "<lane> on <machine>". */
export function laneMentionLabel(mention: Pick<LaneMention, "laneName" | "machineName">): string {
  return `${mention.laneName} on ${mention.machineName}`;
}
