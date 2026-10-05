import { useMemo } from "react";
import type { TurnFold } from "../../../shared/chatTurnFold";
import { sameSetContents, useStableIdentity } from "../../lib/stableIdentity";
import { deriveWakeTurns, sameWakeChains, type WakeChain } from "./chatScheduledWorkRows";
import type { ChatActivityBundleItem, ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set();

/**
 * Self-paced wake loops in the message list. A wake turn draws no `Worked for …`
 * row: its fold opens from the `ran …` time on its turn-end line, which keeps its
 * tool and file counts. A run of wake turns folds every check but the latest
 * under a `+N more checks` chip on the line above them.
 */
export function useWakeLoopFolds(
  presentedRows: readonly ChatTranscriptGroupedEnvelope[],
  scheduledWorkByTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]>,
  turnFolds: readonly TurnFold[],
) {
  const wakeTurns = useMemo(
    () => deriveWakeTurns(presentedRows, scheduledWorkByTurnEndKey),
    [presentedRows, scheduledWorkByTurnEndKey],
  );
  const wakeChains = useStableIdentity(wakeTurns.chains, sameWakeChains);
  const wakeTurnIds = useStableIdentity(wakeTurns.turnIds.size ? wakeTurns.turnIds : EMPTY_TURN_IDS, sameSetContents);
  return useMemo(() => {
    const wakeTurnFoldIdByTurnEndKey = new Map<string, string>();
    for (const fold of turnFolds) {
      if (wakeTurnIds.has(fold.turnId)) wakeTurnFoldIdByTurnEndKey.set(fold.turnEndKey, fold.foldId);
    }
    const wakeChainByAnchorKey = new Map<string, WakeChain>();
    for (const chain of wakeChains) {
      if (chain.anchorTurnEndKey) wakeChainByAnchorKey.set(chain.anchorTurnEndKey, chain);
    }
    // `done` rows whose tool/file counts moved up to their turn's fold row. By
    // row key, not turn id: an id-less `done` folds under an inferred id.
    const foldedTurnEndKeys = new Set(
      turnFolds.filter((fold) => !wakeTurnIds.has(fold.turnId)).map((fold) => fold.turnEndKey),
    );
    return { wakeChains, wakeTurnIds, wakeTurnFoldIdByTurnEndKey, wakeChainByAnchorKey, foldedTurnEndKeys };
  }, [turnFolds, wakeChains, wakeTurnIds]);
}
