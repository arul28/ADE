import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cursorCloudErrorMessage, repoMatchKey, type CursorCloudExistingPr } from "../../lib/cursorCloudUtils";
import { isInjectableCloudSecretName } from "./CursorCloudSecretsPicker";
import type { LaneGitRemoteStatus } from "./useLaneGitRemote";

export type CursorCloudRepoListState =
  | { status: "loading" }
  | { status: "ready"; urls: string[] }
  | { status: "error"; message: string };

type UseCursorCloudDraftStateInput = {
  cursorCloudAvailable: boolean;
  /**
   * The signed-in Cursor account, only as a refetch trigger: a new account
   * reads its own repo list. The host's cache is keyed by API key, not this.
   */
  cursorAccountKey: string | null;
  laneId: string | null;
  laneGitRemote: string | null;
  laneGitBranch: string | null;
  /** Tri-state read of the lane remote. See `useLaneGitRemote`. */
  laneGitRemoteStatus: LaneGitRemoteStatus;
  laneGitRemoteError: string | null;
};

/**
 * The account's Cursor repositories. The host caches and shares the request,
 * because Cursor allows five a minute per account; `force` (Retry) skips it.
 */
function loadCursorCloudRepoUrls(force: boolean): Promise<string[]> {
  return window.ade.ai
    .cursorCloudListRepositories(force ? { refresh: true } : undefined)
    .then((repos) => repos.map((repo) => repo.url));
}

/**
 * Owns the draft-only Cursor Cloud composer state: cloud mode, Auto-PR, and the
 * account repo list used to decide whether this lane can launch there.
 *
 * The repo list is tri-state so a pending or failed probe cannot look like
 * "this repo is not connected" and a failed probe can be retried.
 */
export function useCursorCloudDraftState({
  cursorCloudAvailable,
  cursorAccountKey,
  laneId,
  laneGitRemote,
  laneGitBranch,
  laneGitRemoteStatus,
  laneGitRemoteError,
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

  const repoAccountKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cursorCloudAvailable) return;
    if (repoStateRef.current.status === "ready" && repoAccountKeyRef.current === cursorAccountKey) return;
    repoAccountKeyRef.current = cursorAccountKey;
    let cancelled = false;
    setRepoState({ status: "loading" });
    // A Retry (generation > 0) skips the cache; the first read may reuse it.
    void loadCursorCloudRepoUrls(repoFetchGeneration > 0)
      .then((urls) => {
        if (cancelled) return;
        setRepoState({ status: "ready", urls });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRepoState({ status: "error", message: cursorCloudErrorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [cursorAccountKey, cursorCloudAvailable, laneId, repoFetchGeneration]);

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

  /**
   * Every reason names the thing that is actually true right now. The lane
   * remote is read asynchronously and can fail, so "no GitHub remote" is only
   * said once the read finished and came back empty — a pending or failed read
   * gets its own sentence, and the failed one can be retried.
   */
  const cursorCloudUnavailableReason = useMemo(() => {
    if (!cursorCloudAvailable) return null;
    if (repoState.status === "loading") return "Checking Cursor Cloud…";
    if (repoState.status === "error") return repoState.message;
    // Unreachable while the pane gates `cursorCloudAvailable` on a lane, but the
    // hook must not blame a missing remote for a missing lane if that changes.
    if (!laneId) return "Choose a lane before sending to Cursor Cloud.";
    if (laneGitRemoteStatus === "idle" || laneGitRemoteStatus === "loading") {
      return "Checking this lane's git remote…";
    }
    if (laneGitRemoteStatus === "error") {
      const detail = laneGitRemoteError?.trim() || "The git remote read failed.";
      return `Could not read this lane's git remote: ${detail}`;
    }
    if (!laneGitRemote) {
      return "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.";
    }
    if (!cursorCloudRepoUrl) {
      return "This repo is not connected to Cursor. Connect it in Cursor, then try again.";
    }
    return null;
  }, [
    cursorCloudAvailable,
    cursorCloudRepoUrl,
    laneGitRemote,
    laneGitRemoteError,
    laneGitRemoteStatus,
    laneId,
    repoState,
  ]);

  // Cloud mode drops only on a definitive reason. A probe that is merely in
  // flight (the repo list, or the remote of a lane the user just switched to)
  // keeps the mode: the send control is disabled by the reason text meanwhile,
  // and turning the mode off would make the user re-pick Cursor Cloud after
  // every lane change.
  const cursorCloudProbesPending = repoState.status === "loading" || laneGitRemoteStatus === "loading";
  useEffect(() => {
    if (cursorCloudMode && cursorCloudUnavailableReason && !cursorCloudProbesPending) setCursorCloudMode(false);
  }, [cursorCloudMode, cursorCloudProbesPending, cursorCloudUnavailableReason]);

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
