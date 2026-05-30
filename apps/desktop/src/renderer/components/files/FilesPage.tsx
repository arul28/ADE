import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Warning as AlertTriangle,
  ArrowSquareOut,
  Eye,
  FileTs as FileCode2,
  FileText,
  FolderOpen,
  FloppyDisk as Save,
  MagnifyingGlass as Search,
  Moon,
  Sparkle as Sparkles,
  Sun,
  X,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  FileChangeEvent,
  FileContent,
  FilePreviewKind,
  FileTreeChangeStatus,
  FileTreeNode,
  FilesGitStatusEvent,
  FilesQuickOpenItem,
  FilesSearchTextMatch,
  FilesWorkspace,
  FileDiff,
  FilePatch,
  GitCommitSummary,
  LaneSummary,
} from "../../../shared/types";
import { AdeDiffViewer, type AdeDiffViewerHandle } from "../shared/AdeDiffViewer";
import { useAppStore } from "../../state/appStore";
import { clearDirtyBuffersForWorkspace, replaceDirtyBuffersForWorkspace } from "../../lib/dirtyWorkspaceBuffers";
import { modifierKeyLabel, revealLabel } from "../../lib/platform";
import { arePathsEqual, normalizePath, normalizePathForWorkspaceComparison, isPathEqualOrDescendant, remapPathForRename } from "../../lib/pathUtils";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, inlineBadge, outlineButton, primaryButton, dangerButton, cardStyle } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";
import { HelpChip } from "../onboarding/HelpChip";
import { SmartTooltip } from "../ui/SmartTooltip";
import { FilesExplorer } from "./FilesExplorer";
import { getFileIcon } from "./filePresentation";
import { createMonacoModelRegistry } from "./monacoModelRegistry";

const LazyPlanMarkdown = React.lazy(() =>
  import("../orchestration/PlanMarkdown").then((module) => ({
    default: module.PlanMarkdown,
  })),
);

type OpenTab = {
  path: string;
  content: string;
  savedContent: string;
  languageId: string;
  isBinary: boolean;
  previewKind?: FilePreviewKind;
  mimeType?: string | null;
  size?: number;
  contentOmitted?: boolean;
  omittedReason?: FileContent["omittedReason"];
};

type FilePreviewLike = {
  isBinary: boolean;
  previewKind?: FilePreviewKind;
  mimeType?: string | null;
  size?: number;
};

function getFilePreviewKind(file: FilePreviewLike | null | undefined): FilePreviewKind {
  if (!file) return "text";
  if (file.previewKind) return file.previewKind;
  if (file.mimeType?.startsWith("image/") && file.isBinary) return "image";
  return file.isBinary ? "binary" : "text";
}

function isTextTab(tab: OpenTab | null | undefined): boolean {
  return Boolean(tab) && getFilePreviewKind(tab) === "text" && !tab?.isBinary;
}

function isMarkdownTab(tab: OpenTab | null | undefined): boolean {
  if (!tab || !isTextTab(tab)) return false;
  const lowerPath = tab.path.toLowerCase();
  return tab.languageId === "markdown" || lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx");
}

function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function openTabFromFileContent(filePath: string, loaded: FileContent): OpenTab {
  return {
    path: filePath,
    content: loaded.content,
    savedContent: loaded.content,
    languageId: loaded.languageId,
    isBinary: loaded.isBinary,
    previewKind: getFilePreviewKind(loaded),
    mimeType: loaded.mimeType ?? null,
    size: loaded.size,
    contentOmitted: loaded.contentOmitted,
    omittedReason: loaded.omittedReason,
  };
}

type FilesPageNavState = {
  openFilePath?: string;
  laneId?: string;
  preferPrimaryWorkspace?: boolean;
  mode?: "edit" | "diff";
  startLine?: number;
  startColumn?: number;
};

type ConflictHunk = {
  key: string;
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
};

type ContextMenuState = {
  x: number;
  y: number;
  nodePath: string;
  nodeType: "file" | "directory";
};

const FILES_CONTEXT_MENU_INSET = 8;
const FILES_CONTEXT_MENU_WIDTH = 200;

type TextPromptState = {
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type EditorViewMode = "edit" | "diff" | "conflict";
type EditorThemeMode = "dark" | "light";
type ExternalEditorTarget = "default" | "finder" | "vscode" | "cursor" | "zed";
type FilesPaneConfig = {
  title: string;
  icon?: React.ElementType;
  meta?: React.ReactNode;
  headerActions?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
};

type FilesPageSessionState = {
  workspaceId: string;
  workspaceRootPath: string | null;
  allowPrimaryEdit: boolean;
  selectedNodePath: string | null;
  openTabs: OpenTab[];
  activeTabPath: string | null;
  mode: EditorViewMode;
  markdownPreviewEnabled: boolean;
  searchQuery: string;
  editorTheme: EditorThemeMode;
};

const filesPageSessionByScope = new Map<string, FilesPageSessionState>();
const filesPageSessionLru: string[] = [];
const filesWorkspaceCacheByProject = new Map<string, FilesWorkspace[]>();
const filesRootTreeCacheByWorkspace = new Map<string, FileTreeNode[]>();
const MAX_FILES_PAGE_CACHED_SCOPES = 8;
const MAX_FILES_TREE_CACHED_WORKSPACES = 32;
const MAX_CACHED_CLEAN_TAB_CHARS = 256 * 1024;
const MAX_QUEUED_TREE_PARENT_REFRESHES = 24;
const FILES_TREE_PAGE_SIZE = 2_000;
const FILES_MAX_AUTO_LOADED_CHILDREN = 10_000;
const FILES_WATCH_START_DELAY_MS = import.meta.env.MODE === "test" || (window as any).__adeBrowserMock ? 0 : 2_000;

function filesSessionKey(projectRoot: string, laneId: string | null): string {
  return `${projectRoot}::${laneId ?? "__primary__"}`;
}

function filesWorkspaceTreeCacheKey(projectRoot: string, workspaceId: string): string {
  return `${projectRoot}::${workspaceId}`;
}

function readCachedFilesWorkspaces(projectRoot: string): FilesWorkspace[] {
  const cached = filesWorkspaceCacheByProject.get(projectRoot);
  return cached ? cached.map((workspace) => ({ ...workspace })) : [];
}

function writeCachedFilesWorkspaces(projectRoot: string, workspaces: FilesWorkspace[]): void {
  filesWorkspaceCacheByProject.set(projectRoot, workspaces.map((workspace) => ({ ...workspace })));
}

function readCachedFilesRootTree(projectRoot: string, workspaceId: string): FileTreeNode[] {
  if (!workspaceId) return [];
  const key = filesWorkspaceTreeCacheKey(projectRoot, workspaceId);
  const cached = filesRootTreeCacheByWorkspace.get(key);
  if (!cached) return [];
  filesRootTreeCacheByWorkspace.delete(key);
  filesRootTreeCacheByWorkspace.set(key, cached);
  return cached;
}

function writeCachedFilesRootTree(projectRoot: string, workspaceId: string, nodes: FileTreeNode[]): void {
  if (!workspaceId) return;
  const key = filesWorkspaceTreeCacheKey(projectRoot, workspaceId);
  filesRootTreeCacheByWorkspace.delete(key);
  filesRootTreeCacheByWorkspace.set(key, nodes);
  while (filesRootTreeCacheByWorkspace.size > MAX_FILES_TREE_CACHED_WORKSPACES) {
    const oldest = filesRootTreeCacheByWorkspace.keys().next().value;
    if (!oldest) break;
    filesRootTreeCacheByWorkspace.delete(oldest);
  }
}

function fileTreeNodeByPath(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
  const out = new Map<string, FileTreeNode>();
  const walk = (items: FileTreeNode[]) => {
    for (const item of items) {
      out.set(item.path, item);
      if (item.children?.length) walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

function mergeTreePreservingLoadedChildren(nextNodes: FileTreeNode[], previousNodes: FileTreeNode[]): FileTreeNode[] {
  const previousByPath = fileTreeNodeByPath(previousNodes);
  return nextNodes.map((node) => {
    if (node.type !== "directory") return node;
    const previous = previousByPath.get(node.path);
    if (!previous?.children || node.children) return node;
    return {
      ...node,
      children: previous.children,
      childrenTruncated: previous.childrenTruncated,
      loadMoreOffset: previous.loadMoreOffset,
    };
  });
}

/**
 * Apply a resolved Git decoration snapshot onto the currently-loaded tree
 * without refetching structure. `directories` already contains every ancestor
 * of a changed file, so a flat lookup is sufficient — directories that aren't
 * loaded yet simply pick up their status when they are expanded (the snapshot
 * is warm in the service cache by then). Node identity is preserved when a
 * node's status is unchanged so React can skip re-rendering it.
 */
function applyGitStatusToTree(nodes: FileTreeNode[], event: FilesGitStatusEvent): FileTreeNode[] {
  const fileStatus = new Map<string, FileTreeChangeStatus>();
  for (const entry of event.files) fileStatus.set(entry.path, entry.changeStatus);
  const dirStatus = new Map<string, FileTreeChangeStatus>();
  for (const entry of event.directories) dirStatus.set(entry.path, entry.changeStatus);

  const walk = (items: FileTreeNode[]): FileTreeNode[] => {
    let changed = false;
    const next = items.map((node) => {
      const nextStatus: FileTreeChangeStatus = node.type === "directory"
        ? (fileStatus.get(node.path) ?? dirStatus.get(node.path) ?? null)
        : (fileStatus.get(node.path) ?? null);
      const nextChildren = node.children?.length ? walk(node.children) : node.children;
      if (node.changeStatus === nextStatus && nextChildren === node.children) {
        return node;
      }
      changed = true;
      return { ...node, changeStatus: nextStatus, children: nextChildren };
    });
    return changed ? next : items;
  };

  return walk(nodes);
}

function replaceTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      return { ...node, children, loadMoreOffset, childrenTruncated: loadMoreOffset != null };
    }
    if (node.children?.length) {
      return { ...node, children: replaceTreeNodeChildren(node.children, parentPath, children, loadMoreOffset) };
    }
    return node;
  });
}

function appendTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      const existing = node.children ?? [];
      const seen = new Set(existing.map((child) => child.path));
      const merged = [...existing];
      for (const child of children) {
        if (seen.has(child.path)) continue;
        seen.add(child.path);
        merged.push(child);
      }
      return { ...node, children: merged, loadMoreOffset, childrenTruncated: loadMoreOffset != null };
    }
    if (node.children?.length) {
      return { ...node, children: appendTreeNodeChildren(node.children, parentPath, children, loadMoreOffset) };
    }
    return node;
  });
}

function defaultFilesWorkspaceId(
  workspaces: FilesWorkspace[],
  preferredLaneId: string | null,
  unavailableWorkspaceIds: ReadonlySet<string> = new Set(),
): string {
  const availableWorkspaces = workspaces.filter((workspace) => !unavailableWorkspaceIds.has(workspace.id));
  if (preferredLaneId) {
    const laneWorkspace = availableWorkspaces.find((workspace) => workspace.kind !== "primary" && workspace.laneId === preferredLaneId)
      ?? availableWorkspaces.find((workspace) => workspace.laneId === preferredLaneId);
    if (laneWorkspace) return laneWorkspace.id;
  }
  return availableWorkspaces[0]?.id ?? workspaces[0]?.id ?? "";
}

function formatFilesError(err: unknown, fallback = "File operation failed."): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || fallback;
}

function isMissingWorkspaceRootError(message: string): boolean {
  return /(?:ENOENT|no such file or directory|worktree is missing|workspace is missing)/i.test(message);
}

function touchFilesPageSession(sessionKey: string): void {
  const existingIndex = filesPageSessionLru.indexOf(sessionKey);
  if (existingIndex >= 0) {
    filesPageSessionLru.splice(existingIndex, 1);
  }
  filesPageSessionLru.push(sessionKey);
}

function getFilesPageSession(sessionKey: string): FilesPageSessionState | undefined {
  const session = filesPageSessionByScope.get(sessionKey);
  if (session) touchFilesPageSession(sessionKey);
  return session;
}

function filesPageSessionHasUnsavedTabs(session: FilesPageSessionState | undefined): boolean {
  return session?.openTabs.some((tab) => tab.content !== tab.savedContent) ?? false;
}

function cacheableSessionTabs(openTabs: OpenTab[]): OpenTab[] {
  return openTabs
    .filter((tab) => {
      // Always retain unsaved buffers across session scope changes; size limits
      // apply only to clean tabs so large in-flight edits are not dropped silently.
      if (tab.content !== tab.savedContent) {
        return true;
      }
      return isTextTab(tab) && tab.content.length <= MAX_CACHED_CLEAN_TAB_CHARS;
    })
    .map((tab) => ({ ...tab }));
}

function hasFilesPageSessionForWorkspaceRoot(workspaceRootPath: string, excludeSessionKey?: string): boolean {
  for (const [key, session] of filesPageSessionByScope.entries()) {
    if (excludeSessionKey && key === excludeSessionKey) continue;
    if (session.workspaceRootPath === workspaceRootPath) {
      return true;
    }
  }
  return false;
}

function setFilesPageSession(sessionKey: string, session: FilesPageSessionState): void {
  filesPageSessionByScope.set(sessionKey, session);
  touchFilesPageSession(sessionKey);
  while (filesPageSessionLru.length > MAX_FILES_PAGE_CACHED_SCOPES) {
    const evictIndex = filesPageSessionLru.findIndex((candidateKey) => {
      if (candidateKey === sessionKey) return false;
      return !filesPageSessionHasUnsavedTabs(filesPageSessionByScope.get(candidateKey));
    });
    if (evictIndex < 0) break;
    const [evicted] = filesPageSessionLru.splice(evictIndex, 1);
    if (!evicted) break;
    const evictedSession = filesPageSessionByScope.get(evicted);
    filesPageSessionByScope.delete(evicted);
    if (
      evictedSession?.workspaceRootPath
      && !hasFilesPageSessionForWorkspaceRoot(evictedSession.workspaceRootPath, evicted)
    ) {
      clearDirtyBuffersForWorkspace(evictedSession.workspaceRootPath);
    }
  }
}

