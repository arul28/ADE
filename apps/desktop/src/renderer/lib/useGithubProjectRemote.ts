import { useCallback, useEffect, useState } from "react";

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

export function useGithubProjectRemote(
  projectRoot: string | null,
): UseGithubProjectRemoteResult {
  const [loading, setLoading] = useState<boolean>(Boolean(projectRoot));
  const [hasGitHubRemote, setHasGitHubRemote] = useState<boolean | null>(null);
  const [hasOrigin, setHasOrigin] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!projectRoot) {
      setLoading(false);
      setHasGitHubRemote(null);
      setHasOrigin(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.ade.github
      .getRemoteStatus({ forceRefresh: refreshKey > 0 })
      .then((status) => {
        if (cancelled) return;
        setHasGitHubRemote(status.repo != null);
        setHasOrigin(Boolean(status.hasOrigin));
      })
      .catch(() => {
        if (cancelled) return;
        // On status failure we treat the remote as unknown (null) so the pill
        // doesn't flash for projects we couldn't probe.
        setHasGitHubRemote(null);
        setHasOrigin(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, refreshKey]);

  // The status cache is shared across the renderer, so listen for global
  // changes (e.g. settings page updates the token) and refresh accordingly.
  useEffect(() => {
    if (!projectRoot) return;
    const unsubscribe = window.ade.github.onStatusChanged((status) => {
      setHasGitHubRemote(status.repo != null);
      setHasOrigin(Boolean(status.hasOrigin));
    });
    return unsubscribe;
  }, [projectRoot]);

  return { loading, hasGitHubRemote, hasOrigin, refresh };
}
