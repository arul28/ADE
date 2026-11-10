import { useEffect, useRef, useState } from "react";

import {
  decodeProjectRecordName,
  PROJECT_RECORD_ICON_KEY,
  PROJECT_RECORD_NAME_KEY,
} from "../../shared/projectRecord";

/**
 * The shared project record (`shared/projectRecord.ts`) for the project tabs:
 * the shared name of each repository, and a call when a repository's shared
 * icon changes on another machine, so the tab can ask for its icon again.
 *
 * The icons themselves are resolved where the files are (the desktop main
 * process for this computer, the host for another machine), and both apply
 * the record. This hook reads only the account settings store, through the
 * existing `accountSettings` bridge, once when the set of repositories
 * changes and again on each `accountSettings.onChanged` (the store pulled
 * rows another machine wrote). No timer, no poll.
 */
export function useProjectRecords(
  scopes: readonly string[],
  onIconChanged: (scope: string) => void,
): ReadonlyMap<string, string> {
  const scopesKey = [...new Set(scopes)].sort().join("\n");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const onIconChangedRef = useRef(onIconChanged);
  onIconChangedRef.current = onIconChanged;
  // The last icon value seen per repository, as JSON. Kept across scope
  // changes so a tab that closes and reopens does not count as a change.
  const lastIconRef = useRef(new Map<string, string>());

  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.ade?.accountSettings;
    if (!api?.get || !scopesKey) {
      setNames((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const list = scopesKey.split("\n");
    let cancelled = false;
    let generation = 0;
    const load = async (fromChange: boolean): Promise<void> => {
      const run = ++generation;
      const rows = await Promise.all(list.map(async (scope) => {
        const [icon, name] = await Promise.all([
          api.get({ scope, key: PROJECT_RECORD_ICON_KEY }),
          api.get({ scope, key: PROJECT_RECORD_NAME_KEY }),
        ]);
        return { scope, icon, name };
      }));
      if (cancelled || run !== generation) return;
      const next = new Map<string, string>();
      for (const { scope, icon, name } of rows) {
        const shared = name.ok ? decodeProjectRecordName(name.value) : null;
        if (shared) next.set(scope, shared);
        if (!icon.ok) continue;
        const seen = JSON.stringify(icon.value ?? null);
        const previous = lastIconRef.current.get(scope);
        lastIconRef.current.set(scope, seen);
        if (fromChange && previous !== undefined && previous !== seen) onIconChangedRef.current(scope);
      }
      setNames((current) => {
        if (current.size === next.size && [...next].every(([scope, value]) => current.get(scope) === value)) return current;
        return next;
      });
    };
    void load(false).catch(() => undefined);
    const stop = typeof api.onChanged === "function"
      ? api.onChanged(() => void load(true).catch(() => undefined))
      : null;
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [scopesKey]);

  return names;
}
