import { useCallback, useEffect, useState } from "react";

export type UseGithubProjectRemoteResult = {
  loading: boolean;
  hasRemote: boolean | null;
  refresh: () => void;
};

export function useGithubProjectRemote(
  projectRoot: string | null,
): UseGithubProjectRemoteResult {
  const [loading, setLoading] = useState<boolean>(Boolean(projectRoot));
  const [hasRemote, setHasRemote] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!projectRoot) {
      setLoading(false);
      setHasRemote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.ade.github
      .getStatus({ forceRefresh: refreshKey > 0 })
      .then((status) => {
        if (cancelled) return;
        setHasRemote(status.repo != null);
      })
      .catch(() => {
        if (cancelled) return;
        // On status failure we treat the remote as unknown (null) so the pill
        // doesn't flash for projects we couldn't probe.
        setHasRemote(null);
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
      setHasRemote(status.repo != null);
    });
    return unsubscribe;
  }, [projectRoot]);

  return { loading, hasRemote, refresh };
}
