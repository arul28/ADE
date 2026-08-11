import { useEffect, useState } from "react";
import type { GitHubStatus } from "../../shared/types";

/**
 * Star/unstar for a Marketplace plugin's GitHub repository.
 *
 * The Marketplace detail page shows a star button for plugins whose registry
 * entry points at a GitHub repo. Three separate things can be missing, and each
 * one degrades differently, so all of the probing lives here rather than in the
 * component:
 *
 *  - The repository URL may not be a GitHub repo URL at all (a plugin can be
 *    hosted anywhere). `parseGithubRepoUrl` returns null and the button never
 *    renders.
 *  - The HOST may be older than this feature -- the web client adapter and a
 *    remote runtime running an older ADE both expose a `github` namespace
 *    without these members. `githubStarActionSupported()` answers that, and
 *    again the button must not render: an undefined member would throw on
 *    click, not fail gracefully.
 *  - GitHub may not be CONNECTED, or the read may simply fail (rate limit,
 *    private repo, network). `readRepoStarState` returns null and the caller
 *    renders nothing, because a star button that cannot tell you whether you
 *    have already starred something is worse than no button.
 *
 * Writes are the exception: `setRepoStarred` REJECTS on failure rather than
 * swallowing, so an optimistic UI can revert and say what went wrong.
 */

export type GithubRepoRef = { owner: string; name: string };

export type GithubRepoStarState = { starred: boolean; stars: number | null };

// GitHub's own rule for an owner login or a repository name. These strings come
// from a third-party registry entry and end up in a URL path, so anything
// outside this set is treated as "not a GitHub repo URL" rather than escaped.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** owner/name parsed out of a repository URL, or null when it is not a GitHub repo URL. */
export function parseGithubRepoUrl(
  url: string | null | undefined,
): GithubRepoRef | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // `https://user:token@github.com/owner/name` carries credentials we would
  // then hand to the main process and render as a link. A registry entry has no
  // business shipping one, so it disqualifies the URL outright.
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== "github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  const rawName = segments[1] ?? "";
  // Clone URLs (`.../owner/name.git`) and trailing slashes are both common in
  // registry entries; everything else has to match exactly.
  const name = /\.git$/i.test(rawName) ? rawName.slice(0, -4) : rawName;
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) return null;
  return { owner, name };
}

type GithubStarBridge = {
  getRepoStarState?: (args: GithubRepoRef) => Promise<GithubRepoStarState>;
  setRepoStarred?: (args: GithubRepoRef & { starred: boolean }) => Promise<void>;
};

// The typed `window.ade` surface always declares these members; the RUNNING
// host may not have them. Read through a loose view so the probe reflects
// reality instead of the type.
function starBridge(): GithubStarBridge | null {
  const ade = (globalThis as { window?: { ade?: { github?: unknown } } }).window?.ade;
  const github = ade?.github as GithubStarBridge | undefined;
  return github ?? null;
}

/** False when this host exposes no star members at all — the button must not render. */
export function githubStarActionSupported(): boolean {
  const github = starBridge();
  return typeof github?.getRepoStarState === "function"
    && typeof github?.setRepoStarred === "function";
}

export async function readRepoStarState(
  repo: GithubRepoRef,
): Promise<GithubRepoStarState | null> {
  const github = starBridge();
  if (typeof github?.getRepoStarState !== "function") return null;
  try {
    const state = await github.getRepoStarState({ owner: repo.owner, name: repo.name });
    return {
      starred: state?.starred === true,
      stars: typeof state?.stars === "number" && Number.isFinite(state.stars)
        ? state.stars
        : null,
    };
  } catch {
    // Not connected, rate limited, or the repo moved. All of them mean the same
    // thing to the caller: there is nothing trustworthy to show.
    return null;
  }
}

export async function setRepoStarred(
  repo: GithubRepoRef,
  starred: boolean,
): Promise<void> {
  const github = starBridge();
  if (typeof github?.setRepoStarred !== "function") {
    throw new Error("This ADE build cannot star GitHub repositories.");
  }
  await github.setRepoStarred({ owner: repo.owner, name: repo.name, starred });
}

/**
 * Whether GitHub is connected at all.
 *
 * There is no shared store selector for this: `AppShell` keeps `githubStatus`
 * in local state and passes it down as a prop, so a page that is not under that
 * prop chain has to ask for itself. This mirrors `useGithubProjectRemote` --
 * one read on mount, then the global `onStatusChanged` broadcast keeps it fresh
 * when Settings connects or clears a token. Returns null until the first read
 * lands, so callers can hold the button back rather than flash it.
 */
export function useGithubConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.github
      .getStatus()
      .then((status: GitHubStatus) => {
        if (cancelled) return;
        setConnected(Boolean(status?.connected));
      })
      .catch(() => {
        if (cancelled) return;
        // A status probe that fails is not a connection.
        setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.ade.github.onStatusChanged((status) => {
      setConnected(Boolean(status?.connected));
    });
  }, []);

  return connected;
}
