import { useEffect, useState } from "react";
import type { FileContent } from "../../../../shared/types";

/** Small LRU of the initial readFile payload, keyed by `${workspaceId}::${path}`. */
const cache = new Map<string, FileContent>();
const MAX_CACHE = 48;

function cacheKey(workspaceId: string, path: string): string {
  return `${workspaceId}::${path}`;
}

export function invalidateFileContent(workspaceId: string, path: string): void {
  cache.delete(cacheKey(workspaceId, path));
}

export function primeFileContent(workspaceId: string, path: string, content: FileContent): void {
  const key = cacheKey(workspaceId, path);
  cache.delete(key);
  cache.set(key, content);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * Sync the cached payload with text the editor just wrote to disk. Keeps
 * clean-model reads (markdown preview, CSV table, fallback saves) consistent
 * with the last save during the gap before the watcher echoes the write back;
 * the watcher-driven reload remains the authoritative refresh.
 */
export function updateCachedFileContentText(workspaceId: string, path: string, text: string): void {
  const key = cacheKey(workspaceId, path);
  const existing = cache.get(key);
  if (!existing || existing.isBinary || existing.encoding === "base64" || existing.isPartial) return;
  cache.delete(key);
  cache.set(key, { ...existing, content: text });
}

export type FileContentState =
  | { status: "loading" }
  | { status: "ready"; content: FileContent }
  | { status: "error"; error: string };

/**
 * Load (and cache) the initial `readFile` payload for a path. Viewers that need
 * more bytes stream them via `window.ade.files.readFileRange` themselves.
 */
export function useFileContent(workspaceId: string, path: string | null, reloadToken = 0): FileContentState {
  const [state, setState] = useState<FileContentState>({ status: "loading" });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const key = cacheKey(workspaceId, path);
    const cached = reloadToken === 0 ? cache.get(key) : undefined;
    if (cached) {
      setState({ status: "ready", content: cached });
      return;
    }
    setState({ status: "loading" });
    window.ade.files
      .readFile({ workspaceId, path })
      .then((content) => {
        if (cancelled) return;
        primeFileContent(workspaceId, path, content);
        setState({ status: "ready", content });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, reloadToken]);

  // Synchronous cache short-circuit: when the active path changes, the effect
  // hasn't updated `state` yet for the new path. If the content is already
  // cached (the common case — openFile primes it before opening the tab), return
  // it on this render so a persistent viewer never renders the previous file's
  // content for a frame. Uncached/forced-reload paths fall through to `state`.
  if (path && reloadToken === 0) {
    const cached = cache.get(cacheKey(workspaceId, path));
    if (cached) return { status: "ready", content: cached };
  }
  return state;
}
