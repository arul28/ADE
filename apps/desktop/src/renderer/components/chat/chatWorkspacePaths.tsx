import React, { createContext, useContext } from "react";
import { useLocation } from "react-router-dom";
import type { FilesWorkspace } from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { isPathEqualOrDescendant, isWindowsAbsolutePath, normalizePath } from "../../lib/pathUtils";
import { showToast } from "../app/toast/toastStore";
import { nextFilesOpenNonce, requestFilesOpenInTools } from "../files/v2/filesOpenRequests";

/**
 * Recognising the file paths an agent writes into chat, and turning them into
 * something that opens in the Files tab.
 *
 * These used to live inside `AgentChatMessageList`, which is the only surface
 * that had them wired. Everything else that renders agent markdown — the
 * proposed-plan card, the Codex plan card, question-option previews — went
 * through the shared `ChatMarkdown`, which sent every href to the browser
 * opener. That is not merely a dead click: `normalizeBrowserUrlInput` turns a
 * bare `laneService.ts` into `https://laneService.ts`, so clicking a filename
 * navigated ADE's built-in browser to a garbage host.
 */

export type WorkspacePathLocation = {
  path: string;
  startLine?: number;
  startColumn?: number;
};

export function isExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (/^file:/i.test(trimmed)) return false;
  if (isWindowsAbsolutePath(trimmed)) return false;
  return /^(?:[a-z]+:)?\/\//i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed);
}

export function readWorkspacePathFragmentPosition(
  fragment: string,
): Pick<WorkspacePathLocation, "startLine" | "startColumn"> {
  const trimmed = fragment.trim();
  if (!trimmed.length) return {};

  const lineMatch = trimmed.match(/^L(\d+)(?:C(\d+))?(?:-L?\d+)?$/i);
  if (lineMatch) {
    const [, startLineRaw, startColumnRaw] = lineMatch;
    return {
      startLine: Number(startLineRaw),
      startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
    };
  }

  const explicitMatch = trimmed.match(/^line=(\d+)(?:,(\d+))?$/i);
  if (!explicitMatch) return {};
  const [, startLineRaw, startColumnRaw] = explicitMatch;
  return {
    startLine: Number(startLineRaw),
    startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
  };
}

export function splitWorkspacePathLineSuffix(path: string): WorkspacePathLocation {
  const match = path.match(/^(.*?)(?::(\d+))(?::(\d+))?$/);
  if (!match) return { path };
  const [, candidatePath, startLineRaw, startColumnRaw] = match;
  if (!candidatePath.length) return { path };
  return {
    path: candidatePath,
    startLine: Number(startLineRaw),
    startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
  };
}

export function parseWorkspacePathLocation(value: string): WorkspacePathLocation | null {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^(?:https?|mailto|tel):/i.test(trimmed)) return null;
  if (/^#/.test(trimmed)) return null;

  let rawPath: string;
  let rawFragment = "";
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      rawPath = `${url.host ? `//${url.host}` : ""}${url.pathname}`.trim();
      rawFragment = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    } catch {
      const withoutScheme = trimmed.replace(/^file:\/\//i, "");
      const [withoutFragment, fallbackFragment = ""] = withoutScheme.split("#", 2);
      rawPath = withoutFragment.split("?", 1)[0]?.trim() ?? "";
      rawFragment = fallbackFragment;
    }
  } else {
    const [withoutFragment, fallbackFragment = ""] = trimmed.split("#", 2);
    rawPath = withoutFragment.split("?", 1)[0]?.trim() ?? "";
    rawFragment = fallbackFragment;
  }
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // Keep the raw path when markdown produced a partially-encoded href.
  }

  const slashNormalized = decodedPath.replace(/\\/g, "/");
  if (!slashNormalized.length) return null;

  const normalizedDrivePath = /^\/[A-Za-z]:\//.test(slashNormalized) ? slashNormalized.slice(1) : slashNormalized;
  const fromSuffix = splitWorkspacePathLineSuffix(normalizedDrivePath);
  const fromFragment = readWorkspacePathFragmentPosition(rawFragment);
  const normalizedPath = normalizePath(fromSuffix.path);
  if (!normalizedPath.length) return null;

  return {
    path: normalizedPath,
    startLine: fromFragment.startLine ?? fromSuffix.startLine,
    startColumn: fromFragment.startColumn ?? fromSuffix.startColumn,
  };
}

