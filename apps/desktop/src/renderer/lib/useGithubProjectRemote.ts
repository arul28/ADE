import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubRemoteStatus } from "../../shared/types";
import { arePathsEqual } from "./pathUtils";
import { useActiveRepositoryTab, useTabCopyPin } from "../state/repositoryScope";

export type UseGithubProjectRemoteResult = {
  loading: boolean;
  // True when a GitHub origin is configured (status.repo != null).
  hasGitHubRemote: boolean | null;
  // True when the project has ANY origin remote — including non-GitHub
  // (GitLab/Bitbucket). Used to hide the Publish CTA when an origin already
  // exists but we just can't parse it as GitHub; otherwise the publish flow
  // throws remote_already_exists from the server.
  hasOrigin: boolean | null;
  refresh: () => void;
};

// One answer, and the project it belongs to. A value is shown only while
// `root` is the project the caller asks about, so a switch never shows the
// previous project's answer, not even for one render.
type RemoteAnswer = {
  root: string;
  hasGitHubRemote: boolean | null;
  hasOrigin: boolean | null;
};

/**
 * True when `status` can describe `projectRoot`. The window answers for its
 * own project context, which is another project for a moment while it
 * switches. An answer without `projectRoot` (an older runtime) is kept, as
 * before.
 */
function describesProject(status: GitHubRemoteStatus, projectRoot: string): boolean {
  if (typeof status.projectRoot !== "string") return true;
  return arePathsEqual(status.projectRoot, projectRoot);
}

/**
 * Whether the tab's own folder has an origin (the Publish pill). The question
 * is about one folder, so it goes to the tab's copy (`useTabCopyPin`). An
 * account project names its GitHub repository, so it needs no call at all.
 * With no copy of its own the tab asks nothing and the answer stays unknown.
 */
export function useGithubProjectRemote(
  projectRoot: string | null,
): UseGithubProjectRemoteResult {
  const tab = useActiveRepositoryTab();
  const namedRepository = tab?.kind === "account" && tab.repoKeys.length > 0;
  const tabPin = useTabCopyPin();
  const tabPinRef = useRef(tabPin);
  tabPinRef.current = tabPin;
  const tabPinKey = tabPin?.key ?? null;
  const [answer, setAnswer] = useState<RemoteAnswer | null>(null);
  const [pendingRoot, setPendingRoot] = useState<string | null>(projectRoot);
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped by a GitHub status event: read again instead of trusting the
  // event, whose `repo`/`hasOrigin` describe whatever project sent it.
  const [statusTick, setStatusTick] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const readPin = tabPinRef.current;
    if (!projectRoot || namedRepository || !readPin) {
      setPendingRoot(null);
      return;
    }
    let cancelled = false;
    setPendingRoot(projectRoot);
    void window.ade.github
      .getRemoteStatus({ forceRefresh: refreshKey > 0 }, readPin)
      .then((status) => {
        if (cancelled) return;
        // An answer for another project is unknown here, not "no origin".
        if (!describesProject(status, projectRoot)) {
          setAnswer({ root: projectRoot, hasGitHubRemote: null, hasOrigin: null });
          return;
        }
        setAnswer({
          root: projectRoot,
          hasGitHubRemote: status.repo != null,
          hasOrigin: Boolean(status.hasOrigin),
        });
      })
      .catch(() => {
        if (cancelled) return;
        // On status failure we treat the remote as unknown (null) so the pill
        // doesn't flash for projects we couldn't probe.
        setAnswer({ root: projectRoot, hasGitHubRemote: null, hasOrigin: null });
      })
      .finally(() => {
        if (cancelled) return;
        setPendingRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [namedRepository, projectRoot, refreshKey, statusTick, tabPinKey]);

  // The status cache is shared across the renderer, so listen for global
  // changes (e.g. settings page updates the token) and read again. The preload
  // drops its cached status before it calls this listener.
  useEffect(() => {
    const eventPin = tabPinRef.current;
    if (!projectRoot || namedRepository || !eventPin) return;
    const unsubscribe = window.ade.github.onStatusChanged(() => {
      setStatusTick((value) => value + 1);
    }, eventPin);
    return unsubscribe;
  }, [namedRepository, projectRoot, tabPinKey]);

  if (projectRoot && namedRepository) {
    const onGitHub = tab?.kind === "account" && tab.repoKeys.some((key) => key.toLowerCase().startsWith("repo:github.com/"));
    return { loading: false, hasGitHubRemote: onGitHub, hasOrigin: true, refresh };
  }
  const current = projectRoot && answer?.root === projectRoot ? answer : null;
  return {
    loading: Boolean(projectRoot) && pendingRoot === projectRoot,
    hasGitHubRemote: current?.hasGitHubRemote ?? null,
    hasOrigin: current?.hasOrigin ?? null,
    refresh,
  };
}