function snapshotFilesPageSessionState(args: {
  workspaceId: string;
  workspaceRootPath: string | null;
  allowPrimaryEdit: boolean;
  selectedNodePath: string | null;
  openTabs: OpenTab[];
  activeTabPath: string | null;
  mode: EditorViewMode;
  markdownPreviewEnabled: boolean;
  searchQuery: string;
  editorTheme: EditorThemeMode;
}): FilesPageSessionState {
  const openTabs = cacheableSessionTabs(args.openTabs);
  const activeTabPath = openTabs.some((tab) => tab.path === args.activeTabPath) ? args.activeTabPath : (openTabs.at(-1)?.path ?? null);
  return {
    workspaceId: args.workspaceId,
    workspaceRootPath: args.workspaceRootPath,
    allowPrimaryEdit: args.allowPrimaryEdit,
    selectedNodePath: args.selectedNodePath,
    openTabs,
    activeTabPath,
    mode: args.mode,
    markdownPreviewEnabled: args.markdownPreviewEnabled,
    searchQuery: args.searchQuery,
    editorTheme: args.editorTheme,
  };
}

const FILES_EDITOR_THEME_KEY = "ade.files.editorTheme";

function readStoredEditorTheme(): EditorThemeMode {
  try {
    const raw = window.localStorage.getItem(FILES_EDITOR_THEME_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    // ignore
  }
  return "dark";
}

function persistEditorTheme(theme: EditorThemeMode): void {
  try {
    window.localStorage.setItem(FILES_EDITOR_THEME_KEY, theme);
  } catch {
    // ignore
  }
}

let monacoInit: Promise<typeof import("monaco-editor")> | null = null;

async function loadMonaco(): Promise<typeof import("monaco-editor")> {
  if (!monacoInit) {
    monacoInit = (async () => {
      const [{ default: EditorWorker }, { default: TsWorker }] = await Promise.all([
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
        import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      ]);
      const globalAny = globalThis as typeof globalThis & {
        MonacoEnvironment?: {
          getWorker?: (workerId: string, label: string) => Worker;
        };
      };
      const existing = globalAny.MonacoEnvironment;
      globalAny.MonacoEnvironment = {
        ...existing,
        getWorker: existing?.getWorker ?? ((_workerId: string, label: string) => {
          if (label === "typescript" || label === "javascript") {
            return new TsWorker();
          }
          return new EditorWorker();
        })
      };
      return await import("monaco-editor");
    })();
  }
  return await monacoInit;
}

function parseConflictHunks(text: string): ConflictHunk[] {
  const lines = text.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  let ordinal = 0;

  while (i < lines.length) {
    if (!lines[i]?.startsWith("<<<<<<<")) {
      i += 1;
      continue;
    }

    const startLine = i + 1;
    i += 1;
    const ours: string[] = [];

    while (i < lines.length && !lines[i]?.startsWith("=======")) {
      ours.push(lines[i] ?? "");
      i += 1;
    }
    if (i >= lines.length) break;

    i += 1;
    const theirs: string[] = [];
    while (i < lines.length && !lines[i]?.startsWith(">>>>>>>")) {
      theirs.push(lines[i] ?? "");
      i += 1;
    }
    if (i >= lines.length) break;

    const endLine = i + 1;
    i += 1;
    hunks.push({
      key: `${startLine}-${endLine}-${ordinal++}`,
      startLine,
      endLine,
      ours: ours.join("\n"),
      theirs: theirs.join("\n")
    });
  }

  return hunks;
}

function parentPathOf(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized.length) return undefined;
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return normalized.slice(0, slash);
}

function applyConflictChoice(text: string, hunk: ConflictHunk, choice: "ours" | "theirs" | "both"): string {
  const lines = text.split("\n");
  const before = lines.slice(0, hunk.startLine - 1);
  const after = lines.slice(hunk.endLine);
  const middle = choice === "ours" ? hunk.ours : choice === "theirs" ? hunk.theirs : `${hunk.ours}\n${hunk.theirs}`;
  return [...before, middle, ...after].join("\n");
}

function parentDirOfPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  if (!normalized) return "";
  if (/^[A-Za-z]:\/$/.test(normalized)) return "";
  if (/^\/\/[^/]+\/[^/]+$/.test(normalized)) return "";
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function areWorkspacePathsEqual(left: string | null | undefined, right: string | null | undefined, workspaceRoot?: string | null): boolean {
  if (left == null || right == null) return left === right;
  return arePathsEqual(left, right, workspaceRoot);
}

function findItemByWorkspacePath<T extends { path: string }>(
  items: ReadonlyArray<T>,
  targetPath: string | null | undefined,
  workspaceRoot?: string | null,
): T | undefined {
  if (!targetPath) return undefined;
  return items.find((item) => areWorkspacePathsEqual(item.path, targetPath, workspaceRoot));
}

function fileDiffHasRenderableChanges(diff: FileDiff): boolean {
  if (diff.original.exists !== diff.modified.exists) return true;
  if (diff.isBinary) return true;
  return diff.original.text !== diff.modified.text;
}

function filePatchHasRenderableChanges(patch: FilePatch | null | undefined): patch is FilePatch {
  if (!patch) return false;
  if (patch.isBinary) return true;
  return patch.patch.trim().length > 0;
}

function settledErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

const FILES_WORKSPACE_SELECT_LABEL_MAX_LEN = 52;