/**
 * Extensions that make a SINGLE-SEGMENT token look like a file but almost never
 * are one in agent prose. Without this, "the fix shipped in v1.2.60" and "see
 * example.com" both render as clickable file links — the trailing-dot-then-
 * alphanumerics test cannot tell them from `preload.ts`. A path with a
 * separator in it is exempt: `docs/example.com` really is a file.
 *
 * Version-like tokens are matched separately because their "extension" is
 * digits, which no real source file uses.
 */
const NON_FILE_SINGLE_SEGMENT_SUFFIXES = new Set([
  // NOT "sh": `install.sh` / `build.sh` are real files and far more likely in
  // agent prose than a Saint Helena domain.
  "com", "org", "net", "io", "ai", "dev", "gov", "edu",
]);

function singleSegmentLooksLikeProse(path: string): boolean {
  const suffix = path.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (!suffix) return true;
  if (/^\d+$/.test(suffix)) return true;
  return NON_FILE_SINGLE_SEGMENT_SUFFIXES.has(suffix.toLowerCase());
}

export function looksLikeWorkspacePath(value: string): boolean {
  const candidate = parseWorkspacePathLocation(value);
  if (!candidate) return false;
  if (candidate.path === ".." || candidate.path.startsWith("../") || candidate.path.startsWith("~/")) {
    return false;
  }
  const withoutLeadingSlash = candidate.path.startsWith("/") ? candidate.path.slice(1) : candidate.path;
  if (withoutLeadingSlash.includes("/")) return true;
  // Bare token: it still has to end in something file-shaped, and it must not
  // be a version number or a domain.
  if (!/\.[A-Za-z0-9]{1,8}$/.test(withoutLeadingSlash)) return false;
  return !singleSegmentLooksLikeProse(withoutLeadingSlash);
}

export function resolveWorkspacePathFromHref(href: string | undefined): WorkspacePathLocation | null {
  if (!href) return null;
  if (isExternalHref(href)) return null;
  const candidate = parseWorkspacePathLocation(href);
  if (!candidate) return null;
  return looksLikeWorkspacePath(href) ? candidate : null;
}

/**
 * Maps a path an agent reported onto a Files-tab target: which workspace owns
 * it, and the path relative to that workspace root.
 *
 * Absolute paths are matched against every known workspace root, preferring the
 * chat's own lane and then the longest matching root (nested worktrees). All
 * comparisons run through `pathUtils`, so Windows drive letters, UNC roots, and
 * case-insensitive volumes behave. Relative paths are taken as already
 * workspace-relative and attributed to the chat's lane.
 */
