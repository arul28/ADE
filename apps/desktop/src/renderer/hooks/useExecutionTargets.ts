import { useCallback, useEffect, useState } from "react";
import type { AdeExecutionTargetProfile, AdeExecutionTargetsState } from "../../shared/types";
import {
  ADE_LOCAL_EXECUTION_TARGET_ID,
  defaultExecutionTargetsState,
  executionTargetSummaryLabel,
} from "../../shared/types";

export function useExecutionTargets(projectRoot: string | null | undefined) {
  const [state, setState] = useState<AdeExecutionTargetsState>(() => defaultExecutionTargetsState());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
    if (!root) {
      setState(defaultExecutionTargetsState());
      return;
    }
    setLoading(true);
    try {
      const next = await window.ade.executionTargets.get();
      setState(next);
    } catch {
      setState(defaultExecutionTargetsState());
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = useCallback(
    async (next: AdeExecutionTargetsState) => {
      const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
      if (!root) return;
      const saved = await window.ade.executionTargets.set(next);
      setState(saved);
    },
    [projectRoot],
  );

  const setActiveTargetId = useCallback(
    async (targetId: string) => {
      const id = targetId.trim() || ADE_LOCAL_EXECUTION_TARGET_ID;
      const next: AdeExecutionTargetsState = {
        ...state,
        activeTargetId: state.profiles.some((p) => p.id === id) ? id : ADE_LOCAL_EXECUTION_TARGET_ID,
      };
      await persist(next);
    },
    [persist, state],
  );

  const activeProfile: AdeExecutionTargetProfile | undefined = state.profiles.find((p) => p.id === state.activeTargetId)
    ?? state.profiles.find((p) => p.id === ADE_LOCAL_EXECUTION_TARGET_ID);

  return {
    state,
    loading,
    refresh,
    persist,
    setActiveTargetId,
    activeProfile,
    activeTargetId: state.activeTargetId,
    profiles: state.profiles,
    activeLabel: executionTargetSummaryLabel(activeProfile),
  };
}
