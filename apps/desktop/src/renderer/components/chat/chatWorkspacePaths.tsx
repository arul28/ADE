import React, { createContext, useContext } from "react";
import { useLocation } from "react-router-dom";
import type { FilesWorkspace } from "../../../shared/types";
import { isPathEqualOrDescendant, isWindowsAbsolutePath, normalizePath } from "../../lib/pathUtils";

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

export function looksLikeWorkspacePath(value: string): boolean {
  const candidate = parseWorkspacePathLocation(value);
  if (!candidate) return false;
  if (candidate.path === ".." || candidate.path.startsWith("../") || candidate.path.startsWith("~/")) {
    return false;
  }
  if (candidate.path.startsWith("/")) {
    return candidate.path.slice(1).includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate.path);
  }
  return candidate.path.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate.path);
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
let cachedFilesWorkspaces: FilesWorkspace[] | null = null;
let inflightFilesWorkspaces: Promise<FilesWorkspace[]> | null = null;

export function resetFilesWorkspaceCacheForTests(): void {
  cachedFilesWorkspaces = null;
  inflightFilesWorkspaces = null;
}

async function loadFilesWorkspaces(force = false): Promise<FilesWorkspace[]> {
  if (!force && cachedFilesWorkspaces) return cachedFilesWorkspaces;
  const listWorkspaces = typeof window !== "undefined" ? window.ade?.files?.listWorkspaces : undefined;
  if (typeof listWorkspaces !== "function") return cachedFilesWorkspaces ?? [];
  // A forced read must not be answered by a request that started BEFORE the
  // caller discovered its miss — that response predates the lane it is looking
  // for, so the "re-read after a miss" recovery would never actually recover.
  if (force && inflightFilesWorkspaces) {
    await inflightFilesWorkspaces.catch(() => undefined);
  }
  if (!inflightFilesWorkspaces) {
    inflightFilesWorkspaces = listWorkspaces()
      .then((next) => {
        cachedFilesWorkspaces = next;
        return next;
      })
      .catch(() => cachedFilesWorkspaces ?? [])
      .finally(() => {
        inflightFilesWorkspaces = null;
      });
  }
  return inflightFilesWorkspaces;
}

export function useWorkspacePathOpener(args: {
  /**
   * The chat's lane. The router's `location.state.laneId` is folded in here
   * rather than at one call site, so the pane-level and list-level providers
   * cannot disagree about which lane a relative path belongs to.
   */
  laneId: string | null;
  navigate: (to: string, options: { state: Record<string, unknown> }) => void;
  onOpened?: (openFilePath: string, laneId: string | null) => void;
}): ChatWorkspacePathContextValue {
  const { laneId: laneIdArg, navigate, onOpened } = args;
  const routeState = useLocation().state as { laneId?: unknown } | null;
  const laneId = laneIdArg
    ?? (typeof routeState?.laneId === "string" ? routeState.laneId : null);
  const [workspaces, setWorkspaces] = React.useState<FilesWorkspace[]>(() => cachedFilesWorkspaces ?? []);

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
    void loadFilesWorkspaces().then((next) => setWorkspaces(next));
  }, []);

  const openWorkspacePath = React.useCallback(async (path: string | WorkspacePathLocation) => {
    let resolvedWorkspaces = workspaces;
    let target = resolveFilesNavigationTarget({ path, workspaces: resolvedWorkspaces, fallbackLaneId: laneId });
    const candidate = typeof path === "string" ? parseWorkspacePathLocation(path) : path;
    if (!target && candidate && (candidate.path.startsWith("/") || isWindowsAbsolutePath(candidate.path))) {
      // A lane created since the warm-up read: re-read once before giving up.
      resolvedWorkspaces = await loadFilesWorkspaces(true);
      setWorkspaces(resolvedWorkspaces);
      target = resolveFilesNavigationTarget({ path, workspaces: resolvedWorkspaces, fallbackLaneId: laneId });
    }
    if (!target) return;
    navigate("/files", {
      state: {
        openFilePath: target.openFilePath,
        ...(target.laneId ? { laneId: target.laneId } : {}),
        ...(typeof target.startLine === "number" ? { startLine: target.startLine } : {}),
        ...(typeof target.startColumn === "number" ? { startColumn: target.startColumn } : {}),
      },
    });
    onOpened?.(target.openFilePath, target.laneId);
  }, [laneId, navigate, onOpened, workspaces]);

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