export function resolveFilesNavigationTarget(args: {
  path: string | WorkspacePathLocation;
  /** Only the root and its lane are read — keeps test fixtures honest. */
  workspaces: readonly Pick<FilesWorkspace, "rootPath" | "laneId">[];
  fallbackLaneId: string | null;
}): { openFilePath: string; laneId: string | null; startLine?: number; startColumn?: number } | null {
  const candidate = typeof args.path === "string" ? parseWorkspacePathLocation(args.path) : args.path;
  if (!candidate) return null;

  const normalizedCandidate = normalizePath(candidate.path);
  if (normalizedCandidate.startsWith("/") || isWindowsAbsolutePath(normalizedCandidate)) {
    const matches = args.workspaces
      .map((workspace) => ({
        workspace,
        rootPath: normalizePath(workspace.rootPath),
      }))
      .filter(({ rootPath }) => isPathEqualOrDescendant(normalizedCandidate, rootPath))
      .sort((left, right) => {
        const rightMatchesLane = right.workspace.laneId != null && right.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        const leftMatchesLane = left.workspace.laneId != null && left.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        if (rightMatchesLane !== leftMatchesLane) return rightMatchesLane - leftMatchesLane;
        return right.rootPath.length - left.rootPath.length;
      });

    const match = matches[0];
    if (!match) return null;
    const openFilePath = normalizedCandidate.slice(match.rootPath.length).replace(/^\/+/, "");
    if (!openFilePath.length) return null;
    return {
      openFilePath,
      laneId: match.workspace.laneId ?? args.fallbackLaneId ?? null,
      startLine: candidate.startLine,
      startColumn: candidate.startColumn,
    };
  }

  const openFilePath = normalizedCandidate.replace(/^\.\//, "");
  if (!openFilePath.length) return null;
  return {
    openFilePath,
    laneId: args.fallbackLaneId ?? null,
    startLine: candidate.startLine,
    startColumn: candidate.startColumn,
  };
}

/**
 * Opens a chat-emitted path in the Files tab, scoped to the chat's own lane.
 *
 * Provided once per chat surface so any markdown rendered underneath — replies,
 * plan cards, question previews — resolves paths the same way. `null` means no
 * chat surface is hosting this markdown (Settings previews, PR bodies); callers
 * must then render the path as inert text rather than guessing a URL.
 */
export type ChatWorkspacePathOpener = (path: string | WorkspacePathLocation) => void;

export type ChatWorkspacePathContextValue = {
  openWorkspacePath: ChatWorkspacePathOpener;
  /** Absolute worktree path → lane-relative, for display. */
  formatWorkspaceDisplayPath: (path: string) => string;
  /** Warm the workspace roots so display formatting can resolve. */
  ensureWorkspacesLoaded: () => void;
};

/**
 * Builds the opener: resolve the path against the known workspaces, then route
 * to the Files tab with the lane and `:line` carried in navigation state.
 *
 * Workspaces load lazily — the list starts empty and is only fetched when an
 * ABSOLUTE path fails to resolve, since relative paths never need it. An
 * unresolvable path is a no-op by design: a path the agent invented, or one
 * outside every workspace, should do nothing rather than navigate somewhere
 * arbitrary.
 */
/**
 * Workspace roots are app-global and change only when lanes do, so they are
 * cached per module: several chat surfaces mount an opener at once (the pane
 * and the message list each provide one) and they should not each pay an IPC
 * round trip.
 *
 * Loading stays LAZY — chat surfaces deliberately do not fetch on mount, or
 * every open chat would pay for roots it may never need. The cache is warmed
 * either by the first path click or by `ensureWorkspacesLoaded`, which callers
 * that need lane-relative *display* call at the moment they render paths.
 * `force` re-reads after a resolve miss, which is how a lane created since the
 * warm-up is picked up.
 */
/**
 * Keyed by machine, not global. A chat on another machine lists THAT machine's
 * workspaces; folding them into one cache would let a foreign lane id resolve
 * against the local roster (or the reverse) and open the wrong worktree.
 */
const BOUND_MACHINE_CACHE_KEY = "bound";

function machineCacheKey(pin: OpenProjectBinding | null | undefined): string {
  return pin?.key ?? BOUND_MACHINE_CACHE_KEY;
}

const cachedFilesWorkspaces = new Map<string, FilesWorkspace[]>();
const inflightFilesWorkspaces = new Map<string, Promise<FilesWorkspace[]>>();

export function resetFilesWorkspaceCacheForTests(): void {
  cachedFilesWorkspaces.clear();
  inflightFilesWorkspaces.clear();
}

async function loadFilesWorkspaces(
  pin: OpenProjectBinding | null | undefined,
  force = false,
): Promise<FilesWorkspace[]> {
  const key = machineCacheKey(pin);
  const cached = cachedFilesWorkspaces.get(key) ?? null;
  if (!force && cached) return cached;
  const listWorkspaces = typeof window !== "undefined" ? window.ade?.files?.listWorkspaces : undefined;
  if (typeof listWorkspaces !== "function") return cached ?? [];
  // A forced read must not be answered by a request that started BEFORE the
  // caller discovered its miss — that response predates the lane it is looking
  // for, so the "re-read after a miss" recovery would never actually recover.
  const inflight = inflightFilesWorkspaces.get(key);
  if (force && inflight) {
    await inflight.catch(() => undefined);
  }
  let pending = inflightFilesWorkspaces.get(key);
  if (!pending) {
    pending = listWorkspaces({}, pin)
      .then((next) => {
        cachedFilesWorkspaces.set(key, next);
        return next;
      })
      .catch(() => cachedFilesWorkspaces.get(key) ?? [])
      .finally(() => {
        inflightFilesWorkspaces.delete(key);
      });
    inflightFilesWorkspaces.set(key, pending);
  }
  return pending;
}

/** How many index hits to inspect when probing what a clicked path actually is. */
const PATH_PROBE_LIMIT = 60;

export type WorkspacePathProbe =
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "ambiguous"; query: string }
  | { kind: "missing" };

