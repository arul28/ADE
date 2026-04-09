import { useCallback, useEffect, useRef, useState } from "react";
import type { AdeExecutionTargetProfile, AdeExecutionTargetsState } from "../../shared/types";
import {
  ADE_LOCAL_EXECUTION_TARGET_ID,
  defaultExecutionTargetsState,
  executionTargetSummaryLabel,
} from "../../shared/types";

export function useExecutionTargets(projectRoot: string | null | undefined) {
  const [state, setState] = useState<AdeExecutionTargetsState>(() => defaultExecutionTargetsState());
  const [loading, setLoading] = useState(false);
  const normalizedProjectRoot = typeof projectRoot === "string" ? projectRoot.trim() : "";
  const latestProjectRootRef = useRef("");
  const refreshRequestTokenRef = useRef(0);
  const persistRequestTokenRef = useRef(0);
  latestProjectRootRef.current = normalizedProjectRoot;

  const refresh = useCallback(async () => {
    const root = normalizedProjectRoot;
    if (!root) {
      refreshRequestTokenRef.current += 1;
      setState(defaultExecutionTargetsState());
      setLoading(false);
      return;
    }
    const requestToken = ++refreshRequestTokenRef.current;
    setLoading(true);
    try {
      const next = await window.ade.executionTargets.get();
      if (latestProjectRootRef.current === root && refreshRequestTokenRef.current === requestToken) {
        setState(next);
      }
    } catch {
      if (latestProjectRootRef.current === root && refreshRequestTokenRef.current === requestToken) {
        setState(defaultExecutionTargetsState());
      }
    } finally {
      if (latestProjectRootRef.current === root && refreshRequestTokenRef.current === requestToken) {
        setLoading(false);
      }
    }
  }, [normalizedProjectRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = useCallback(
    async (next: AdeExecutionTargetsState) => {
      const root = normalizedProjectRoot;
      if (!root) return;
      const requestToken = ++persistRequestTokenRef.current;
      const saved = await window.ade.executionTargets.set(next);
      if (latestProjectRootRef.current === root && persistRequestTokenRef.current === requestToken) {
        setState(saved);
      }
      return saved;
    },
    [normalizedProjectRoot],
  );

  const setActiveTargetId = useCallback(
    async (targetId: string) => {
      const id = targetId.trim() || ADE_LOCAL_EXECUTION_TARGET_ID;
      const latest = await window.ade.executionTargets.get();
      const next: AdeExecutionTargetsState = {
        ...latest,
        activeTargetId: latest.profiles.some((p) => p.id === id) ? id : ADE_LOCAL_EXECUTION_TARGET_ID,
      };
      await persist(next);
    },
    [persist],
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
