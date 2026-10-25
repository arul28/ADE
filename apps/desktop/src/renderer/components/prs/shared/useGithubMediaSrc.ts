import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { OpenProjectBinding } from "../../../../shared/types";
import { githubAttachmentCanonicalUrl, githubRepoContext } from "../../../../shared/githubMedia";
import { useChatRuntimeScope } from "../../chat/ChatRuntimeScope";
import { usePrRuntimePin } from "../state/prMachines";

/**
 * A PR picture or video that a private repository serves only to a signed-in
 * reader.
 *
 * The original URL is shown first, so a public repository costs nothing extra.
 * Only after it fails to load, and only for a GitHub attachment URL in a known
 * repository, is the machine that owns the PR asked for a signed copy
 * (`prs.resolveMedia`, see githubMediaResolver.ts). A lazy picture only fails
 * once it is near the viewport, so offscreen media is never resolved.
 */

/** The PR's repository, set by `PrMarkdown` for everything it renders. */
export const PrMediaRepoContext = createContext<{ repoOwner: string; repoName: string } | null>(null);

export type GithubMediaPhase = "original" | "resolving" | "resolved" | "failed";

type Resolved = { src: string; kind: "image" | "video"; expiresAtMs: number };
type CacheEntry = { resolved: Resolved } | { unavailableUntilMs: number };

/** Hand out a signed copy only while it has this long left. */
const EXPIRY_MARGIN_MS = 30_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;
/** A copy that fails again re-resolves at most this often (a paused video past expiry). */
const RERESOLVE_MIN_INTERVAL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const fresh = "resolved" in entry
    ? entry.resolved.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()
    : entry.unavailableUntilMs > Date.now();
  if (!fresh) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function resolveShared(
  key: string,
  args: { url: string; repoOwner: string; repoName: string },
  pin: OpenProjectBinding | null,
  force: boolean,
): Promise<CacheEntry> {
  if (!force) {
    const cached = readCache(key);
    if (cached) return Promise.resolve(cached);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const resolveMedia = window.ade?.prs?.resolveMedia;
  const work = (typeof resolveMedia === "function" ? resolveMedia(args, pin) : Promise.reject(new Error("unsupported")))
    .then((result): CacheEntry => {
      if (result?.status === "resolved") {
        const expiresAtMs = Date.parse(result.expiresAt);
        return {
          resolved: {
            src: result.src,
            kind: result.contentType.toLowerCase().startsWith("video/") ? "video" : "image",
            expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 4 * 60_000,
          },
        };
      }
      return { unavailableUntilMs: Date.now() + UNAVAILABLE_TTL_MS };
    })
    // An older machine without the action, a dropped connection: the same
    // quiet fallback, and not asked again for a while.
    .catch((): CacheEntry => ({ unavailableUntilMs: Date.now() + UNAVAILABLE_TTL_MS }))
    .then((entry) => {
      writeCache(key, entry);
      return entry;
    })
    .finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    });
  inFlight.set(key, work);
  return work;
}

/**
 * The machine to ask: the PR subtree's pin (the lane owner), else the chat's,
 * else null for the tab's own machine.
 */
function usePrMediaPin(): OpenProjectBinding | null {
  const prPin = usePrRuntimePin();
  const chatPin = useChatRuntimeScope().pin;
  return prPin ?? chatPin ?? null;
}

export type GithubMediaSource = {
  /** What to render: the original URL, or the signed copy once resolved. */
  src: string;
  /** The resolved copy's kind; null before it is resolved. */
  kind: "image" | "video" | null;
  phase: GithubMediaPhase;
  /**
   * Call from the element's `onError`. True when a signed copy is on its way
   * (keep the layout and wait); false when the caller's own fallback applies.
   */
  reportError: () => boolean;
};

export function useGithubMediaSrc(url: string | undefined): GithubMediaSource {
  const repo = useContext(PrMediaRepoContext);
  const pin = usePrMediaPin();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  const target = useMemo(() => {
    const canonical = url ? githubAttachmentCanonicalUrl(url) : null;
    const context = repo ? githubRepoContext(repo.repoOwner, repo.repoName) : null;
    if (!url || !canonical || !context || !repo) return null;
    return {
      key: `${pinKey ?? "tab"}|${canonical.toLowerCase()}|${context.toLowerCase()}`,
      args: { url, repoOwner: repo.repoOwner, repoName: repo.repoName },
    };
  }, [url, repo, pinKey]);
  const targetKey = target?.key ?? null;

  const initial = useCallback((): { phase: GithubMediaPhase; resolved: Resolved | null } => {
    const cached = targetKey ? readCache(targetKey) : null;
    if (cached && "resolved" in cached) return { phase: "resolved", resolved: cached.resolved };
    return { phase: "original", resolved: null };
  }, [targetKey]);

  const [state, setState] = useState(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolvedAtRef = useRef(state.resolved ? Date.now() : 0);
  const currentKeyRef = useRef(targetKey);

  // A new URL, repository or machine starts over (react-markdown reuses
  // element instances positionally).
  useEffect(() => {
    if (currentKeyRef.current === targetKey) return;
    currentKeyRef.current = targetKey;
    const next = initial();
    stateRef.current = next;
    setState(next);
    resolvedAtRef.current = next.resolved ? Date.now() : 0;
  }, [targetKey, initial]);

  const start = useCallback((force: boolean) => {
    if (!target) return;
    const key = target.key;
    const resolving = { phase: "resolving" as const, resolved: stateRef.current.resolved };
    stateRef.current = resolving;
    setState(resolving);
    void resolveShared(key, target.args, pinRef.current, force).then((entry) => {
      if (currentKeyRef.current !== key) return;
      const next = "resolved" in entry
        ? { phase: "resolved" as const, resolved: entry.resolved }
        : { phase: "failed" as const, resolved: null };
      if (next.resolved) resolvedAtRef.current = Date.now();
      stateRef.current = next;
      setState(next);
    });
  }, [target]);

  const reportError = useCallback((): boolean => {
    if (!target) return false;
    const { phase } = stateRef.current;
    if (phase === "resolving") return true;
    if (phase === "original") {
      start(false);
      return true;
    }
    if (phase === "resolved" && Date.now() - resolvedAtRef.current >= RERESOLVE_MIN_INTERVAL_MS) {
      // The signed copy expired (a video paused past its five minutes).
      start(true);
      return true;
    }
    const failed = { phase: "failed" as const, resolved: null };
    stateRef.current = failed;
    setState(failed);
    return false;
  }, [target, start]);

  return {
    src: state.phase === "resolved" && state.resolved ? state.resolved.src : (url ?? ""),
    kind: state.phase === "resolved" && state.resolved ? state.resolved.kind : null,
    phase: target ? state.phase : "original",
    reportError,
  };
}