/**
 * Asks the workspace's file-name index what a clicked token actually is.
 *
 * This is the fix for the two silent failures users hit most. An agent writes a
 * BARE filename far more often than a full path ("see FilesWorkbench.tsx"), and
 * the old code assumed any path without a separator sat at the workspace root —
 * so it opened `<lane>/FilesWorkbench.tsx`, which does not exist, and failed
 * with a thin error strip. It also assumed every clickable token was a file, so
 * a folder name was opened as one and errored the same way.
 */
export async function probeWorkspacePath(args: {
  workspaceId: string;
  path: string;
  pin: OpenProjectBinding | null | undefined;
}): Promise<WorkspacePathProbe> {
  const quickOpen = typeof window !== "undefined" ? window.ade?.files?.quickOpen : undefined;
  if (typeof quickOpen !== "function") return { kind: "file", path: args.path };

  const normalized = normalizePath(args.path).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized.length) return { kind: "missing" };
  const hasSeparator = normalized.includes("/");
  // A bare name is searched by name; a full path is searched by itself so an
  // exact hit ranks at all in a repo with many same-named files.
  const query = normalized;

  let items: { path: string }[] = [];
  try {
    items = await quickOpen({
      workspaceId: args.workspaceId,
      query,
      limit: PATH_PROBE_LIMIT,
      includeIgnored: false,
    }, args.pin);
  } catch {
    // A failed probe must not swallow the click: fall back to the old
    // assumption and let the workbench report whatever it hits.
    return { kind: "file", path: normalized };
  }

  const lowered = normalized.toLowerCase();
  const exact = items.find((item) => normalizePath(item.path).toLowerCase() === lowered);
  if (exact) return { kind: "file", path: normalizePath(exact.path) };

  const directoryPrefix = `${lowered}/`;
  if (items.some((item) => normalizePath(item.path).toLowerCase().startsWith(directoryPrefix))) {
    return { kind: "directory", path: normalized };
  }

  if (hasSeparator) return { kind: "missing" };

  // Bare name: match on the basename, since the index returns full paths.
  const matches = items.filter((item) => {
    const segments = normalizePath(item.path).toLowerCase().split("/");
    return segments[segments.length - 1] === lowered;
  });
  if (matches.length === 1) return { kind: "file", path: normalizePath(matches[0]!.path) };
  if (matches.length > 1) return { kind: "ambiguous", query: normalized };
  return { kind: "missing" };
}

