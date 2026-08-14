import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cursorCloudErrorMessage, repoMatchKey, type CursorCloudExistingPr } from "../../lib/cursorCloudUtils";
import { isInjectableCloudSecretName } from "./CursorCloudSecretsPicker";

export type CursorCloudRepoListState =
  | { status: "loading" }
  | { status: "ready"; urls: string[] }
  | { status: "error"; message: string };

type UseCursorCloudDraftStateInput = {
  cursorCloudAvailable: boolean;
  laneId: string | null;
  laneGitRemote: string | null;
  laneGitBranch: string | null;
};

/**
 * Owns the draft-only Cursor Cloud composer state: cloud mode, Auto-PR, and the
 * account repo list used to decide whether this lane can launch there.
 *
 * The repo list is tri-state so a pending or failed probe cannot look like
 * "this repo is not connected" and a failed probe can be retried.
 */
export function useCursorCloudDraftState({
  cursorCloudAvailable,
  laneId,
  laneGitRemote,
  laneGitBranch,
}: UseCursorCloudDraftStateInput) {
  const [cursorCloudMode, setCursorCloudMode] = useState(false);
  const [cursorCloudAutoPr, setCursorCloudAutoPr] = useState(false);
  const [selectedSecretNames, setSelectedSecretNames] = useState<string[]>([]);
  const [rememberSecretNames, setRememberSecretNames] = useState(false);
  const [availableSecretNames, setAvailableSecretNames] = useState<string[]>([]);
  const [existingPr, setExistingPr] = useState<CursorCloudExistingPr | null>(null);
  const [repoState, setRepoState] = useState<CursorCloudRepoListState>({ status: "loading" });
  const [repoFetchGeneration, setRepoFetchGeneration] = useState(0);
  const repoStateRef = useRef(repoState);
  repoStateRef.current = repoState;

  const refetchCursorCloudRepos = useCallback(() => {
    if (repoStateRef.current.status !== "error") return;
    setRepoFetchGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!cursorCloudAvailable) return;
    if (repoStateRef.current.status === "ready") return;
    let cancelled = false;
    setRepoState({ status: "loading" });
    void window.ade.ai
      .cursorCloudListRepositories()
      .then((repos) => {
        if (cancelled) return;
        setRepoState({ status: "ready", urls: repos.map((repo) => repo.url) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRepoState({ status: "error", message: cursorCloudErrorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [cursorCloudAvailable, laneId, repoFetchGeneration]);

  useEffect(() => {
    if (!cursorCloudAvailable) {
      setAvailableSecretNames([]);
      return;
    }
    let cancelled = false;
    const list = window.ade.projectSecrets?.list;
    if (!list) {
      setAvailableSecretNames([]);
      return;
    }
    void list()
      .then((result) => {
        if (cancelled) return;
        setAvailableSecretNames(
          (result.secrets ?? [])
            .map((secret) => secret.name)
            .filter(isInjectableCloudSecretName),
        );
      })
      .catch(() => {
        if (!cancelled) setAvailableSecretNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorCloudAvailable, laneId]);

  useEffect(() => {
    if (!cursorCloudAvailable || !laneId) {
      setSelectedSecretNames([]);
      setRememberSecretNames(false);
      return;
    }
    let cancelled = false;
    const readRemembered = window.ade.ai.cursorCloudGetLaneSecretNames;
    if (!readRemembered) {
      setSelectedSecretNames([]);
      setRememberSecretNames(false);
      return;
    }
    void readRemembered(laneId)
      .then((names) => {
        if (cancelled) return;
        const injectable = names.filter(isInjectableCloudSecretName);
        setSelectedSecretNames(injectable);
        setRememberSecretNames(injectable.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedSecretNames([]);
        setRememberSecretNames(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorCloudAvailable, laneId]);

  useEffect(() => {
    if (!cursorCloudAvailable || !laneId || !laneGitBranch?.trim()) {
      setExistingPr(null);
      return;
    }
    const getOpenPr = window.ade.git?.getOpenPrForBranch;
    if (!getOpenPr) {
      setExistingPr(null);
      return;
    }
    let cancelled = false;
    void getOpenPr({ laneId, branch: laneGitBranch })
      .then((result) => {
        if (cancelled) return;
        const prUrl = result?.prUrl?.trim() || "";
        setExistingPr(prUrl
          ? {
              prUrl,
              prNumber: result.prNumber,
              title: result.title,
            }
          : null);
      })
      .catch(() => {
        if (!cancelled) setExistingPr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorCloudAvailable, laneGitBranch, laneId]);

  const cursorCloudRepoUrl = useMemo(() => {
    const target = repoMatchKey(laneGitRemote);
    if (!target || repoState.status !== "ready") return null;
    return repoState.urls.find((url) => repoMatchKey(url) === target) ?? null;
  }, [laneGitRemote, repoState]);

  const cursorCloudUnavailableReason = useMemo(() => {
    if (!cursorCloudAvailable) return null;
    if (repoState.status === "loading") return "Checking Cursor Cloud…";
    if (repoState.status === "error") return repoState.message;
    if (!laneGitRemote) {
      return "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.";
    }
    if (!cursorCloudRepoUrl) {
      return "This repo is not connected to Cursor. Connect it in Cursor, then try again.";
    }
    return null;
  }, [cursorCloudAvailable, cursorCloudRepoUrl, laneGitRemote, repoState]);

  useEffect(() => {
    if (cursorCloudMode && cursorCloudUnavailableReason) setCursorCloudMode(false);
  }, [cursorCloudMode, cursorCloudUnavailableReason]);

  return {
    cursorCloudMode,
    setCursorCloudMode,
    cursorCloudAutoPr,
    setCursorCloudAutoPr,
    selectedSecretNames,
    setSelectedSecretNames,
    rememberSecretNames,
    setRememberSecretNames,
    availableSecretNames,
    existingPr,
    cursorCloudRepoUrl,
    cursorCloudUnavailableReason,
    refetchCursorCloudRepos,
  };
}
