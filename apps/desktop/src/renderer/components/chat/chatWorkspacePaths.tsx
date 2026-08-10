import React, { createContext, useContext } from "react";
import { defaultUrlTransform } from "react-markdown";
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

export function chatMarkdownUrlTransform(value: string): string {
  if (/^file:/i.test(value) || isWindowsAbsolutePath(value)) {
    return value;
  }
  return defaultUrlTransform(value);
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
  workspaces: FilesWorkspace[];
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
export function useWorkspacePathOpener(args: {
  laneId: string | null;
  navigate: (to: string, options: { state: Record<string, unknown> }) => void;
  onOpened?: (openFilePath: string, laneId: string | null) => void;
}): { openWorkspacePath: ChatWorkspacePathOpener; formatWorkspaceDisplayPath: (path: string) => string } {
  const { laneId, navigate, onOpened } = args;
  const [workspaces, setWorkspaces] = React.useState<FilesWorkspace[]>([]);

  const openWorkspacePath = React.useCallback(async (path: string | WorkspacePathLocation) => {
    let resolvedWorkspaces = workspaces;
    let target = resolveFilesNavigationTarget({ path, workspaces: resolvedWorkspaces, fallbackLaneId: laneId });
    const candidate = typeof path === "string" ? parseWorkspacePathLocation(path) : path;
    if (!target && candidate && (candidate.path.startsWith("/") || isWindowsAbsolutePath(candidate.path))) {
      const listWorkspaces = window.ade?.files?.listWorkspaces;
      if (typeof listWorkspaces === "function") {
        try {
          resolvedWorkspaces = await listWorkspaces();
          setWorkspaces(resolvedWorkspaces);
          target = resolveFilesNavigationTarget({ path, workspaces: resolvedWorkspaces, fallbackLaneId: laneId });
        } catch {
          target = null;
        }
      }
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

  return { openWorkspacePath, formatWorkspaceDisplayPath };
}

const ChatWorkspacePathContext = createContext<ChatWorkspacePathOpener | null>(null);

export function ChatWorkspacePathProvider({
  onOpenWorkspacePath,
  children,
}: {
  onOpenWorkspacePath: ChatWorkspacePathOpener | null;
  children: React.ReactNode;
}) {
  return (
    <ChatWorkspacePathContext.Provider value={onOpenWorkspacePath}>
      {children}
    </ChatWorkspacePathContext.Provider>
  );
}

export function useChatWorkspacePathOpener(): ChatWorkspacePathOpener | null {
  return useContext(ChatWorkspacePathContext);
}
