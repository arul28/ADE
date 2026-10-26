import React from "react";
import type { GitHubPrFilterKind, GitHubPrFilterOption } from "../../../../shared/types";

/** Wait this long after the last keystroke before asking GitHub. */
export const GITHUB_FILTER_OPTIONS_DEBOUNCE_MS = 250;

export type GitHubFilterOptionsLoader = (kind: GitHubPrFilterKind, query: string) => Promise<GitHubPrFilterOption[]>;

/**
 * GitHub's matches for a picker, asked only while the picker is open, after a
 * pause in typing, with stale answers dropped. A missing loader (an older host)
 * or a failure just leaves the loaded-row facets.
 */
export function useGitHubFilterOptions({
  enabled,
  kind,
  query,
  load,
}: {
  enabled: boolean;
  kind: GitHubPrFilterKind;
  query: string;
  load: GitHubFilterOptionsLoader | null;
}): { options: GitHubPrFilterOption[]; loading: boolean; failed: boolean } {
  const [state, setState] = React.useState<{ key: string; options: GitHubPrFilterOption[]; failed: boolean } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const seqRef = React.useRef(0);
  const hasLoader = Boolean(load);
  const trimmed = query.trim();
  const key = `${kind}|${trimmed.toLowerCase()}`;
  React.useEffect(() => {
    if (!enabled || !hasLoader) {
      setLoading(false);
      return undefined;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const loader = loadRef.current;
      if (!loader) return;
      loader(kind, trimmed)
        .then((options) => {
          if (seq === seqRef.current) setState({ key, options, failed: false });
        })
        .catch(() => {
          if (seq === seqRef.current) setState({ key, options: [], failed: true });
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, GITHUB_FILTER_OPTIONS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, hasLoader, key, kind, trimmed]);
  return {
    options: state?.key === key ? state.options : [],
    loading,
    failed: state?.key === key ? state.failed : false,
  };
}