function shortBranchLabel(ref: string | null | undefined): string {
  const t = (ref ?? "").trim();
  if (!t) return "";
  return t.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function resolveWorkspaceBranchShort(ws: FilesWorkspace, lanes: LaneSummary[]): string {
  const direct = shortBranchLabel(ws.branchRef);
  if (direct) return direct;
  if (ws.laneId) {
    const fromLane = shortBranchLabel(lanes.find((l) => l.id === ws.laneId)?.branchRef);
    if (fromLane) return fromLane;
  }
  if (ws.kind === "primary") {
    return shortBranchLabel(lanes.find((l) => l.laneType === "primary")?.branchRef) || "main";
  }
  return "…";
}

function formatFilesWorkspaceSelectLabel(ws: FilesWorkspace, lanes: LaneSummary[]): { label: string; title: string } {
  const branch = resolveWorkspaceBranchShort(ws, lanes);
  const full = `${ws.name} · ${branch} (${ws.kind})`;
  if (full.length <= FILES_WORKSPACE_SELECT_LABEL_MAX_LEN) {
    return { label: full, title: full };
  }
  return { label: `${full.slice(0, FILES_WORKSPACE_SELECT_LABEL_MAX_LEN - 1)}…`, title: full };
}

function FilePreviewSurface({ tab }: { tab: OpenTab }) {
  const previewKind = getFilePreviewKind(tab);
  const sizeLabel = formatFileSize(tab.size);
  const details = [tab.mimeType, sizeLabel].filter(Boolean).join(" · ");
  const imageSrc = previewKind === "image" && tab.mimeType && tab.content
    ? `data:${tab.mimeType};base64,${tab.content}`
    : null;
  const [imageFailed, setImageFailed] = React.useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageSrc]);

  if (imageSrc && !imageFailed) {
    return (
      <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.recessedBg }}>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            src={imageSrc}
            alt={tab.path}
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: "auto" }}
            onError={() => setImageFailed(true)}
          />
        </div>
        <div className="shrink-0 border-t px-3 py-2" style={{ borderColor: COLORS.border, color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
          <span style={{ color: COLORS.textPrimary }}>{tab.path}</span>
          {details ? <span> · {details}</span> : null}
        </div>
      </div>
    );
  }

  const title = previewKind === "image" ? "Image preview unavailable" : "Preview unavailable";
  const body = tab.contentOmitted && tab.omittedReason === "too_large"
    ? "This file is too large to display inline."
    : previewKind === "image"
      ? "This image could not be decoded for inline preview."
      : "This file type cannot be displayed inline.";

  return (
    <div className="flex h-full items-center justify-center" style={{ background: COLORS.recessedBg }}>
      <div className="max-w-[360px] px-6 text-center">
        <FileText size={32} weight="thin" style={{ color: COLORS.textDim, margin: "0 auto 10px" }} />
        <div style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 700, letterSpacing: "1px", color: COLORS.textPrimary }}>
          {title.toUpperCase()}
        </div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5, color: COLORS.textMuted, marginTop: 8 }}>
          {body}
        </div>
        <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim, marginTop: 12 }} title={tab.path}>
          {tab.path}
        </div>
        {details ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
            {details}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function FilesPage({
  preferredLaneId = null,
  embedded = false,
  active = true,
}: {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedLaneIdFromStore = useAppStore((s) => s.selectedLaneId);
  const lanes = useAppStore((s) => s.lanes);
  const projectRootPath = useAppStore((s) => s.project?.rootPath ?? "__unknown_project__");
  const selectedLaneId = preferredLaneId ?? selectedLaneIdFromStore;
  const sessionKey = filesSessionKey(projectRootPath, selectedLaneId);
  const initialSession = getFilesPageSession(sessionKey);
  const initialCachedWorkspaces = readCachedFilesWorkspaces(projectRootPath);
  const initialWorkspaceId = initialSession?.workspaceId
    ?? defaultFilesWorkspaceId(initialCachedWorkspaces, selectedLaneId);

  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>(initialCachedWorkspaces);
  const [workspaceId, setWorkspaceId] = useState<string>(initialWorkspaceId);
  const workspaceIdRef = useRef(initialWorkspaceId);
  workspaceIdRef.current = workspaceId;
  const dirtyWorkspaceRootRef = useRef<string | null>(null);
  const [unavailableWorkspaceIds, setUnavailableWorkspaceIds] = useState<Set<string>>(() => new Set());
  const [allowPrimaryEdit, setAllowPrimaryEdit] = useState(initialSession?.allowPrimaryEdit ?? false);
  const [tree, setTree] = useState<FileTreeNode[]>(() => readCachedFilesRootTree(projectRootPath, initialWorkspaceId));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(initialSession?.selectedNodePath ?? null);
  const pendingOpenRef = useRef<{
    filePath: string;
    laneId: string | null;
    preferPrimaryWorkspace: boolean;
    key: string;
    mode?: "edit" | "diff";
    startLine?: number;
    startColumn?: number;
  } | null>(null);
  const pendingRevealRef = useRef<{ mode: EditorViewMode; startLine: number; startColumn?: number; targetPath?: string } | null>(null);
  const diffViewRef = useRef<AdeDiffViewerHandle | null>(null);
  const treeRefreshStateRef = useRef<{
    rootInFlight: boolean;
    inFlightParents: Set<string>;
    queuedFull: boolean;
    queuedParents: Set<string>;
  }>({
    rootInFlight: false,
    inFlightParents: new Set<string>(),
    queuedFull: false,
    queuedParents: new Set<string>()
  });
  const refreshTreeNowRef = useRef<((parentPath?: string) => Promise<void>) | null>(null);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => initialSession?.openTabs.map((tab) => ({ ...tab })) ?? []);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(initialSession?.activeTabPath ?? null);
  const [mode, setMode] = useState<EditorViewMode>(initialSession?.mode ?? "edit");
  const [markdownPreviewEnabled, setMarkdownPreviewEnabled] = useState(initialSession?.markdownPreviewEnabled ?? false);
  const [editorTheme, setEditorTheme] = useState<EditorThemeMode>(initialSession?.editorTheme ?? readStoredEditorTheme());

  const [quickOpen, setQuickOpen] = useState("");
  const [quickOpenResults, setQuickOpenResults] = useState<FilesQuickOpenItem[]>([]);
  const [showQuickOpen, setShowQuickOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState(initialSession?.searchQuery ?? "");
  const [showContentSearch, setShowContentSearch] = useState(false);
  const [contentSearchQuery, setContentSearchQuery] = useState("");
  const [contentSearchResults, setContentSearchResults] = useState<FilesSearchTextMatch[]>([]);
  const [inlineRenameRequest, setInlineRenameRequest] = useState<{ path: string; nonce: number } | null>(null);

  const [resolvedConflictKeys, setResolvedConflictKeys] = useState<Set<string>>(new Set());
  const [textPrompt, setTextPrompt] = useState<TextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<"loading" | "ready" | "failed">("loading");
  // The editor host is assigned after the pane body commits, so the first effect
  // pass may run before the host div exists.
  const [editorHostEl, setEditorHostEl] = useState<HTMLDivElement | null>(null);

  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  // One cached Monaco model per open file (created once, reused on revisit).
  // Tab switches become setModel(existing) instead of dispose+recreate.
  const modelRegistryRef = useRef(createMonacoModelRegistry());
  const editorApplyingRef = useRef(false);
  const activeTabPathRef = useRef<string | null>(null);
  const openTabsRef = useRef<OpenTab[]>([]);

  const contentSearchInputRef = useRef<HTMLInputElement | null>(null);
  const openInMenuRef = useRef<HTMLDivElement | null>(null);
  const setEditorHostRef = useCallback((node: HTMLDivElement | null) => {
    setEditorHostEl(node);
  }, []);
  const revealPendingLocation = useCallback((): boolean => {
    const pendingReveal = pendingRevealRef.current;
    if (!pendingReveal) return false;
    const activeRevealPath = activeTabPathRef.current;
    if (
      pendingReveal.targetPath
      && activeRevealPath
      && !arePathsEqual(activeRevealPath, pendingReveal.targetPath)
    ) {
      return false;
    }

    if (pendingReveal.mode === "diff") {
      const handle = diffViewRef.current;
      if (!handle) return false;
      try {
        handle.revealLineInCenter(pendingReveal.startLine);
      } catch {
        return false;
      }
      pendingRevealRef.current = null;
      return true;
    }

    const editor = editorRef.current;
    if (!editor) return false;
    try {
      editor.revealLineInCenter(pendingReveal.startLine);
      if (typeof pendingReveal.startColumn === "number" && pendingReveal.startColumn > 0) {
        editor.setPosition({ lineNumber: pendingReveal.startLine, column: pendingReveal.startColumn });
      }
    } catch {
      return false;
    }
    pendingRevealRef.current = null;
    return true;
  }, []);

  const activeWorkspace = useMemo(() => workspaces.find((ws) => ws.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const workspaceSelectOptions = useMemo(
    () =>
      workspaces.map((ws) => {
        const formatted = formatFilesWorkspaceSelectLabel(ws, lanes);
        return { id: ws.id, label: formatted.label, title: formatted.title };
      }),
    [workspaces, lanes],
  );
  const activeWorkspaceSelectTitle = useMemo(() => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return undefined;
    return formatFilesWorkspaceSelectLabel(ws, lanes).title;
  }, [workspaces, workspaceId, lanes]);
  const workspaceComparisonRoot = activeWorkspace?.rootPath ?? null;
  const activeTab = useMemo(
    () => findItemByWorkspacePath(openTabs, activeTabPath, workspaceComparisonRoot) ?? null,
    [openTabs, activeTabPath, workspaceComparisonRoot],
  );
  const activeTabPreviewKind = getFilePreviewKind(activeTab);
  const activeTabIsText = isTextTab(activeTab);
  const activeTabIsMarkdown = isMarkdownTab(activeTab);
  const markdownPreviewActive = mode === "edit" && activeTabIsMarkdown && markdownPreviewEnabled;
  const activeTabUsesCodeEditor = activeTabIsText && !markdownPreviewActive;
  const canEdit = Boolean(activeWorkspace) && (!activeWorkspace?.isReadOnlyByDefault || allowPrimaryEdit);
  const liveWatchEnabled = active && Boolean(workspaceId);

  useEffect(() => {
    if (activeTabIsMarkdown || !markdownPreviewEnabled) return;
    setMarkdownPreviewEnabled(false);
  }, [activeTabIsMarkdown, markdownPreviewEnabled]);

  useEffect(() => {
    const nextRootPath = activeWorkspace?.rootPath ?? null;
    const previousRootPath = dirtyWorkspaceRootRef.current;
    if (previousRootPath && previousRootPath !== nextRootPath) {
      clearDirtyBuffersForWorkspace(previousRootPath);
    }
    dirtyWorkspaceRootRef.current = nextRootPath;
    if (!nextRootPath) return;
    replaceDirtyBuffersForWorkspace(nextRootPath, openTabs);
  }, [activeWorkspace?.rootPath, openTabs]);

  const prevSessionKeyRef = useRef(sessionKey);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional snapshot of outgoing session state; deps are omitted so we capture values at the moment sessionKey changes
  useEffect(() => {
    if (prevSessionKeyRef.current === sessionKey) return;
    // Save current state under the old scope before switching
    setFilesPageSession(prevSessionKeyRef.current, snapshotFilesPageSessionState({
      workspaceId,
      workspaceRootPath: activeWorkspace?.rootPath ?? null,
      allowPrimaryEdit,
      selectedNodePath,
      openTabs,
      activeTabPath,
      mode,
      markdownPreviewEnabled,
      searchQuery,
      editorTheme,
    }));
    prevSessionKeyRef.current = sessionKey;
    // Restore state for the new scope (project + lane)
    const session = getFilesPageSession(sessionKey);
    const cachedWorkspaces = readCachedFilesWorkspaces(projectRootPath);
    if (cachedWorkspaces.length) {
      setWorkspaces(cachedWorkspaces);
    }
    const nextWorkspaceId = session?.workspaceId
      ?? defaultFilesWorkspaceId(cachedWorkspaces.length ? cachedWorkspaces : workspaces, selectedLaneId, unavailableWorkspaceIds);
    setWorkspaceId(nextWorkspaceId);
    setTree(readCachedFilesRootTree(projectRootPath, nextWorkspaceId));
    setAllowPrimaryEdit(session?.allowPrimaryEdit ?? false);
    setSelectedNodePath(session?.selectedNodePath ?? null);
    setOpenTabs(session?.openTabs.map((tab) => ({ ...tab })) ?? []);
    setActiveTabPath(session?.activeTabPath ?? null);
    setMode(session?.mode ?? "edit");
    setMarkdownPreviewEnabled(session?.markdownPreviewEnabled ?? false);
    setSearchQuery(session?.searchQuery ?? "");
    setEditorTheme(session?.editorTheme ?? readStoredEditorTheme());
  }, [sessionKey]);

  const hasUnsavedTabs = useMemo(
    () => openTabs.some((tab) => tab.content !== tab.savedContent),
    [openTabs]
  );

  useEffect(() => {
    setFilesPageSession(sessionKey, snapshotFilesPageSessionState({
      workspaceId,
      workspaceRootPath: activeWorkspace?.rootPath ?? null,
      allowPrimaryEdit,
      selectedNodePath,
      openTabs,
      activeTabPath,
      mode,
      markdownPreviewEnabled,
      searchQuery,
      editorTheme,
    }));
  }, [sessionKey, workspaceId, activeWorkspace?.rootPath, allowPrimaryEdit, selectedNodePath, openTabs, activeTabPath, mode, markdownPreviewEnabled, searchQuery, editorTheme]);

  useEffect(() => {
    persistEditorTheme(editorTheme);
  }, [editorTheme]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (openInMenuRef.current && !openInMenuRef.current.contains(event.target as Node)) {
        setOpenInMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const openActivePathInExternalTool = useCallback(
    async (target: ExternalEditorTarget) => {
      if (!activeWorkspace || !activeTabPath) return;
      setOpenInMenuOpen(false);
      try {
        await window.ade.app.openPathInEditor({
          rootPath: activeWorkspace.rootPath,
          relativePath: activeTabPath,
          target
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeWorkspace, activeTabPath]
  );

  const requestTextInput = useCallback(
    (args: {
      title: string;
      message?: string;
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      validate?: (value: string) => string | null;
    }): Promise<string | null> => {
      return new Promise((resolve) => {
        const defaultValue = args.defaultValue ?? "";
        setTextPromptError(null);
        setTextPrompt({
          title: args.title,
          message: args.message,
          value: defaultValue,
          placeholder: args.placeholder,
          confirmLabel: args.confirmLabel ?? "Confirm",
          validate: args.validate,
          resolve
        });
      });
    },
    []
  );

  const cancelTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    setTextPromptError(null);
  }, []);

  const submitTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (!prev) return prev;
      const trimmed = prev.value.trim();
      const validationError = prev.validate?.(trimmed) ?? null;
      if (validationError) {
        setTextPromptError(validationError);
        return prev;
      }
      setTextPromptError(null);
      prev.resolve(trimmed);
      return null;
    });
  }, []);

  const switchWorkspace = useCallback((nextWorkspaceId: string): boolean => {
    if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return false;
    if (hasUnsavedTabs) {
      const ok = window.confirm("You have unsaved changes. Switch workspace anyway?");
      if (!ok) return false;
    }
    setWorkspaceId(nextWorkspaceId);
    setOpenTabs([]);
    setActiveTabPath(null);
    setSelectedNodePath(null);
    return true;
  }, [workspaceId, hasUnsavedTabs]);

  const nodeByComparablePath = useMemo(() => {
    const out = new Map<string, FileTreeNode>();
    const walk = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        out.set(normalizePathForWorkspaceComparison(node.path, workspaceComparisonRoot), node);
        if (node.children?.length) walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree, workspaceComparisonRoot]);
  const selectedTreeNodePath = useMemo(() => {
    if (!selectedNodePath) return null;
    return nodeByComparablePath.get(normalizePathForWorkspaceComparison(selectedNodePath, workspaceComparisonRoot))?.path ?? null;
  }, [nodeByComparablePath, selectedNodePath, workspaceComparisonRoot]);
  const activeContextPath = contextMenu?.nodePath ?? selectedTreeNodePath ?? activeTabPath;
  const laneWorkspaces = useMemo(
    () => workspaces.filter((ws) => ws.kind !== "primary" && !unavailableWorkspaceIds.has(ws.id)),
    [unavailableWorkspaceIds, workspaces],
  );
  const suggestedLaneWorkspace = useMemo(() => {
    if (unavailableWorkspaceIds.size > 0) return null;
    if (!laneWorkspaces.length) return null;
    if (selectedLaneId) {
      const fromSelectedLane = laneWorkspaces.find((ws) => ws.laneId === selectedLaneId);
      if (fromSelectedLane) return fromSelectedLane;
    }
    return laneWorkspaces[0] ?? null;
  }, [laneWorkspaces, selectedLaneId, unavailableWorkspaceIds]);

  useEffect(() => {
    logRendererDebugEvent("renderer.files.page_mount");
    let cancelled = false;
    const raf1 = window.requestAnimationFrame(() => {
      if (cancelled) return;
      logRendererDebugEvent("renderer.files.page_frame", { frame: 1 });
      const raf2 = window.requestAnimationFrame(() => {
        if (cancelled) return;
        logRendererDebugEvent("renderer.files.page_frame", { frame: 2 });
      });
      return () => window.cancelAnimationFrame(raf2);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      logRendererDebugEvent("renderer.files.page_unmount");
    };
  }, []);

  useEffect(() => {
    logRendererDebugEvent("renderer.files.render_state", {
      workspaceId: workspaceId || null,
      treeRootCount: tree.length,
      openTabCount: openTabs.length,
      activeTabPath,
      mode,
      editorStatus,
      searchQueryActive: searchQuery.trim().length > 0,
      quickOpenVisible: showQuickOpen,
    });
  }, [workspaceId, tree.length, openTabs.length, activeTabPath, mode, editorStatus, searchQuery, showQuickOpen]);

  useEffect(() => {
    activeTabPathRef.current = activeTab?.path ?? activeTabPath;
  }, [activeTab?.path, activeTabPath]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    void revealPendingLocation();
  }, [revealPendingLocation, mode, editorStatus, activeTab?.path]);

  useEffect(() => {
    const st = (location.state as FilesPageNavState | null) ?? null;
    if (!active) return;
    const openFilePath = st?.openFilePath?.trim();
    if (!openFilePath) return;
    if (typeof st?.startLine === "number" && st.startLine > 0) {
      pendingRevealRef.current = {
        mode: st?.mode ?? "edit",
        startLine: st.startLine,
        startColumn: st?.startColumn,
        targetPath: openFilePath,
      };
    }
    pendingOpenRef.current = {
      key: location.key,
      filePath: openFilePath,
      laneId: st?.laneId ?? null,
      preferPrimaryWorkspace: st?.preferPrimaryWorkspace === true,
      mode: st?.mode,
      startLine: st?.startLine,
      startColumn: st?.startColumn,
    };
  }, [active, location.key, location.state]);

  const refreshTreeNow = useCallback(async (parentPath?: string) => {
    if (!workspaceId) return;
    const requestWorkspaceId = workspaceId;
    const isRootRefresh = !parentPath;
    const startedAt = isRootRefresh ? performance.now() : 0;
    if (isRootRefresh) {
      logRendererDebugEvent("renderer.files.refresh_tree.begin", {
        workspaceId: requestWorkspaceId,
      });
    }
    try {
      if (!parentPath) {
        const nodes = await window.ade.files.listTree({
          workspaceId: requestWorkspaceId,
          depth: 1,
          includeIgnored: true
        });
        if (workspaceIdRef.current !== requestWorkspaceId) return;
        logRendererDebugEvent("renderer.files.refresh_tree.done", {
          workspaceId: requestWorkspaceId,
          durationMs: Math.round(performance.now() - startedAt),
          rootNodeCount: nodes.length,
        });
        setTree((prev) => {
          const nextTree = mergeTreePreservingLoadedChildren(nodes, prev);
          writeCachedFilesRootTree(projectRootPath, requestWorkspaceId, nextTree);
          return nextTree;
        });
        setError(null);
        setUnavailableWorkspaceIds((prev) => {
          if (!prev.has(requestWorkspaceId)) return prev;
          const next = new Set(prev);
          next.delete(requestWorkspaceId);
          return next;
        });
        return;
      }

      // Expand a directory by paging through its children until exhausted, so
      // arbitrarily large folders open fully instead of silently stopping at
      // the old 1,000-child cap. A safety ceiling bounds pathological dirs and
      // surfaces the remainder via `loadMoreOffset` (logged — never dropped).
      const children: FileTreeNode[] = [];
      let offset = 0;
      let loadMoreOffset: number | null = null;
      for (;;) {
        const page = await window.ade.files.listTreeChildren({
          workspaceId: requestWorkspaceId,
          parentPath,
          offset,
          limit: FILES_TREE_PAGE_SIZE,
          includeIgnored: true,
        });
        if (workspaceIdRef.current !== requestWorkspaceId) return;
        children.push(...page.children);
        if (page.nextOffset == null) break;
        if (children.length >= FILES_MAX_AUTO_LOADED_CHILDREN) {
          loadMoreOffset = page.nextOffset;
          logRendererDebugEvent("renderer.files.expand_dir.capped", {
            workspaceId: requestWorkspaceId,
            parentPath,
            loadedChildren: children.length,
            total: page.total,
            nextOffset: page.nextOffset,
          });
          break;
        }
        offset = page.nextOffset;
      }

      setTree((prev) => {
        const nextTree = replaceTreeNodeChildren(prev, parentPath, children, loadMoreOffset);
        writeCachedFilesRootTree(projectRootPath, requestWorkspaceId, nextTree);
        return nextTree;
      });
    } catch (err) {
      if (workspaceIdRef.current !== requestWorkspaceId) return;
      const message = formatFilesError(err);
      if (isRootRefresh) {
        logRendererDebugEvent("renderer.files.refresh_tree.failed", {
          workspaceId: requestWorkspaceId,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
      }
      const primaryWorkspace = activeWorkspace?.kind !== "primary"
        ? workspaces.find((workspace) => workspace.kind === "primary")
        : null;
      if (isRootRefresh && primaryWorkspace && primaryWorkspace.id !== requestWorkspaceId && isMissingWorkspaceRootError(message) && !hasUnsavedTabs) {
        setUnavailableWorkspaceIds((prev) => new Set(prev).add(requestWorkspaceId));
        setTree([]);
        setExpanded(new Set());
        setLoadingDirectories(new Set());
        setSelectedNodePath(null);
        setOpenTabs([]);
        setActiveTabPath(null);
        setWorkspaceId(primaryWorkspace.id);
        return;
      }
      setError(message);
    }
  }, [activeWorkspace?.kind, hasUnsavedTabs, projectRootPath, workspaceId, workspaces]);

  refreshTreeNowRef.current = refreshTreeNow;

  const refreshTree = useCallback(async (parentPath?: string) => {
    if (!workspaceId) return;
    const normalizedParent = parentPath?.trim() ? parentPath : undefined;
    const state = treeRefreshStateRef.current;

    if (normalizedParent) {
      if (state.inFlightParents.has(normalizedParent)) return;
      state.inFlightParents.add(normalizedParent);
      try {
        await refreshTreeNowRef.current!(normalizedParent);
      } finally {
        state.inFlightParents.delete(normalizedParent);
      }
      return;
    }

    if (state.rootInFlight) {
      state.queuedFull = true;
      state.queuedParents.clear();
      return;
    }

    state.rootInFlight = true;
    try {
      while (true) {
        await refreshTreeNowRef.current!(undefined);
        if (state.queuedFull) {
          state.queuedFull = false;
          state.queuedParents.clear();
          continue;
        }
        break;
      }
    } finally {
      state.rootInFlight = false;
    }
  }, [refreshTreeNow, workspaceId]);

  const openFile = useCallback(async (filePath: string, options: { forceReload?: boolean; preserveMode?: boolean } = {}) => {
    if (!workspaceId) return null;
    const requestedPath = normalizePath(filePath);
    const normalizedPath = nodeByComparablePath.get(normalizePathForWorkspaceComparison(requestedPath, workspaceComparisonRoot))?.path ?? requestedPath;
    const existingOpenTab = findItemByWorkspacePath(openTabsRef.current, normalizedPath, workspaceComparisonRoot);
    if (existingOpenTab && !options.forceReload) {
      if (!options.preserveMode) {
        setMode("edit");
      }
      setActiveTabPath(existingOpenTab.path);
      setSelectedNodePath(existingOpenTab.path);
      setError(null);
      return existingOpenTab.path;
    }
    try {
      const loaded = await window.ade.files.readFile({ workspaceId, path: normalizedPath });
      const nextTab = openTabFromFileContent(normalizedPath, loaded);
      setError(null);
      setOpenTabs((prev) => {
        const existing = findItemByWorkspacePath(prev, normalizedPath, workspaceComparisonRoot);
        if (existing && !options.forceReload) return prev;
        if (existing && options.forceReload) {
          return prev.map((tab) => (
            areWorkspacePathsEqual(tab.path, normalizedPath, workspaceComparisonRoot)
              ? { ...tab, ...nextTab }
              : tab
          ));
        }
        return [...prev, nextTab];
      });
      if (!options.preserveMode) {
        setMode("edit");
      }
      setActiveTabPath(normalizedPath);
      setSelectedNodePath(normalizedPath);
      return normalizedPath;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [workspaceId, nodeByComparablePath, workspaceComparisonRoot]);

  const syncCleanTabFromDisk = useCallback(async (filePathRaw: string) => {
    if (!workspaceId) return;
    const requestedPath = normalizePath(filePathRaw);
    const filePath = nodeByComparablePath.get(normalizePathForWorkspaceComparison(requestedPath, workspaceComparisonRoot))?.path ?? requestedPath;
    if (!filePath) return;
    const hasCleanOpenTab = openTabsRef.current.some((tab) => (
      areWorkspacePathsEqual(tab.path, filePath, workspaceComparisonRoot) && tab.content === tab.savedContent
    ));
    if (!hasCleanOpenTab) return;

    try {
      const loaded = await window.ade.files.readFile({ workspaceId, path: filePath });
      const nextTab = openTabFromFileContent(filePath, loaded);
      setOpenTabs((prev) => {
        let changed = false;
        const next = prev.map((tab) => {
          if (!areWorkspacePathsEqual(tab.path, filePath, workspaceComparisonRoot)) return tab;
          if (tab.content !== tab.savedContent) return tab;
          if (
            areWorkspacePathsEqual(tab.path, filePath, workspaceComparisonRoot) &&
            tab.content === loaded.content &&
            tab.savedContent === loaded.content &&
            tab.languageId === loaded.languageId &&
            tab.isBinary === loaded.isBinary &&
            getFilePreviewKind(tab) === getFilePreviewKind(loaded) &&
            tab.mimeType === (loaded.mimeType ?? null) &&
            tab.size === loaded.size &&
            tab.contentOmitted === loaded.contentOmitted &&
            tab.omittedReason === loaded.omittedReason
          ) {
            return tab;
          }
          changed = true;
          return { ...tab, ...nextTab };
        });
        return changed ? next : prev;
      });
    } catch {
      // A deleted or renamed path can race this sync; ignore quietly.
    }
  }, [workspaceId, workspaceComparisonRoot, nodeByComparablePath]);

  useEffect(() => {
    if (!active) return;
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (!workspaces.length) return;

    let desiredWorkspaceId: string | null = null;
    if (pending.preferPrimaryWorkspace) {
      desiredWorkspaceId = workspaces.find((ws) => ws.kind === "primary")?.id ?? null;
    } else if (pending.laneId != null) {
      desiredWorkspaceId = workspaces.find((ws) => ws.kind !== "primary" && ws.laneId === pending.laneId)?.id ?? null;
    }
    const targetWorkspaceId = desiredWorkspaceId ?? workspaceId;
    if (targetWorkspaceId && targetWorkspaceId !== workspaceId) {
      const switched = switchWorkspace(targetWorkspaceId);
      if (!switched) {
        pendingOpenRef.current = null;
        navigate(location.pathname, { replace: true, state: null });
      }
      return;
    }
    if (!workspaceId) return;

    const pendingMode = pending.mode;
    const pendingStartLine = pending.startLine;
    const pendingStartColumn = pending.startColumn;
    let cancelled = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    openFile(pending.filePath)
      .then((openedPath) => {
        if (cancelled) return;
        if (pendingMode === "diff") setMode("diff");
        if (typeof pendingStartLine === "number" && pendingStartLine > 0) {
          pendingRevealRef.current = {
            mode: pendingMode ?? "edit",
            startLine: pendingStartLine,
            startColumn: pendingStartColumn,
            targetPath: openedPath ?? pending.filePath,
          };
          const attemptReveal = (attemptsLeft: number) => {
            if (cancelled) return;
            if (revealPendingLocation()) return;
            if (attemptsLeft > 0) {
              pendingTimer = setTimeout(() => attemptReveal(attemptsLeft - 1), 80);
            }
          };
          attemptReveal(6);
        }
      })
      .catch(() => {});
    pendingOpenRef.current = null;
    navigate(location.pathname, { replace: true, state: null });
    return () => {
      cancelled = true;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
    };
  }, [active, workspaces, workspaceId, switchWorkspace, openFile, navigate, location.pathname, revealPendingLocation]);

  const closeTab = useCallback((filePath: string) => {
    const tab = findItemByWorkspacePath(openTabsRef.current, filePath, workspaceComparisonRoot);
    if (!tab) return;
    if (tab.content !== tab.savedContent) {
      const ok = window.confirm(`"${tab.path}" has unsaved changes. Close anyway?`);
      if (!ok) return;
    }
    // Free the cached Monaco model now that the file is no longer open.
    modelRegistryRef.current.dispose(tab.path);
    const remaining = openTabsRef.current.filter((t) => !areWorkspacePathsEqual(t.path, filePath, workspaceComparisonRoot));
    setOpenTabs(remaining);
    if (areWorkspacePathsEqual(activeTabPathRef.current, filePath, workspaceComparisonRoot)) {
      setActiveTabPath(remaining[remaining.length - 1]?.path ?? null);
    }
  }, [workspaceComparisonRoot]);

  const saveActive = useCallback(async () => {
    if (!activeTab || !workspaceId || !canEdit || !isTextTab(activeTab)) return;
    await window.ade.files.writeText({ workspaceId, path: activeTab.path, text: activeTab.content });
    setOpenTabs((prev) => prev.map((tab) => (
      areWorkspacePathsEqual(tab.path, activeTab.path, workspaceComparisonRoot) ? { ...tab, savedContent: tab.content } : tab
    )));
  }, [activeTab, workspaceId, canEdit, workspaceComparisonRoot]);

  const laneIdForWorkspace = activeWorkspace?.laneId ?? null;

  const stagePath = useCallback(async (filePath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!laneIdForWorkspace) return;
    await window.ade.git.stageFile({ laneId: laneIdForWorkspace, path: filePath });
    await refreshTree();
  }, [canEdit, laneIdForWorkspace, refreshTree]);

  const unstagePath = useCallback(async (filePath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!laneIdForWorkspace) return;
    await window.ade.git.unstageFile({ laneId: laneIdForWorkspace, path: filePath });
    await refreshTree();
  }, [canEdit, laneIdForWorkspace, refreshTree]);

  const discardPath = useCallback(async (filePath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!laneIdForWorkspace) return;
    const ok = window.confirm(`Discard local changes for ${filePath}?`);
    if (!ok) return;
    await window.ade.git.discardFile({ laneId: laneIdForWorkspace, path: filePath });
    await refreshTree();
    if (areWorkspacePathsEqual(activeTabPath, filePath, workspaceComparisonRoot)) {
      await openFile(filePath, { forceReload: true });
    }
  }, [canEdit, laneIdForWorkspace, refreshTree, activeTabPath, openFile, workspaceComparisonRoot]);

  const renamePathTo = useCallback(async (targetPath: string, nextPath: string) => {
    if (!canEdit) {
      throw new Error("Editing is disabled for the current workspace.");
    }
    if (!workspaceId) return;
    if (!nextPath || areWorkspacePathsEqual(nextPath, targetPath, workspaceComparisonRoot)) return;
    await window.ade.files.rename({ workspaceId, oldPath: targetPath, newPath: nextPath });
    setOpenTabs((prev) => prev.map((tab) => (
      areWorkspacePathsEqual(tab.path, targetPath, workspaceComparisonRoot) ? { ...tab, path: nextPath } : tab
    )));
    if (areWorkspacePathsEqual(activeTabPath, targetPath, workspaceComparisonRoot)) setActiveTabPath(nextPath);
    setSelectedNodePath(nextPath);
    await refreshTree();
  }, [canEdit, workspaceId, activeTabPath, refreshTree, workspaceComparisonRoot]);

  const deletePath = useCallback(async (targetPath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!workspaceId) return;
    const ok = window.confirm(`Delete ${targetPath}?`);
    if (!ok) return;
    await window.ade.files.delete({ workspaceId, path: targetPath });
    setOpenTabs((prev) => prev.filter((tab) => !areWorkspacePathsEqual(tab.path, targetPath, workspaceComparisonRoot)));
    if (areWorkspacePathsEqual(activeTabPath, targetPath, workspaceComparisonRoot)) setActiveTabPath(null);
    setSelectedNodePath(null);
    await refreshTree();
  }, [canEdit, workspaceId, activeTabPath, refreshTree, workspaceComparisonRoot]);

  const createFileAt = useCallback(async (basePath?: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!workspaceId) return;
    const defaultPath = basePath ? `${basePath.replace(/\/$/, "")}/new-file.txt` : "new-file.txt";
    const next = await requestTextInput({
      title: "New file",
      message: "Enter file path relative to workspace.",
      defaultValue: defaultPath,
      confirmLabel: "Create file",
      validate: (value) => (value ? null : "File path is required.")
    });
    if (!next) return;
    await window.ade.files.createFile({ workspaceId, path: next, content: "" });
    await refreshTree();
    await openFile(next);
  }, [canEdit, workspaceId, requestTextInput, refreshTree, openFile]);

  const createDirectoryAt = useCallback(async (basePath?: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!workspaceId) return;
    const defaultPath = basePath ? `${basePath.replace(/\/$/, "")}/new-folder` : "new-folder";
    const next = await requestTextInput({
      title: "New folder",
      message: "Enter folder path relative to workspace.",
      defaultValue: defaultPath,
      confirmLabel: "Create folder",
      validate: (value) => (value ? null : "Folder path is required.")
    });
    if (!next) return;
    await window.ade.files.createDirectory({ workspaceId, path: next });
    await refreshTree();
  }, [canEdit, workspaceId, requestTextInput, refreshTree]);

  useEffect(() => {
    if (!active) return;
    const startedAt = performance.now();
    logRendererDebugEvent("renderer.files.list_workspaces.begin");
    window.ade.files.listWorkspaces()
      .then((items) => {
        logRendererDebugEvent("renderer.files.list_workspaces.done", {
          durationMs: Math.round(performance.now() - startedAt),
          workspaceCount: items.length,
        });
        writeCachedFilesWorkspaces(projectRootPath, items);
        setWorkspaces(items);
        setWorkspaceId((current) => {
          if (current && items.some((workspace) => workspace.id === current)) return current;
          if (current) {
            setOpenTabs([]);
            setActiveTabPath(null);
            setSelectedNodePath(null);
          }
          return defaultFilesWorkspaceId(items, selectedLaneId, unavailableWorkspaceIds);
        });
      })
      .catch((err) => {
        logRendererDebugEvent("renderer.files.list_workspaces.failed", {
          durationMs: Math.round(performance.now() - startedAt),
          error: err instanceof Error ? err.message : String(err),
        });
        setError(err instanceof Error ? err.message : String(err));
      });
    // Workspaces are listed once on mount; lane changes are reconciled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Reconcile the active workspace when the preferred lane changes (without refetching).
  useEffect(() => {
    if (!preferredLaneId || !workspaces.length) return;
    const nextWorkspaceId = defaultFilesWorkspaceId(workspaces, selectedLaneId, unavailableWorkspaceIds);
    if (!nextWorkspaceId) return;
    setWorkspaceId((current) => {
      if (current === nextWorkspaceId) return current;
      // Tabs from the previous workspace would target the wrong filesystem. Clear them
      // here to mirror what `switchWorkspace` does when the user changes workspace manually.
      if (current) {
        setOpenTabs([]);
        setActiveTabPath(null);
        setSelectedNodePath(null);
      }
      return nextWorkspaceId;
    });
  }, [preferredLaneId, selectedLaneId, unavailableWorkspaceIds, workspaces]);

  useEffect(() => {
    if (workspaceId || !workspaces.length) return;
    const nextWorkspaceId = defaultFilesWorkspaceId(workspaces, selectedLaneId, unavailableWorkspaceIds);
    if (nextWorkspaceId) setWorkspaceId(nextWorkspaceId);
  }, [selectedLaneId, unavailableWorkspaceIds, workspaceId, workspaces]);

  useEffect(() => {
    if (!active) return;
    if (!workspaceId) return;
    logRendererDebugEvent("renderer.files.workspace_effect.begin", {
      workspaceId,
    });
    const cachedTree = readCachedFilesRootTree(projectRootPath, workspaceId);
    setTree(cachedTree);
    setExpanded(new Set());
    setContextMenu(null);
    treeRefreshStateRef.current.rootInFlight = false;
    treeRefreshStateRef.current.inFlightParents.clear();
    treeRefreshStateRef.current.queuedFull = false;
    treeRefreshStateRef.current.queuedParents.clear();
    setLoadingDirectories(new Set());
    // Paint structure immediately (cached/empty Git status), then stream real
    // decorations in as soon as `git status` resolves — replacing the old
    // fixed 2.5s blind second tree fetch.
    void refreshTree();
    let cancelled = false;
    void window.ade.files
      .refreshGitDecorations({ workspaceId, forceFresh: true })
      .then((event) => {
        if (cancelled || workspaceIdRef.current !== workspaceId) return;
        setTree((prev) => {
          const next = applyGitStatusToTree(prev, event);
          if (next === prev) return prev;
          writeCachedFilesRootTree(projectRootPath, workspaceId, next);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, projectRootPath, workspaceId, refreshTree]);

  useEffect(() => {
    if (!workspaceId) return;
    if (!liveWatchEnabled) {
      logRendererDebugEvent("renderer.files.watch.skipped", {
        workspaceId,
        reason: "no_open_tabs",
      });
      return;
    }

    let refreshTimer: number | null = null;
    let startupTimer: number | null = null;
    let queuedFullRefresh = false;
    const queuedParents = new Set<string>();
    const pendingTabSyncPaths = new Set<string>();
    let watchRequested = false;
    let unsub = () => {};

    const queueTreeRefresh = (parentPath?: string) => {
      const normalizedParent = normalizePath(parentPath ?? "");
      if (!normalizedParent) {
        queuedFullRefresh = true;
        queuedParents.clear();
      } else if (!queuedFullRefresh) {
        queuedParents.add(normalizedParent);
        if (queuedParents.size > MAX_QUEUED_TREE_PARENT_REFRESHES) {
          queuedFullRefresh = true;
          queuedParents.clear();
        }
      }
    };

    const scheduleFlush = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        const parentsToRefresh = queuedFullRefresh ? [] : Array.from(queuedParents);
        queuedFullRefresh = false;
        queuedParents.clear();

        if (parentsToRefresh.length === 0) {
          void refreshTree();
        } else {
          for (const parentPath of parentsToRefresh) {
            void refreshTree(parentPath);
          }
        }

        const pathsToSync = Array.from(pendingTabSyncPaths);
        pendingTabSyncPaths.clear();
        for (const path of pathsToSync) {
          void syncCleanTabFromDisk(path);
        }
      }, 120);
    };

    const handleFileChange = (ev: FileChangeEvent) => {
      if (ev.workspaceId !== workspaceId) return;

      const nextPath = normalizePath(ev.path);
      const oldPath = normalizePath(ev.oldPath ?? "");

      if (ev.type === "renamed" && oldPath && nextPath) {
        setOpenTabs((prev) => {
          let changed = false;
          const next = prev.map((tab) => {
            const mappedPath = remapPathForRename(tab.path, oldPath, nextPath, workspaceComparisonRoot);
            if (mappedPath === tab.path) return tab;
            changed = true;
            if (tab.content === tab.savedContent) pendingTabSyncPaths.add(mappedPath);
            return { ...tab, path: mappedPath };
          });
          return changed ? next : prev;
        });
        setActiveTabPath((current) => (current ? remapPathForRename(current, oldPath, nextPath, workspaceComparisonRoot) : current));
        setSelectedNodePath((current) => (current ? remapPathForRename(current, oldPath, nextPath, workspaceComparisonRoot) : current));
        setExpanded((prev) => {
          let changed = false;
          const next = new Set<string>();
          for (const path of prev) {
            const mappedPath = remapPathForRename(path, oldPath, nextPath, workspaceComparisonRoot);
            next.add(mappedPath);
            if (mappedPath !== path) changed = true;
          }
          return changed ? next : prev;
        });
        queueTreeRefresh(parentPathOf(oldPath));
        queueTreeRefresh(parentPathOf(nextPath));
        scheduleFlush();
        return;
      }

      if (ev.type === "deleted" && nextPath) {
        setOpenTabs((prev) => {
          const next = prev.filter((tab) => !isPathEqualOrDescendant(tab.path, nextPath, workspaceComparisonRoot));
          if (next.length !== prev.length) {
            const activePath = activeTabPathRef.current;
            if (activePath && !next.some((tab) => areWorkspacePathsEqual(tab.path, activePath, workspaceComparisonRoot))) {
              setActiveTabPath(next[next.length - 1]?.path ?? null);
            }
          }
          return next.length === prev.length ? prev : next;
        });
        setSelectedNodePath((current) => (current && isPathEqualOrDescendant(current, nextPath, workspaceComparisonRoot) ? null : current));
        setExpanded((prev) => {
          const next = new Set(Array.from(prev).filter((path) => !isPathEqualOrDescendant(path, nextPath, workspaceComparisonRoot)));
          return next.size === prev.size ? prev : next;
        });
      } else if (nextPath) {
        pendingTabSyncPaths.add(nextPath);
      }

      queueTreeRefresh(parentPathOf(nextPath));
      scheduleFlush();
    };

    startupTimer = window.setTimeout(() => {
      startupTimer = null;
      const watchStartedAt = performance.now();
      logRendererDebugEvent("renderer.files.watch.begin", {
        workspaceId,
      });
      watchRequested = true;
      window.ade.files.watchChanges({ workspaceId })
        .then(() => {
          logRendererDebugEvent("renderer.files.watch.done", {
            workspaceId,
            durationMs: Math.round(performance.now() - watchStartedAt),
          });
        })
        .catch((error) => {
          logRendererDebugEvent("renderer.files.watch.failed", {
            workspaceId,
            durationMs: Math.round(performance.now() - watchStartedAt),
            error: error instanceof Error ? error.message : String(error),
          });
        });

      unsub = window.ade.files.onChange(handleFileChange);
    }, FILES_WATCH_START_DELAY_MS);

    return () => {
      logRendererDebugEvent("renderer.files.workspace_effect.cleanup_begin", {
        workspaceId,
      });
      if (startupTimer != null) window.clearTimeout(startupTimer);
      unsub();
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      if (!watchRequested) return;
      const stopStartedAt = performance.now();
      window.ade.files.stopWatching({ workspaceId })
        .then(() => {
          logRendererDebugEvent("renderer.files.watch.cleanup_done", {
            workspaceId,
            durationMs: Math.round(performance.now() - stopStartedAt),
          });
        })
        .catch((error) => {
          logRendererDebugEvent("renderer.files.watch.cleanup_failed", {
            workspaceId,
            durationMs: Math.round(performance.now() - stopStartedAt),
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
  }, [workspaceId, liveWatchEnabled, refreshTree, syncCleanTabFromDisk, workspaceComparisonRoot]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedTabs) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedTabs]);

  useEffect(() => {
    if (!active) return;
    const onWindowPointerDown = () => {
      if (contextMenu) setContextMenu(null);
    };
    window.addEventListener("pointerdown", onWindowPointerDown);
    return () => window.removeEventListener("pointerdown", onWindowPointerDown);
  }, [active, contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu) {
      setContextMenuPosition(null);
      return;
    }

    const clampMenu = () => {
      const rect = contextMenuRef.current?.getBoundingClientRect();
      const width = rect?.width ?? FILES_CONTEXT_MENU_WIDTH;
      const height = rect?.height ?? 0;
      const maxLeft = Math.max(FILES_CONTEXT_MENU_INSET, window.innerWidth - width - FILES_CONTEXT_MENU_INSET);
      const maxTop = Math.max(FILES_CONTEXT_MENU_INSET, window.innerHeight - height - FILES_CONTEXT_MENU_INSET);
      setContextMenuPosition({
        left: Math.min(Math.max(FILES_CONTEXT_MENU_INSET, contextMenu.x), maxLeft),
        top: Math.min(Math.max(FILES_CONTEXT_MENU_INSET, contextMenu.y), maxTop),
      });
    };

    clampMenu();
    window.addEventListener("resize", clampMenu);
    window.addEventListener("scroll", clampMenu, true);
    return () => {
      window.removeEventListener("resize", clampMenu);
      window.removeEventListener("scroll", clampMenu, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const activeTarget = e.target;
      const isTextInput = activeTarget instanceof HTMLInputElement || activeTarget instanceof HTMLTextAreaElement;

      if (e.key === "Escape") {
        setContextMenu(null);
        if (showQuickOpen) setShowQuickOpen(false);
        if (showContentSearch) setShowContentSearch(false);
        if (openInMenuOpen) setOpenInMenuOpen(false);
        return;
      }

      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActive().catch(() => {});
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeTabPath) closeTab(activeTabPath);
        return;
      }

      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setShowQuickOpen(true);
        return;
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowContentSearch(true);
        return;
      }

      if (isTextInput) return;

      if (e.key === "F2") {
        e.preventDefault();
        const target = selectedNodePath ?? activeTabPath;
        if (!target) return;
        setInlineRenameRequest((prev) => ({ path: target, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, saveActive, activeTabPath, closeTab, selectedNodePath, showQuickOpen, showContentSearch, openInMenuOpen]);

  useEffect(() => {
    if (!active) return;
    if (!quickOpen.trim()) {
      setQuickOpenResults([]);
      return;
    }
    if (!showQuickOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.ade.files.quickOpen({ workspaceId, query: quickOpen, limit: 80, includeIgnored: true })
        .then((results) => {
          if (!cancelled) setQuickOpenResults(results);
        })
        .catch(() => {
          if (!cancelled) setQuickOpenResults([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, quickOpen, workspaceId, showQuickOpen]);

  useEffect(() => {
    if (!active) return;
    if (!showContentSearch) return;
    const frame = window.requestAnimationFrame(() => {
      contentSearchInputRef.current?.focus();
      contentSearchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, showContentSearch]);

  useEffect(() => {
    if (!active) return;
    if (!showContentSearch || !contentSearchQuery.trim()) {
      setContentSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      window.ade.files.searchText({ workspaceId, query: contentSearchQuery, limit: 200, includeIgnored: true })
        .then(setContentSearchResults)
        .catch(() => setContentSearchResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [active, contentSearchQuery, workspaceId, showContentSearch]);

  useEffect(() => {
    if (!activeTab) return;
    if (!activeTabUsesCodeEditor) return;
    if (mode !== "edit") return;
    if (!editorHostEl) return;
    if (editorRef.current) return;

    let disposed = false;
    setEditorStatus("loading");
    logRendererDebugEvent("renderer.files.monaco_load.begin", {
      path: activeTab.path,
    });
    loadMonaco().then((monaco) => {
      if (disposed) return;
      monacoRef.current = monaco;
      const editor = monaco.editor.create(editorHostEl, {
        value: "",
        language: "plaintext",
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        readOnly: !canEdit,
        theme: editorTheme === "light" ? "vs" : "vs-dark"
      });
      editorRef.current = editor;
      editor.onDidChangeModelContent(() => {
        const targetPath = activeTabPathRef.current;
        if (!targetPath || editorApplyingRef.current) return;
        const next = editor.getValue();
        setOpenTabs((prev) => prev.map((tab) => (
          areWorkspacePathsEqual(tab.path, targetPath, workspaceComparisonRoot) ? { ...tab, content: next } : tab
        )));
      });
      setEditorStatus("ready");
      void revealPendingLocation();
      logRendererDebugEvent("renderer.files.monaco_load.done", {
        path: activeTab.path,
      });
    }).catch((err) => {
      if (disposed) return;
      setEditorStatus("failed");
      logRendererDebugEvent("renderer.files.monaco_load.failed", {
        path: activeTab.path,
        error: err instanceof Error ? err.message : String(err),
      });
      setError(`Monaco failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
    });

    return () => {
      disposed = true;
      // Detach but DON'T dispose cached models here — the editor is also torn
      // down on edit↔diff mode switches, and we want models (and their undo
      // history) to survive that. Models are disposed on tab close / workspace
      // switch / unmount instead.
      try {
        editorRef.current?.setModel(null);
      } catch {
        // ignore
      }
      try {
        editorRef.current?.dispose();
      } catch {
        // ignore
      }
      editorRef.current = null;
    };
  // canEdit intentionally excluded — the updateOptions effect below handles
  // readOnly toggling without destroying and recreating the entire editor.
  // editorTheme intentionally excluded — toggling light/dark uses monaco.editor.setTheme
  // in the effect below; including editorTheme here would dispose/recreate the editor on
  // every theme click and break the instance (race with async loadMonaco).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabUsesCodeEditor, mode, editorHostEl, revealPendingLocation, workspaceComparisonRoot]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    monaco.editor.setTheme(editorTheme === "light" ? "vs" : "vs-dark");
  }, [editorTheme]);

  // Free every cached model when the workspace changes (the previous lane's
  // tabs are cleared) and on unmount. Also prevents a same relative path in a
  // different workspace from reusing a stale model with the wrong content.
  useEffect(() => {
    const registry = modelRegistryRef.current;
    return () => {
      registry.disposeAll();
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!editorRef.current || mode !== "edit") return;
    editorRef.current.updateOptions({ readOnly: !canEdit || !activeTabUsesCodeEditor });
  }, [mode, canEdit, activeTabUsesCodeEditor]);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current || mode !== "edit") return;
    const editor = editorRef.current;
    if (!activeTab || !activeTabUsesCodeEditor) {
      // Detach without disposing — the model stays cached for fast reactivation.
      try {
        editor.setModel(null);
      } catch {
        // ignore
      }
      return;
    }
    const monaco = monacoRef.current;
    const language = activeTab.languageId || "plaintext";
    const model = modelRegistryRef.current.getOrCreate(monaco, activeTab.path, activeTab.content, language);
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    editor.updateOptions({ readOnly: !canEdit || !activeTabUsesCodeEditor });
    void revealPendingLocation();
  }, [activeTab, activeTabUsesCodeEditor, mode, canEdit, editorStatus, revealPendingLocation]);

  useEffect(() => {
    if (!activeTab || !activeTabUsesCodeEditor || !editorRef.current || mode !== "edit") return;
    const current = editorRef.current.getValue();
    if (current === activeTab.content) return;
    editorApplyingRef.current = true;
    editorRef.current.setValue(activeTab.content);
    editorApplyingRef.current = false;
  }, [activeTab, activeTabUsesCodeEditor, mode]);

  useEffect(() => {
    setResolvedConflictKeys(new Set());
  }, [activeTabPath]);

  const conflictHunks = activeTab ? parseConflictHunks(activeTab.content) : [];
  const laneIdForDiff = activeWorkspace?.laneId;
  const editorModeHint = (() => {
    if (mode === "diff") return "Changes view: compare this file against unstaged, staged, or commit versions.";
    if (mode !== "edit") return "Merge view: resolve conflict markers in this file.";
    if (activeTabPreviewKind === "image") return "Image preview: view the file inline.";
    if (markdownPreviewActive) return "Markdown view: rendered preview for the current file.";
    if (activeTabIsText) return "Code view: edit the file directly.";
    return "Preview unavailable: open externally to inspect this file type.";
  })();

  const applyConflictResolution = useCallback((hunk: ConflictHunk, choice: "ours" | "theirs" | "both") => {
    if (!activeTab) return;
    setOpenTabs((prev) => prev.map((tab) => (
      tab.path === activeTab.path
        ? { ...tab, content: applyConflictChoice(tab.content, hunk, choice) }
        : tab
    )));
    setResolvedConflictKeys((prev) => {
      const next = new Set(prev);
      next.add(hunk.key);
      return next;
    });
  }, [activeTab]);

  const activeContextDir = (() => {
    if (!activeContextPath) return "";
    if (contextMenu?.nodeType === "directory") return activeContextPath;
    return parentDirOfPath(activeContextPath);
  })();

  const toggleDirectory = useCallback((nodePath: string, isExpanded: boolean, hasLoadedChildren: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodePath)) next.delete(nodePath);
      else next.add(nodePath);
      return next;
    });
    if (!isExpanded && !hasLoadedChildren) {
      setLoadingDirectories((prev) => {
        if (prev.has(nodePath)) return prev;
        const next = new Set(prev);
        next.add(nodePath);
        return next;
      });
      refreshTree(nodePath)
        .catch(() => {})
        .finally(() => {
          if (workspaceIdRef.current !== workspaceId) return;
          setLoadingDirectories((prev) => {
            if (!prev.has(nodePath)) return prev;
            const next = new Set(prev);
            next.delete(nodePath);
            return next;
          });
      });
    }
  }, [refreshTree, workspaceId]);

  const loadMoreChildren = useCallback(async (parentPath: string, startOffset: number) => {
    if (!workspaceId) return;
    const requestWorkspaceId = workspaceId;
    setLoadingDirectories((prev) => {
      if (prev.has(parentPath)) return prev;
      const next = new Set(prev);
      next.add(parentPath);
      return next;
    });
    try {
      const children: FileTreeNode[] = [];
      let offset = startOffset;
      let loadMoreOffset: number | null = null;
      for (;;) {
        const page = await window.ade.files.listTreeChildren({
          workspaceId: requestWorkspaceId,
          parentPath,
          offset,
          limit: FILES_TREE_PAGE_SIZE,
          includeIgnored: true,
        });
        if (workspaceIdRef.current !== requestWorkspaceId) return;
        children.push(...page.children);
        if (page.nextOffset == null) break;
        if (children.length >= FILES_MAX_AUTO_LOADED_CHILDREN) {
          loadMoreOffset = page.nextOffset;
          break;
        }
        offset = page.nextOffset;
      }
      setTree((prev) => {
        const nextTree = appendTreeNodeChildren(prev, parentPath, children, loadMoreOffset);
        writeCachedFilesRootTree(projectRootPath, requestWorkspaceId, nextTree);
        return nextTree;
      });
    } catch (err) {
      if (workspaceIdRef.current === requestWorkspaceId) setError(formatFilesError(err));
    } finally {
      if (workspaceIdRef.current !== requestWorkspaceId) return;
      setLoadingDirectories((prev) => {
        if (!prev.has(parentPath)) return prev;
        const next = new Set(prev);
        next.delete(parentPath);
        return next;
      });
    }
  }, [projectRootPath, workspaceId]);

  const runContextAction = (fn: () => Promise<void>) => {
    setContextMenu(null);
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  /* ---- Pane configs for the floating tiling layout ---- */

  const paneConfigs: Record<string, FilesPaneConfig> = useMemo(() => ({
    explorer: {
      title: "Explorer",
      icon: FolderOpen,
      meta: embedded ? undefined : activeWorkspace?.name,
      bodyClassName: "flex min-h-0 flex-col overflow-hidden",
      children: (
        <FilesExplorer
          compact={embedded}
          tree={tree}
          expanded={expanded}
          loadingDirectories={loadingDirectories}
          selectedNodePath={selectedTreeNodePath}
          activeTabPath={activeTabPath}
          activeContextDir={activeContextDir}
          workspaceComparisonRoot={workspaceComparisonRoot}
          searchQuery={searchQuery}
          inlineRenameRequest={inlineRenameRequest}
          onSearchQueryChange={setSearchQuery}
          onOpenQuickOpen={() => setShowQuickOpen(true)}
          onOpenContentSearch={() => setShowContentSearch(true)}
          onCreateFile={(basePath) => createFileAt(basePath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          onCreateDirectory={(basePath) => createDirectoryAt(basePath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          onToggleDirectory={toggleDirectory}
          onLoadMoreChildren={(path, offset) => { loadMoreChildren(path, offset).catch(() => {}); }}
          onOpenFile={(path) => { openFile(path).catch(() => {}); }}
          onSelectNode={setSelectedNodePath}
          onContextMenu={(event) => setContextMenu(event)}
          onRenamePath={renamePathTo}
          onInlineRenameSettled={() => setInlineRenameRequest(null)}
        />
      )
    },
    editor: {
      title: "Editor",
      icon: FileCode2,
      meta: activeTabPath ? activeTabPath.split("/").pop() : undefined,
      headerActions: (
        <div className="flex items-center gap-1.5">
          {/* Mode toggle group */}
          <div className="inline-flex items-center" style={{ border: `1px solid ${COLORS.outlineBorder}`, borderRadius: embedded ? 6 : 8, overflow: "hidden" }} data-tour="files.modeToggle">
            {(["edit", "diff", "conflict"] as const).map((m) => {
              const label = m === "edit" ? (embedded ? "CODE" : "CODE") : m === "diff" ? (embedded ? "DIFF" : "CHANGES") : (embedded ? "MERGE" : "MERGE");
              const description = m === "edit" ? "View and edit the file content." : m === "diff" ? "View the diff between working changes and the last commit." : "View and resolve merge conflicts.";
              const isActive = mode === m;
              const disabled = m === "diff" ? (!laneIdForDiff || !activeTabPath) : m === "conflict" ? !activeTabPath : false;
              return (
                <SmartTooltip key={m} content={{ label: m === "edit" ? "Code" : m === "diff" ? "Changes" : "Merge", description }}>
                  <button
                    type="button"
                    style={{
                      height: embedded ? 20 : 24, padding: embedded ? "0 5px" : "0 10px",
                      fontFamily: MONO_FONT, fontSize: embedded ? 8 : 9, fontWeight: 700, letterSpacing: embedded ? "0.5px" : "1px",
                      color: isActive ? COLORS.pageBg : disabled ? COLORS.textDim : COLORS.textMuted,
                      background: isActive ? COLORS.accent : "transparent",
                      border: "none", cursor: disabled ? "default" : "pointer",
                      opacity: disabled ? 0.4 : 1,
                    }}
                    onClick={() => !disabled && setMode(m)}
                    disabled={disabled}
                  >
                    {label}
                  </button>
                </SmartTooltip>
              );
            })}
          </div>
          {activeTabIsMarkdown ? (
            <SmartTooltip content={{ label: markdownPreviewEnabled ? "Show markdown source" : "Render markdown", description: markdownPreviewEnabled ? "Show the plain Markdown text." : "Preview this Markdown file with the plan renderer." }}>
              <button
                type="button"
                aria-label={markdownPreviewEnabled ? "Show markdown source" : "Render markdown preview"}
                style={{
                  ...outlineButton({ height: embedded ? 20 : 24, padding: embedded ? "0 6px" : "0 8px", fontSize: embedded ? 8 : 9 }),
                  color: markdownPreviewEnabled ? COLORS.accent : COLORS.textSecondary,
                  borderColor: markdownPreviewEnabled ? COLORS.accent : COLORS.outlineBorder,
                }}
                onClick={() => setMarkdownPreviewEnabled((prev) => !prev)}
              >
                {markdownPreviewEnabled ? <FileCode2 size={11} weight="bold" /> : <Eye size={11} weight="bold" />}
              </button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{ label: "Save", description: "Save the current file to disk.", shortcut: "\u2318S" }}>
            <button
              type="button"
              aria-label="Save"
              style={{
                ...primaryButton({ height: embedded ? 20 : 24, padding: embedded ? "0 6px" : "0 10px", fontSize: embedded ? 8 : 9 }),
                opacity: (!activeTab || !canEdit || !activeTabIsText) ? 0.35 : 1,
              }}
              onClick={() => saveActive().catch(() => {})}
              disabled={!activeTab || !canEdit || !activeTabIsText}
            >
              <Save size={11} weight="bold" />{embedded ? null : " SAVE"}
            </button>
          </SmartTooltip>
        </div>
      ),
      bodyClassName: "flex flex-col",
      children: (
        <div className="flex flex-col h-full min-h-0" style={{ background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 12 }}>
          {/* Tab bar */}
          <div className="flex items-center shrink-0 overflow-x-auto" style={{ borderBottom: `1px solid ${COLORS.border}`, minHeight: 36 }}>
            {openTabs.length === 0 ? (
              <span style={{ padding: "0 14px", fontFamily: MONO_FONT, fontSize: 10, fontWeight: 600, letterSpacing: "1px", color: COLORS.textDim }}>
                NO OPEN FILES
              </span>
            ) : null}
            {openTabs.map((tab, idx) => {
              const dirty = tab.content !== tab.savedContent;
              const isActiveTab = areWorkspacePathsEqual(activeTabPath, tab.path, workspaceComparisonRoot);
              const tabNumber = String(idx + 1).padStart(2, "0");
              const tabFileIcon = getFileIcon(tab.path.split("/").pop() ?? "");
              const TabFileIcon = tabFileIcon.icon;
              return (
                <div
                  key={tab.path}
                  className="group flex items-center gap-2 shrink-0 cursor-pointer"
                  style={{
                    padding: "0 14px",
                    height: 36,
                    borderLeft: isActiveTab ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                    background: isActiveTab ? COLORS.accentSubtle : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!isActiveTab) e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { if (!isActiveTab) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ fontFamily: MONO_FONT, fontSize: 9, fontWeight: 600, letterSpacing: "1px", color: isActiveTab ? COLORS.accent : COLORS.textDim }}>{tabNumber}</span>
                  <TabFileIcon size={12} style={{ color: tabFileIcon.color, flexShrink: 0 }} />
                  <button
                    className="truncate text-left"
                    style={{
                      maxWidth: 180, fontFamily: MONO_FONT, fontSize: 11, letterSpacing: "0.5px",
                      fontWeight: isActiveTab ? 600 : 400,
                      color: isActiveTab ? COLORS.textPrimary : COLORS.textMuted,
                      background: "transparent", border: "none", cursor: "pointer",
                    }}
                    onClick={() => setActiveTabPath(tab.path)}
                  >
                    {tab.path.split("/").pop()}
                  </button>
                  {dirty ? (
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.warning, flexShrink: 0 }} title="Unsaved changes" />
                  ) : null}
                  <button
                    type="button"
                    className="shrink-0 transition-opacity opacity-0 group-hover:opacity-100"
                    style={{ display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer" }}
                    onClick={() => closeTab(tab.path)}
                    title="Close tab"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Mode hint */}
          <div className="flex items-center gap-1 shrink-0" style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "3px 12px" }}>
            <span style={{ ...LABEL_STYLE, fontSize: 9, color: COLORS.textDim }}>{editorModeHint.toUpperCase()}</span>
            <HelpChip termId="dirty" side="top" />
          </div>

          {/* Editor content */}
          <div className="min-h-0 flex-1" style={{ position: "relative" }}>
            {!activeTab ? (
              <div className="flex h-full items-center justify-center" style={{ background: COLORS.recessedBg }}>
                <div style={{ textAlign: "center" }}>
                  <FileCode2 size={32} weight="thin" style={{ color: COLORS.textDim, margin: "0 auto 8px" }} />
                  <div style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, letterSpacing: "1px", color: COLORS.textDim }}>
                    OPEN A FILE TO START EDITING
                  </div>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, marginTop: 4, opacity: 0.6 }}>
                    CMD+P TO QUICK OPEN
                  </div>
                </div>
              </div>
            ) : null}
            {mode === "edit" ? (
              <div className="h-full">
                {activeTab && !activeTabIsText ? (
                  <FilePreviewSurface tab={activeTab} />
                ) : activeTab && markdownPreviewActive ? (
                  <div
                    data-testid="files-markdown-preview"
                    className="h-full overflow-auto"
                    style={{
                      background: COLORS.recessedBg,
                      color: COLORS.textPrimary,
                      padding: embedded ? 12 : 18,
                    }}
                  >
                    <React.Suspense
                      fallback={
                        <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted }}>
                          Rendering markdown...
                        </div>
                      }
                    >
                      <LazyPlanMarkdown source={activeTab.content} className="max-w-[880px]" />
                    </React.Suspense>
                  </div>
                ) : activeTab ? (
                  <div ref={setEditorHostRef} className={cn("h-full", editorStatus === "failed" && "hidden")} />
                ) : null}
                {activeTab && activeTabUsesCodeEditor && editorStatus === "loading" ? (
                  <div className="flex h-full items-center justify-center" style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted }}>
                    <span className="animate-pulse">LOADING EDITOR...</span>
                  </div>
                ) : null}
                {activeTab && activeTabUsesCodeEditor && editorStatus === "failed" ? (
                  <textarea
                    value={activeTab?.content ?? ""}
                    readOnly={!canEdit || !activeTabIsText}
                    onChange={(e) => {
                      if (!activeTab) return;
                      setOpenTabs((prev) =>
                        prev.map((tab) => (tab.path === activeTab.path ? { ...tab, content: e.target.value } : tab))
                      );
                    }}
                    style={{
                      height: "100%", width: "100%", resize: "none", padding: 12,
                      fontFamily: MONO_FONT, fontSize: 12, outline: "none",
                      background: COLORS.recessedBg, color: COLORS.textPrimary, border: "none",
                    }}
                  />
                ) : null}
              </div>
            ) : mode === "diff" ? (
              laneIdForDiff && activeTabPath ? (
                <FilesDiffPanel laneId={laneIdForDiff} path={activeTabPath} theme={editorTheme} diffViewRef={diffViewRef} active={active} />
              ) : (
                <div style={{ padding: 16, fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  DIFF MODE REQUIRES A LANE WORKSPACE AND AN OPEN FILE.
                </div>
              )
            ) : (
              <div
                data-testid="files-conflict-layout"
                data-layout={embedded ? "stacked" : "split"}
                className={cn(
                  "h-full min-h-0 min-w-0",
                  embedded ? "flex flex-col" : "grid",
                )}
                style={embedded ? undefined : { gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)" }}
              >
                <div
                  data-testid="files-conflict-hunks"
                  className="min-h-0 min-w-0 overflow-auto"
                  style={{
                    padding: 12,
                    borderRight: embedded ? "none" : `1px solid ${COLORS.border}`,
                    borderBottom: embedded ? `1px solid ${COLORS.border}` : "none",
                    background: COLORS.cardBg,
                    maxHeight: embedded ? "42%" : undefined,
                  }}
                >
                  <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                    <span style={{ ...LABEL_STYLE }}>CONFLICT HUNKS</span>
                    <span style={inlineBadge(
                      resolvedConflictKeys.size === conflictHunks.length && conflictHunks.length > 0 ? COLORS.success : COLORS.textMuted,
                      { fontSize: 8 }
                    )}>
                      {resolvedConflictKeys.size}/{conflictHunks.length}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {conflictHunks.map((hunk) => {
                      const resolved = resolvedConflictKeys.has(hunk.key);
                      return (
                        <div key={hunk.key} style={{
                          ...cardStyle({ padding: 10 }),
                          borderLeft: resolved ? `3px solid ${COLORS.success}` : `3px solid ${COLORS.danger}`,
                        }}>
                          <div className="flex items-center justify-between" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
                            <span>L{hunk.startLine}–{hunk.endLine}</span>
                            {resolved ? (
                              <span className="inline-flex items-center gap-1" style={{ color: COLORS.success, fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT }}>
                                <Sparkles size={10} weight="fill" /> RESOLVED
                              </span>
                            ) : null}
                          </div>
                          <div className="flex gap-1" style={{ marginTop: 6 }}>
                            <SmartTooltip content={{ label: "Keep Ours", description: "Accept your version of this conflict." }}>
                              <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "ours")}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.info; e.currentTarget.style.color = COLORS.info; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                              >OURS</button>
                            </SmartTooltip>
                            <SmartTooltip content={{ label: "Keep Theirs", description: "Accept their version of this conflict." }}>
                              <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "theirs")}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.warning; e.currentTarget.style.color = COLORS.warning; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                              >THEIRS</button>
                            </SmartTooltip>
                            <SmartTooltip content={{ label: "Keep Both", description: "Keep both versions, yours first then theirs." }}>
                              <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "both")}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                              >BOTH</button>
                            </SmartTooltip>
                          </div>
                        </div>
                      );
                    })}
                    {conflictHunks.length === 0 ? (
                      <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>NO CONFLICT MARKERS IN CURRENT FILE.</div>
                    ) : null}
                  </div>
                </div>
                <div className="h-full min-h-0 min-w-0 flex-1">
                  <textarea
                    value={activeTab?.content ?? ""}
                    onChange={(e) => {
                      if (!activeTab) return;
                      setOpenTabs((prev) => prev.map((tab) => (tab.path === activeTab.path ? { ...tab, content: e.target.value } : tab)));
                    }}
                    style={{
                      height: "100%", width: "100%", minWidth: 0, resize: "none", padding: 12,
                      fontFamily: MONO_FONT, fontSize: 12, outline: "none",
                      background: COLORS.recessedBg, color: COLORS.textPrimary, border: "none",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )
    }
  }), [
    tree, expanded, activeWorkspace, activeTabPath, activeContextDir, openTabs, activeTab, activeTabIsText,
    activeTabIsMarkdown, activeTabUsesCodeEditor, markdownPreviewActive, markdownPreviewEnabled,
    mode, canEdit, editorStatus, laneIdForDiff,
    searchQuery, inlineRenameRequest, selectedTreeNodePath, conflictHunks, editorTheme, editorModeHint,
    resolvedConflictKeys, createFileAt, createDirectoryAt, saveActive,
    closeTab, stagePath, unstagePath, discardPath, openFile, setShowQuickOpen, navigate,
    applyConflictResolution, setEditorHostRef, workspaceComparisonRoot, toggleDirectory, loadMoreChildren, renamePathTo,
    loadingDirectories,
    embedded
  ]);

  const renderPane = useCallback((paneId: keyof typeof paneConfigs) => {
    const config = paneConfigs[paneId];
    const Icon = config.icon;
    return (
      <section
        className="ade-files-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        style={{
          borderRadius: embedded ? 10 : 16,
          border: `1px solid ${COLORS.border}`,
          background: "color-mix(in srgb, var(--color-card) 94%, var(--color-bg) 6%)",
          boxShadow: embedded ? "none" : "0 18px 40px rgba(3, 8, 20, 0.18)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
        }}
      >
        <div
          className="ade-files-pane-header flex shrink-0 items-center gap-2"
          style={{
            minHeight: embedded ? 32 : 46,
            padding: embedded ? "0 8px" : "0 14px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: "linear-gradient(180deg, color-mix(in srgb, var(--color-fg) 2%, transparent), transparent)",
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {Icon ? <Icon size={embedded ? 12 : 14} weight="fill" style={{ color: COLORS.accent, flexShrink: 0 }} /> : null}
            <span style={{ fontFamily: MONO_FONT, fontSize: embedded ? 9 : 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.textSecondary, flexShrink: 0 }}>
              {config.title.toUpperCase()}
            </span>
            {config.meta ? (
              <span
                className="truncate"
                style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}
                title={typeof config.meta === "string" ? config.meta : undefined}
              >
                {config.meta}
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1 overflow-x-auto">
            {config.headerActions}
          </div>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-hidden", config.bodyClassName)}>
          {config.children}
        </div>
      </section>
    );
  }, [paneConfigs, embedded]);

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col", embedded && "ade-files-page-embedded")}
      style={{ background: COLORS.pageBg }}
    >
      {/* Header bar — full Files tab only; Work sidebar uses the active session lane via preferredLaneId */}
      {!embedded ? (
      <div
        style={{
          padding: "0 24px",
          height: 64,
          display: "flex",
          alignItems: "center",
          gap: 20,
          background: "transparent",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
        data-tour="files.header"
      >
        {/* Numbered title group */}
        <div className="flex items-center gap-2 shrink-0">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.accent }}>03</span>
          <FolderOpen size={18} weight="fill" style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>FILES</span>
          <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{workspaces.length} WS</span>
        </div>

        {/* Workspace selector */}
        <div className="flex min-w-0 items-center gap-1" data-tour="files.workspaceSelector">
          <select
            value={workspaceId}
            title={activeWorkspaceSelectTitle}
            onChange={(e) => switchWorkspace(e.target.value)}
            style={{
              height: 32,
              padding: "0 12px",
              fontSize: 12,
              fontFamily: MONO_FONT, fontWeight: 600,
              color: COLORS.success, background: COLORS.recessedBg, borderRadius: 8,
              border: `1px solid ${COLORS.outlineBorder}`, cursor: "pointer", outline: "none",
              minWidth: 0,
              maxWidth: 280,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
          >
          {workspaceSelectOptions.map((opt) => (
            <option key={opt.id} value={opt.id} title={opt.title}>
              {opt.label}
            </option>
          ))}
          </select>
          <>
            <SmartTooltip
                content={
                  activeWorkspace?.laneId
                    ? {
                        label: "View lane",
                        description: "Open Lanes with this workspace's lane selected in single-lane focus.",
                      }
                    : {
                        label: "Lanes",
                        description: "Open the Lanes tab to browse and manage workspace lanes.",
                      }
                }
              >
                <button
                  type="button"
                  style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })}
                  onClick={() => {
                    const laneId = activeWorkspace?.laneId;
                    if (laneId) {
                      navigate(`/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`);
                    } else {
                      navigate("/lanes");
                    }
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                >
                View lane
              </button>
            </SmartTooltip>
          </>
        </div>

        {/* Read-only badge */}
        {activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? (
          <span style={inlineBadge(COLORS.warning, { fontSize: 9, gap: 4, display: "inline-flex", alignItems: "center" })}>
            <AlertTriangle size={10} weight="fill" /> READ-ONLY
          </span>
        ) : null}

        {/* Trust / edit toggle */}
        {activeWorkspace?.isReadOnlyByDefault ? (
          <SmartTooltip content={{ label: allowPrimaryEdit ? "Disable Edits" : "Trust & Edit", description: allowPrimaryEdit ? "Lock the editor to prevent changes to the primary workspace." : "Unlock the editor to make changes directly on the primary workspace.", warning: allowPrimaryEdit ? undefined : "You will be editing the primary workspace directly" }}>
            <button
              type="button"
              style={allowPrimaryEdit ? dangerButton({ height: 28, padding: "0 10px", fontSize: 9 }) : outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })}
              onClick={() => setAllowPrimaryEdit((v) => !v)}
              onMouseEnter={(e) => { if (!allowPrimaryEdit) { e.currentTarget.style.borderColor = COLORS.warning; e.currentTarget.style.color = COLORS.warning; } }}
              onMouseLeave={(e) => { if (!allowPrimaryEdit) { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; } }}
            >
              {allowPrimaryEdit ? "DISABLE EDITS" : "TRUST & EDIT"}
            </button>
          </SmartTooltip>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1, height: 1 }} />

        <>
        <SmartTooltip content={{ label: "Toggle Theme", description: "Switch the editor between light and dark theme." }}>
          <button
            type="button"
            data-testid="files-editor-theme-toggle"
            aria-label={editorTheme === "dark" ? "Switch editor to light theme" : "Switch editor to dark theme"}
            title={editorTheme === "dark" ? "Switch editor to light theme" : "Switch editor to dark theme"}
            style={{
              ...outlineButton({ height: 28, width: 28, padding: 0, fontSize: 9 }),
              flexShrink: 0,
            }}
            onClick={() => setEditorTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            {editorTheme === "dark" ? (
              <Sun size={16} weight="bold" aria-hidden />
            ) : (
              <Moon size={16} weight="bold" aria-hidden />
            )}
          </button>
        </SmartTooltip>

        {/* Open in external editor */}
        <div className="relative shrink-0" ref={openInMenuRef} data-tour="files.openIn">
          <SmartTooltip content={{ label: "Open In", description: "Open the current file in an external editor or file browser." }}>
            <button
              type="button"
              style={{
                ...outlineButton({ height: 28, padding: "0 10px", fontSize: 9 }),
                opacity: (!activeWorkspace || !activeTabPath) ? 0.35 : 1,
              }}
              onClick={() => setOpenInMenuOpen((prev) => !prev)}
              disabled={!activeWorkspace || !activeTabPath}
              title={activeTabPath ? "Open current file in an external app" : "Open a file first"}
              onMouseEnter={(e) => { if (activeWorkspace && activeTabPath) { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; } }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
            >
              <ArrowSquareOut size={12} weight="regular" /> OPEN IN
            </button>
          </SmartTooltip>
          {openInMenuOpen ? (
            <div className="ade-liquid-glass-menu absolute right-0 top-full z-50 mt-1 overflow-hidden" style={{ width: 220, padding: "2px 0" }}>
              {(
                [
                  { key: "default", label: "SYSTEM DEFAULT" },
                  { key: "finder", label: revealLabel.toUpperCase() },
                  { key: "vscode", label: "VS CODE" },
                  { key: "cursor", label: "CURSOR" },
                  { key: "zed", label: "ZED" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  style={{
                    padding: "8px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px",
                    color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; e.currentTarget.style.color = COLORS.textPrimary; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textSecondary; }}
                  onClick={() => void openActivePathInExternalTool(item.key)}
                >
                  <ArrowSquareOut size={12} /> {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* File count stat */}
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {openTabs.length} OPEN
        </span>
        </>
      </div>
      ) : null}

      {/* Warning banners */}
      {!embedded && ((activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit) || (activeWorkspace?.kind === "primary" && suggestedLaneWorkspace)) ? (
        <div className="flex flex-wrap items-center gap-3 shrink-0" style={{
          padding: "6px 24px",
          borderBottom: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
          background: activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? "color-mix(in srgb, var(--color-warning) 15%, transparent)" : "color-mix(in srgb, var(--color-warning) 8%, transparent)",
        }}>
          <AlertTriangle size={14} weight="fill" style={{ color: COLORS.warning, flexShrink: 0 }} />
          {activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.warning }}>
              PRIMARY WORKSPACE IS READ-ONLY. USE "TRUST & EDIT" TO UNLOCK.
            </span>
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.warning }}>
              EDITING DIRECTLY IN PRIMARY. LANE WORKSPACES ARE SAFER.
            </span>
          )}
          {suggestedLaneWorkspace ? (
            <button
              type="button"
              style={primaryButton({ height: 24, padding: "0 10px", fontSize: 9 })}
              onClick={() => switchWorkspace(suggestedLaneWorkspace.id)}
            >
              SWITCH TO: {suggestedLaneWorkspace.name.toUpperCase()}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Error banner */}
      {error ? (
        <div className="flex items-center gap-2 shrink-0" style={{
          padding: "6px 24px",
          borderBottom: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
          background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
        }}>
          <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>{error}</span>
          <button
            type="button"
            style={{ background: "transparent", border: "none", padding: "0 4px", color: COLORS.danger, cursor: "pointer", fontSize: 14, marginLeft: "auto" }}
            onClick={() => setError(null)}
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}

      {/* Static split layout for Files. This intentionally bypasses the shared
          tiling shell while Files-route crashes are under investigation. */}
      <div className={cn("ade-files-layout flex-1 min-h-0", embedded ? "p-1.5" : "p-3")}>
        <div className={cn("flex h-full min-h-0 min-w-0 flex-row", embedded ? "gap-2" : "gap-3")}>
          <div
            className={cn("ade-files-explorer-pane min-h-0 min-w-0 shrink-0", embedded && "basis-[36%]")}
            style={embedded ? { minWidth: 108, maxWidth: 168 } : { width: 320, maxWidth: "28vw" }}
            data-tour="files.explorerPane"
          >
            {renderPane("explorer")}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 min-w-0 flex-1" style={{ minHeight: 0 }} data-tour="files.editorPane">
              {renderPane("editor")}
            </div>
          </div>
        </div>
      </div>

      {/* Context menu overlay */}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="ade-liquid-glass-menu fixed z-40"
          style={{
            left: contextMenuPosition?.left ?? contextMenu.x,
            top: contextMenuPosition?.top ?? contextMenu.y,
            minWidth: FILES_CONTEXT_MENU_WIDTH,
            maxHeight: `calc(100vh - ${FILES_CONTEXT_MENU_INSET * 2}px)`,
            overflowY: "auto",
            padding: "4px 0",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeType === "file" ? (
            <>
              <div style={{ ...LABEL_STYLE, padding: "4px 12px", fontSize: 8 }}>FILE</div>
              {[
                { label: "OPEN", action: async () => { await openFile(contextMenu.nodePath); }, color: COLORS.textSecondary },
                { label: "OPEN DIFF", action: async () => { await openFile(contextMenu.nodePath); setMode("diff"); }, color: COLORS.info },
              ].map((item) => (
                <button
                  key={item.label}
                  className="flex w-full items-center text-left"
                  style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: item.color, background: "transparent", border: "none", cursor: "pointer" }}
                  onClick={() => runContextAction(item.action)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {item.label}
                </button>
              ))}
              {laneIdForWorkspace ? (
                <>
                  <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                  <div style={{ ...LABEL_STYLE, padding: "4px 12px", fontSize: 8 }}>GIT</div>
                  <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.success, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => stagePath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>STAGE</button>
                  <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.warning, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => unstagePath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>UNSTAGE</button>
                  <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => discardPath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>DISCARD</button>
                </>
              ) : null}
            </>
          ) : null}

          <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
          <div style={{ ...LABEL_STYLE, padding: "4px 12px", fontSize: 8 }}>FILE OPS</div>
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => { setContextMenu(null); window.ade.app.writeClipboardText(contextMenu.nodePath).catch((err) => setError(err instanceof Error ? err.message : String(err))); }} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>COPY PATH</button>
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => { setContextMenu(null); if (activeWorkspace) window.ade.app.revealPath(`${activeWorkspace.rootPath}/${contextMenu.nodePath}`).catch(() => {}); }} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>{revealLabel.toUpperCase()}</button>
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => createFileAt(contextMenu.nodeType === "directory" ? contextMenu.nodePath : parentDirOfPath(contextMenu.nodePath)))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>NEW FILE</button>
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => createDirectoryAt(contextMenu.nodeType === "directory" ? contextMenu.nodePath : parentDirOfPath(contextMenu.nodePath)))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>NEW FOLDER</button>
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.accent, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => { const path = contextMenu.nodePath; setContextMenu(null); setInlineRenameRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 })); }} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>RENAME</button>
          <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "0.5px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => deletePath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--color-error) 18%, transparent)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>DELETE</button>
        </div>
      ) : null}

      {/* Quick Open overlay */}
      {showQuickOpen ? (
        <div className="absolute inset-0 z-30 flex items-start justify-center" style={{ background: "rgba(0,0,0,0.6)", paddingTop: 80 }}>
          <div style={{ width: 640, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.border}`, borderRadius: 16, padding: 16 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 8, fontSize: 9 }}>QUICK OPEN</div>
            <div className="relative flex items-center">
              <Search size={14} weight="regular" className="pointer-events-none absolute" style={{ left: 10, color: COLORS.textDim }} />
              <input
                autoFocus
                value={quickOpen}
                onChange={(e) => setQuickOpen(e.target.value)}
                placeholder={`Type to search files... (${modifierKeyLabel}+P)`}
                style={{
                  height: 36, width: "100%", padding: "0 36px 0 32px",
                  fontSize: 12, fontFamily: MONO_FONT, fontWeight: 500,
                  background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`,
                  borderRadius: 8, color: COLORS.textPrimary, outline: "none",
                  letterSpacing: "0.3px",
                }}
                onKeyDown={(e) => { if (e.key === "Escape") setShowQuickOpen(false); }}
              />
              <button
                type="button"
                className="absolute"
                style={{ right: 8, ...outlineButton({ height: 22, padding: "0 6px", fontSize: 8 }) }}
                onClick={() => setShowQuickOpen(false)}
              >ESC</button>
            </div>
            <div className="mt-2 max-h-[40vh] overflow-auto" style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, borderRadius: 8 }}>
              {quickOpenResults.map((item) => {
                const qoFileIcon = getFileIcon(item.path.split("/").pop() ?? "");
                const QoIcon = qoFileIcon.icon;
                return (
                  <button
                    key={item.path}
                    className="flex w-full items-center gap-2 text-left"
                    style={{ padding: "8px 12px", fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                    onClick={() => { openFile(item.path).catch(() => {}); setShowQuickOpen(false); }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; e.currentTarget.style.color = COLORS.textPrimary; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textSecondary; }}
                  >
                    <QoIcon size={14} style={{ color: qoFileIcon.color, flexShrink: 0 }} />
                    <span className="truncate">{item.path}</span>
                  </button>
                );
              })}
              {!quickOpenResults.length ? <div style={{ padding: "12px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>NO MATCHES</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Content Search overlay */}
      {showContentSearch ? (
        <div className="absolute inset-0 z-30 flex items-start justify-center" style={{ background: "rgba(0,0,0,0.6)", paddingTop: 80 }}>
          <div style={{ width: 720, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.border}`, borderRadius: 16, padding: 16 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 8, fontSize: 9 }}>CONTENT SEARCH</div>
            <div className="relative flex items-center">
              <Search size={14} weight="regular" className="pointer-events-none absolute" style={{ left: 10, color: COLORS.textDim }} />
              <input
                ref={contentSearchInputRef}
                value={contentSearchQuery}
                onChange={(e) => setContentSearchQuery(e.target.value)}
                placeholder={`Search file contents... (${modifierKeyLabel}+Shift+F)`}
                style={{
                  height: 36, width: "100%", padding: "0 36px 0 32px",
                  fontSize: 12, fontFamily: MONO_FONT, fontWeight: 500,
                  background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`,
                  borderRadius: 8, color: COLORS.textPrimary, outline: "none",
                  letterSpacing: "0.3px",
                }}
                onKeyDown={(e) => { if (e.key === "Escape") setShowContentSearch(false); }}
              />
              <button
                type="button"
                className="absolute"
                style={{ right: 8, ...outlineButton({ height: 22, padding: "0 6px", fontSize: 8 }) }}
                onClick={() => setShowContentSearch(false)}
              >ESC</button>
            </div>
            <div className="mt-2 max-h-[46vh] overflow-auto" style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, borderRadius: 8 }}>
              {contentSearchResults.map((item, idx) => {
                const srIcon = getFileIcon(item.path.split("/").pop() ?? "");
                const SrIcon = srIcon.icon;
                return (
                  <button
                    key={`${item.path}:${item.line}:${idx}`}
                    className="flex w-full items-start gap-2 text-left"
                    style={{ padding: "8px 12px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                    onClick={() => {
                      openFile(item.path).catch(() => {});
                      setShowContentSearch(false);
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; e.currentTarget.style.color = COLORS.textPrimary; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = COLORS.textSecondary; }}
                  >
                    <SrIcon size={12} style={{ color: srIcon.color, flexShrink: 0, marginTop: 2 }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate" style={{ fontWeight: 600, color: COLORS.textPrimary }}>{item.path}:{item.line}:{item.column}</div>
                      <div className="truncate" style={{ color: COLORS.textMuted, fontSize: 10 }}>{item.preview}</div>
                    </div>
                  </button>
                );
              })}
              {!contentSearchResults.length ? (
                <div style={{ padding: "12px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
                  {contentSearchQuery.trim() ? "NO MATCHES" : "TYPE TO SEARCH CONTENTS"}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Text prompt modal */}
      {textPrompt ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", padding: 16 }}>
          <div style={{ width: 520, maxWidth: "100%", background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.border}`, borderRadius: 16, overflow: "hidden" }}>
            {/* Modal header */}
            <div style={{ height: 48, padding: "0 16px", display: "flex", alignItems: "center", background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={{ fontFamily: SANS_FONT, fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>{textPrompt.title.toUpperCase()}</span>
            </div>
            {/* Modal body */}
            <div style={{ padding: 20 }}>
              {textPrompt.message ? (
                <div style={{ marginBottom: 12, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>{textPrompt.message}</div>
              ) : null}
              <input
                autoFocus
                value={textPrompt.value}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
                  if (textPromptError) setTextPromptError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); cancelTextPrompt(); return; }
                  if (event.key === "Enter") { event.preventDefault(); submitTextPrompt(); }
                }}
                placeholder={textPrompt.placeholder}
                style={{
                  height: 36, width: "100%", padding: "0 12px",
                  fontSize: 12, fontFamily: MONO_FONT, borderRadius: 8,
                  background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`,
                  color: COLORS.textPrimary, outline: "none",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
              />
              {textPromptError ? (
                <div style={{ marginTop: 8, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>{textPromptError}</div>
              ) : null}
            </div>
            {/* Modal footer */}
            <div style={{ height: 56, padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, background: COLORS.recessedBg, borderTop: `1px solid ${COLORS.border}` }}>
              <button type="button" style={outlineButton()} onClick={cancelTextPrompt}>CANCEL</button>
              <button type="button" style={primaryButton()} onClick={submitTextPrompt}>{textPrompt.confirmLabel.toUpperCase()}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilesDiffPanel({
  active = true,
  laneId,
  path,
  theme,
  diffViewRef,
}: {
  active?: boolean;
  laneId: string;
  path: string;
  theme: EditorThemeMode;
  diffViewRef?: React.MutableRefObject<AdeDiffViewerHandle | null>;
}) {
  const [mode, setMode] = useState<"unstaged" | "staged" | "commit">("unstaged");
  const [diff, setDiff] = useState<any>(null);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [compareRef, setCompareRef] = useState<string>("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setCompareRef("");
    window.ade.git.listRecentCommits({ laneId, limit: 30 })
      .then((rows) => {
        if (cancelled) return;
        setCommits(rows);
        setCompareRef(rows[0]?.sha ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        setCommits([]);
        setCompareRef("");
      });
    return () => {
      cancelled = true;
    };
  }, [active, laneId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);

    const load = async () => {
      if (mode === "commit" && !compareRef.trim()) {
        setDiff(null);
        setPatch(null);
        return;
      }

      const args = {
        laneId,
        path,
        mode,
        compareRef: mode === "commit" ? compareRef : undefined
      } as const;
      const [nextDiff, nextPatch] = await Promise.allSettled([
        window.ade.diff.getFile(args),
        window.ade.diff.getFilePatch(args),
      ]);
      if (cancelled) return;
      const resolvedDiff = nextDiff.status === "fulfilled" ? nextDiff.value : null;
      const resolvedPatch = nextPatch.status === "fulfilled" && filePatchHasRenderableChanges(nextPatch.value) ? nextPatch.value : null;
      const hasRenderableDiff = resolvedDiff ? fileDiffHasRenderableChanges(resolvedDiff) : false;
      if (!resolvedPatch && !hasRenderableDiff) {
        if (nextDiff.status === "rejected") throw nextDiff.reason;
        if (nextPatch.status === "rejected") throw nextPatch.reason;
      }
      setDiff(resolvedDiff);
      setPatch(resolvedPatch);
    };

    load().catch((err) => {
      if (cancelled) return;
      setDiff(null);
      setPatch(null);
      setError(settledErrorMessage(err));
    });

    return () => {
      cancelled = true;
    };
  }, [active, laneId, path, mode, compareRef]);

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 12 }}>
      <div className="flex items-center gap-2" style={{ padding: "6px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
        {/* Mode toggle group */}
        <div className="inline-flex items-center" style={{ border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, overflow: "hidden" }}>
          {(["unstaged", "staged", "commit"] as const).map((m) => {
            const label = m === "unstaged" ? "WORKING TREE" : m === "staged" ? "STAGED" : "COMMIT";
            const isActive = mode === m;
            return (
              <button
                key={m}
                type="button"
                style={{
                  height: 24, padding: "0 10px",
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
                  color: isActive ? COLORS.pageBg : COLORS.textMuted,
                  background: isActive ? COLORS.accent : "transparent",
                  border: "none", cursor: "pointer",
                }}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            );
          })}
        </div>

        {mode === "commit" ? (
          <select
            value={compareRef}
            onChange={(e) => setCompareRef(e.target.value)}
            style={{
              height: 28, padding: "0 8px", fontSize: 11, fontFamily: MONO_FONT,
              background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`,
              color: COLORS.textSecondary, cursor: "pointer", outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
          >
            {commits.map((commit) => (
              <option key={commit.sha} value={commit.sha}>
                {commit.shortSha} - {commit.subject}
              </option>
            ))}
          </select>
        ) : null}

        <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted, marginLeft: "auto" }}>{path}</span>
      </div>

      {error ? <div style={{ padding: 12, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>{error}</div> : null}
      <div className="min-h-0 flex-1">
        {patch || (diff && fileDiffHasRenderableChanges(diff)) ? (
          <AdeDiffViewer ref={diffViewRef} diff={diff} patch={patch} className="h-full" theme={theme} />
        ) : diff ? (
          <div className="flex h-full items-center justify-center px-4 text-xs" style={{ color: COLORS.textMuted }}>
            No changes for this file.
          </div>
        ) : null}
      </div>
    </div>
  );
}