export function useWorkspacePathOpener(args: {
  /**
   * The chat's lane. The router's `location.state.laneId` is folded in here
   * rather than at one call site, so the pane-level and list-level providers
   * cannot disagree about which lane a relative path belongs to.
   */
  laneId: string | null;
  navigate: (to: string, options: { state: Record<string, unknown> }) => void;
  /**
   * Machine that owns this chat, from the same router the chat's own calls use.
   * Null means the machine this project tab is already bound to. A chat on
   * another machine reports paths on THAT machine's disk, so every lookup below
   * has to be asked of it — otherwise the click resolves against the wrong
   * filesystem and quietly finds nothing.
   */
  runtimePin?: OpenProjectBinding | null;
  onOpened?: (openFilePath: string, laneId: string | null) => void;
}): ChatWorkspacePathContextValue {
  const { laneId: laneIdArg, navigate, onOpened, runtimePin = null } = args;
  const location = useLocation();
  const routeState = location.state as { laneId?: unknown } | null;
  const laneId = laneIdArg
    ?? (typeof routeState?.laneId === "string" ? routeState.laneId : null);
  // The tools-pane Files panel only exists inside the Work tab. Anywhere else
  // (a chat rendered under /prs, personal chats) the full Files tab is the only
  // destination that can actually show the file.
  const inWorkSurface = location.pathname.startsWith("/work");
  const [workspaces, setWorkspaces] = React.useState<FilesWorkspace[]>(
    () => cachedFilesWorkspaces.get(machineCacheKey(runtimePin)) ?? [],
  );

  /**
   * Load the roots on demand. Chat surfaces deliberately do NOT fetch on mount —
   * every open chat would pay an IPC round trip — so resolution stays lazy and
   * callers that need lane-relative *display* (rather than navigation) ask for
   * it at the moment they render paths, e.g. when a files-changed summary is
   * expanded.
   */
  const ensureWorkspacesLoaded = React.useCallback(() => {
    // No early return on the module cache: this instance's state is what
    // `formatWorkspaceDisplayPath` reads, and an instance that mounted before
    // the cache was warmed would otherwise stay empty for its whole lifetime
    // and keep rendering raw absolute paths. `loadFilesWorkspaces` already
    // short-circuits on a warm cache, so this costs a microtask.
    void loadFilesWorkspaces(runtimePin).then((next) => setWorkspaces(next));
  }, [runtimePin]);

  const openWorkspacePath = React.useCallback(async (path: string | WorkspacePathLocation) => {
    // NAVIGATION always resolves against a fresh read, never the cache.
    // `listWorkspaces` is project-scoped, and nothing invalidates the module
    // cache on a project switch — so a stale root that still *matches* (local
    // and remote copies at the same path, nested roots, a recreated lane)
    // resolves successfully with the previous project's lane id and opens the
    // wrong workspace. Because it resolves, the force-on-miss path below never
    // runs and the error is silent. One IPC on an explicit click is the right
    // price for that; DISPLAY formatting keeps using the cache, where a stale
    // root only costs a longer-looking path.
    const resolvedWorkspaces = await loadFilesWorkspaces(runtimePin, true);
    setWorkspaces(resolvedWorkspaces);
    const target = resolveFilesNavigationTarget({
      path,
      workspaces: resolvedWorkspaces,
      fallbackLaneId: laneId,
    });
    if (!target) {
      // An absolute path under no known root. Before this, the click was a
      // deliberate no-op and the user got no feedback at all — which read as
      // "the link is broken" rather than "that file is somewhere I can't see".
      showToast({
        title: "Can't open that file",
        message: `${typeof path === "string" ? path : path.path} isn't inside this project.`,
        tone: "error",
      });
      return;
    }

    const workspace = target.laneId
      ? resolvedWorkspaces.find((candidate) => candidate.laneId === target.laneId) ?? null
      : null;
    const probe = workspace
      ? await probeWorkspacePath({ workspaceId: workspace.id, path: target.openFilePath, pin: runtimePin })
      : ({ kind: "file", path: target.openFilePath } as const);

    if (probe.kind === "missing") {
      // A miss is only authoritative for a BARE name, where the index is the
      // only thing that can turn it into a path. For a path that already has a
      // directory in it, the index is a hint and a stale one: it is built once
      // per workspace and only refreshed from watcher events, and no watcher
      // runs unless the Files or Git tools panel is open. It also excludes
      // gitignored files and `dist`/`node_modules`/`coverage` outright, and
      // stops at 25,000 files. So the file an agent just created — the single
      // most common thing to click — would be reported as missing forever.
      // Open it and let a real read error speak for itself, which is what
      // clicking a path did before the probe existed.
      if (!target.openFilePath.includes("/")) {
        showToast({
          title: "Can't find that file",
          message: `Nothing named ${target.openFilePath} in ${workspace?.name ?? "this project"}.`,
          tone: "error",
        });
        return;
      }
    }

    // Key order matches what the Files route has always received; only the two
    // new optional keys are appended.
    const laneState = target.laneId ? { laneId: target.laneId } : {};
    const pinState = runtimePin ? { filesPin: runtimePin } : {};

    if (probe.kind === "ambiguous") {
      // Several files share that name. Guessing one would open the wrong file
      // silently; the search panel lets the user pick in one more click.
      navigate("/files", { state: { ...laneState, ...pinState, searchQuery: probe.query } });
      return;
    }

    // A fallen-through miss keeps the path the agent reported.
    const resolvedPath = probe.kind === "missing" ? target.openFilePath : probe.path;
    const openLine = probe.kind === "directory" ? undefined : target.startLine;
    const openColumn = probe.kind === "directory" ? undefined : target.startColumn;

    // A file on the machine this tab is already bound to, in the lane this chat
    // belongs to, opens next to the conversation. Anything else — another lane,
    // another machine — needs the full Files tab, which owns the workspace
    // picker and the machine chrome the tools pane deliberately hides.
    const belongsToThisChatsLane = target.laneId != null && target.laneId === laneId;
    if (!runtimePin && belongsToThisChatsLane && inWorkSurface) {
      requestFilesOpenInTools({
        path: resolvedPath,
        laneId: target.laneId,
        pin: null,
        pathType: probe.kind === "directory" ? "directory" : "file",
        line: openLine,
        column: openColumn,
        nonce: nextFilesOpenNonce(),
      });
      onOpened?.(resolvedPath, target.laneId);
      return;
    }

    navigate("/files", {
      state: {
        openFilePath: resolvedPath,
        ...laneState,
        ...(typeof openLine === "number" ? { startLine: openLine } : {}),
        ...(typeof openColumn === "number" ? { startColumn: openColumn } : {}),
        ...(probe.kind === "directory" ? { openPathType: "directory" } : {}),
        ...pinState,
      },
    });
    onOpened?.(resolvedPath, target.laneId);
  }, [inWorkSurface, laneId, navigate, onOpened, runtimePin]);

  const formatWorkspaceDisplayPath = React.useCallback((path: string): string => (
    resolveFilesNavigationTarget({ path, workspaces, fallbackLaneId: laneId })?.openFilePath ?? path
  ), [workspaces, laneId]);

  return React.useMemo(
    () => ({ openWorkspacePath, formatWorkspaceDisplayPath, ensureWorkspacesLoaded }),
    [openWorkspacePath, formatWorkspaceDisplayPath, ensureWorkspacesLoaded],
  );
}

const ChatWorkspacePathContext = createContext<ChatWorkspacePathContextValue | null>(null);

export function ChatWorkspacePathProvider({
  value,
  children,
}: {
  value: ChatWorkspacePathContextValue | null;
  children: React.ReactNode;
}) {
  return (
    <ChatWorkspacePathContext.Provider value={value}>
      {children}
    </ChatWorkspacePathContext.Provider>
  );
}

export function useChatWorkspacePaths(): ChatWorkspacePathContextValue | null {
  return useContext(ChatWorkspacePathContext);
}

export function useChatWorkspacePathOpener(): ChatWorkspacePathOpener | null {
  return useContext(ChatWorkspacePathContext)?.openWorkspacePath ?? null;
}
