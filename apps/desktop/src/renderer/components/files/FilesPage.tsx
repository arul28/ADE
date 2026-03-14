import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Warning as AlertTriangle,
  BookOpenText,
  ArrowSquareOut,
  CaretDown as ChevronDown,
  CaretRight as ChevronRight,
  FileZip as FileArchive,
  FileCss as FileBraces,
  GearSix as FileCog,
  FileTs as FileCode2,
  FileImage,
  FilePlus as FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FloppyDisk as Save,
  MagnifyingGlass as Search,
  Sparkle as Sparkles,
  Terminal as TerminalSquare,
  FileXls as FileSpreadsheet,
  X,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  FileTreeNode,
  FilesQuickOpenItem,
  FilesSearchTextMatch,
  FilesWorkspace,
  GitCommitSummary
} from "../../../shared/types";
import { MonacoDiffView } from "../lanes/MonacoDiffView";
import { LaneTerminalsPanel } from "../lanes/LaneTerminalsPanel";
import { useAppStore } from "../../state/appStore";
import { PaneTilingLayout } from "../ui/PaneTilingLayout";
import { revealLabel } from "../../lib/platform";
import type { PaneConfig, PaneSplit } from "../ui/PaneTilingLayout";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, inlineBadge, outlineButton, primaryButton, dangerButton, cardStyle } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";
type OpenTab = {
  path: string;
  content: string;
  savedContent: string;
  languageId: string;
  isBinary: boolean;
};

type FilesPageNavState = {
  openFilePath?: string;
  laneId?: string;
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
type ExternalEditorTarget = "finder" | "vscode" | "cursor" | "zed";

type FilesPageSessionState = {
  workspaceId: string;
  allowPrimaryEdit: boolean;
  selectedNodePath: string | null;
  openTabs: OpenTab[];
  activeTabPath: string | null;
  mode: EditorViewMode;
  searchQuery: string;
  editorTheme: EditorThemeMode;
};

const filesPageSessionByScope = new Map<string, FilesPageSessionState>();

function filesSessionKey(projectRoot: string, laneId: string | null): string {
  return `${projectRoot}::${laneId ?? "__primary__"}`;
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
      const EditorWorker = (await import("monaco-editor/esm/vs/editor/editor.worker?worker")).default;
      const globalAny = globalThis as typeof globalThis & {
        MonacoEnvironment?: {
          getWorker?: (workerId: string, label: string) => Worker;
        };
      };
      const existing = globalAny.MonacoEnvironment;
      globalAny.MonacoEnvironment = {
        ...existing,
        getWorker: existing?.getWorker ?? (() => new EditorWorker())
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
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

const FILE_ICON_COLORS = {
  code: "#38BDF8",       // sky-400
  json: "#34D399",       // emerald-400
  config: "#FB923C",     // orange-400
  markdown: "#FBBF24",   // amber-400
  style: "#818CF8",      // indigo-400
  shell: "#2DD4BF",      // teal-400
  image: "#E879F9",      // fuchsia-400
  archive: "#FB7185",    // rose-400
  spreadsheet: "#4ADE80", // green-400
  default: COLORS.textMuted,
} as const;

function getFileIcon(fileName: string): { icon: React.ComponentType<any>; color: string } {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".mts" ||
    ext === ".cts" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return { icon: FileCode2, color: FILE_ICON_COLORS.code };
  }
  if (ext === ".json" || ext === ".jsonc") {
    return { icon: FileBraces, color: FILE_ICON_COLORS.json };
  }
  if (ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".ini") {
    return { icon: FileCog, color: FILE_ICON_COLORS.config };
  }
  if (ext === ".md" || ext === ".mdx") {
    return { icon: BookOpenText, color: FILE_ICON_COLORS.markdown };
  }
  if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") {
    return { icon: FileCode2, color: FILE_ICON_COLORS.style };
  }
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh" || ext === ".fish" || ext === ".ps1") {
    return { icon: TerminalSquare, color: FILE_ICON_COLORS.shell };
  }
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".svg" || ext === ".ico") {
    return { icon: FileImage, color: FILE_ICON_COLORS.image };
  }
  if (ext === ".zip" || ext === ".tar" || ext === ".gz" || ext === ".tgz" || ext === ".rar" || ext === ".7z") {
    return { icon: FileArchive, color: FILE_ICON_COLORS.archive };
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".xls" || ext === ".xlsx") {
    return { icon: FileSpreadsheet, color: FILE_ICON_COLORS.spreadsheet };
  }
  return { icon: FileText, color: FILE_ICON_COLORS.default };
}

function changeStatusColor(changeStatus: FileTreeNode["changeStatus"]): string {
  if (changeStatus === "A") return COLORS.success;
  if (changeStatus === "D") return COLORS.danger;
  if (changeStatus === "M") return COLORS.warning;
  return COLORS.textDim;
}

/* ---- Floating-pane tiling layout for Files ---- */

const FILES_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    {
      node: { type: "pane", id: "explorer" },
      defaultSize: 22,
      minSize: 12
    },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          {
            node: { type: "pane", id: "editor" },
            defaultSize: 68,
            minSize: 25
          },
          {
            node: { type: "pane", id: "terminals" },
            defaultSize: 32,
            minSize: 10
          }
        ]
      },
      defaultSize: 78,
      minSize: 40
    }
  ]
};

export function FilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const projectRootPath = useAppStore((s) => s.project?.rootPath ?? "__unknown_project__");
  const sessionKey = filesSessionKey(projectRootPath, selectedLaneId);
  const initialSession = filesPageSessionByScope.get(sessionKey);

  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>(initialSession?.workspaceId ?? "");
  const [allowPrimaryEdit, setAllowPrimaryEdit] = useState(initialSession?.allowPrimaryEdit ?? false);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(initialSession?.selectedNodePath ?? null);
  const pendingOpenRef = useRef<{ filePath: string; laneId: string | null; key: string } | null>(null);
  const treeRefreshStateRef = useRef<{
    inFlight: boolean;
    queuedFull: boolean;
    queuedParents: Set<string>;
  }>({
    inFlight: false,
    queuedFull: false,
    queuedParents: new Set<string>()
  });
  const watcherRefreshTimerRef = useRef<number | null>(null);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => initialSession?.openTabs.map((tab) => ({ ...tab })) ?? []);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(initialSession?.activeTabPath ?? null);
  const [mode, setMode] = useState<EditorViewMode>(initialSession?.mode ?? "edit");
  const [editorTheme, setEditorTheme] = useState<EditorThemeMode>(initialSession?.editorTheme ?? readStoredEditorTheme());

  const [quickOpen, setQuickOpen] = useState("");
  const [quickOpenResults, setQuickOpenResults] = useState<FilesQuickOpenItem[]>([]);
  const [showQuickOpen, setShowQuickOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState(initialSession?.searchQuery ?? "");
  const [searchResults, setSearchResults] = useState<FilesSearchTextMatch[]>([]);

  const [resolvedConflictKeys, setResolvedConflictKeys] = useState<Set<string>>(new Set());
  const [textPrompt, setTextPrompt] = useState<TextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<"loading" | "ready" | "failed">("loading");
  // PaneTilingLayout mounts panes async, so the editor host can appear after the first effect pass.
  const [editorHostEl, setEditorHostEl] = useState<HTMLDivElement | null>(null);

  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<import("monaco-editor").editor.ITextModel | null>(null);
  const modelKeyRef = useRef<string | null>(null);
  const editorApplyingRef = useRef(false);
  const activeTabPathRef = useRef<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const openInMenuRef = useRef<HTMLDivElement | null>(null);
  const setEditorHostRef = useCallback((node: HTMLDivElement | null) => {
    setEditorHostEl(node);
  }, []);

  const activeWorkspace = useMemo(() => workspaces.find((ws) => ws.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const activeTab = useMemo(() => openTabs.find((tab) => tab.path === activeTabPath) ?? null, [openTabs, activeTabPath]);
  const canEdit = Boolean(activeWorkspace) && (!activeWorkspace?.isReadOnlyByDefault || allowPrimaryEdit);

  const prevSessionKeyRef = useRef(sessionKey);

  useEffect(() => {
    if (prevSessionKeyRef.current === sessionKey) return;
    // Save current state under the old scope before switching
    filesPageSessionByScope.set(prevSessionKeyRef.current, {
      workspaceId,
      allowPrimaryEdit,
      selectedNodePath,
      openTabs: openTabs.map((tab) => ({ ...tab })),
      activeTabPath,
      mode,
      searchQuery,
      editorTheme,
    });
    prevSessionKeyRef.current = sessionKey;
    // Restore state for the new scope (project + lane)
    const session = filesPageSessionByScope.get(sessionKey);
    setWorkspaceId(session?.workspaceId ?? "");
    setAllowPrimaryEdit(session?.allowPrimaryEdit ?? false);
    setSelectedNodePath(session?.selectedNodePath ?? null);
    setOpenTabs(session?.openTabs.map((tab) => ({ ...tab })) ?? []);
    setActiveTabPath(session?.activeTabPath ?? null);
    setMode(session?.mode ?? "edit");
    setSearchQuery(session?.searchQuery ?? "");
    setEditorTheme(session?.editorTheme ?? readStoredEditorTheme());
  }, [sessionKey]);

  const hasUnsavedTabs = useMemo(
    () => openTabs.some((tab) => tab.content !== tab.savedContent),
    [openTabs]
  );

  useEffect(() => {
    filesPageSessionByScope.set(sessionKey, {
      workspaceId,
      allowPrimaryEdit,
      selectedNodePath,
      openTabs: openTabs.map((tab) => ({ ...tab })),
      activeTabPath,
      mode,
      searchQuery,
      editorTheme
    });
  }, [sessionKey, workspaceId, allowPrimaryEdit, selectedNodePath, openTabs, activeTabPath, mode, searchQuery, editorTheme]);

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

  const switchWorkspace = useCallback((nextWorkspaceId: string) => {
    if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
    if (hasUnsavedTabs) {
      const ok = window.confirm("You have unsaved changes. Switch workspace anyway?");
      if (!ok) return;
    }
    setWorkspaceId(nextWorkspaceId);
    setOpenTabs([]);
    setActiveTabPath(null);
    setSelectedNodePath(null);
  }, [workspaceId, hasUnsavedTabs]);

  const activeContextPath = contextMenu?.nodePath ?? selectedNodePath ?? activeTabPath;
  const nodeByPath = useMemo(() => {
    const out = new Map<string, FileTreeNode>();
    const walk = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        out.set(node.path, node);
        if (node.children?.length) walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);
  const activeContextNodeType = contextMenu?.nodeType ?? (activeContextPath ? nodeByPath.get(activeContextPath)?.type : undefined);
  const laneWorkspaces = useMemo(() => workspaces.filter((ws) => ws.kind !== "primary"), [workspaces]);
  const suggestedLaneWorkspace = useMemo(() => {
    if (!laneWorkspaces.length) return null;
    if (selectedLaneId) {
      const fromSelectedLane = laneWorkspaces.find((ws) => ws.laneId === selectedLaneId);
      if (fromSelectedLane) return fromSelectedLane;
    }
    return laneWorkspaces[0] ?? null;
  }, [laneWorkspaces, selectedLaneId]);

  useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  useEffect(() => {
    const st = (location.state as FilesPageNavState | null) ?? null;
    const openFilePath = st?.openFilePath?.trim();
    if (!openFilePath) return;
    pendingOpenRef.current = { key: location.key, filePath: openFilePath, laneId: st?.laneId ?? null };
  }, [location.key, location.state]);

  const refreshTreeNow = useCallback(async (parentPath?: string) => {
    if (!workspaceId) return;
    try {
      const nodes = await window.ade.files.listTree({
        workspaceId,
        parentPath,
        depth: parentPath ? 1 : 2
      });
      if (!parentPath) {
        setTree(nodes);
        return;
      }

      const merge = (items: FileTreeNode[]): FileTreeNode[] =>
        items.map((item) => {
          if (item.path === parentPath) return { ...item, children: nodes };
          if (item.children?.length) return { ...item, children: merge(item.children) };
          return item;
        });
      setTree((prev) => merge(prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  const refreshTree = useCallback(async (parentPath?: string) => {
    if (!workspaceId) return;
    const normalizedParent = parentPath?.trim() ? parentPath : undefined;
    const state = treeRefreshStateRef.current;
    if (state.inFlight) {
      if (!normalizedParent) {
        state.queuedFull = true;
        state.queuedParents.clear();
      } else if (!state.queuedFull) {
        state.queuedParents.add(normalizedParent);
      }
      return;
    }
    state.inFlight = true;
    try {
      let nextParent: string | undefined = normalizedParent;
      while (true) {
        await refreshTreeNow(nextParent);
        if (state.queuedFull) {
          state.queuedFull = false;
          state.queuedParents.clear();
          nextParent = undefined;
          continue;
        }
        const [queuedParent] = state.queuedParents;
        if (queuedParent) {
          state.queuedParents.delete(queuedParent);
          nextParent = queuedParent;
          continue;
        }
        break;
      }
    } finally {
      state.inFlight = false;
    }
  }, [refreshTreeNow, workspaceId]);

  const scheduleTreeRefresh = useCallback((parentPath?: string, delayMs = 140) => {
    const normalizedParent = parentPath?.trim() ? parentPath : undefined;
    if (normalizedParent) {
      const state = treeRefreshStateRef.current;
      if (!state.queuedFull) {
        state.queuedParents.add(normalizedParent);
      }
    }
    if (watcherRefreshTimerRef.current != null) return;
    watcherRefreshTimerRef.current = window.setTimeout(() => {
      watcherRefreshTimerRef.current = null;
      void refreshTree(normalizedParent).catch(() => {});
    }, delayMs);
  }, [refreshTree]);

  const openFile = useCallback(async (filePath: string, options: { forceReload?: boolean; preserveMode?: boolean } = {}) => {
    if (!workspaceId) return;
    try {
      const loaded = await window.ade.files.readFile({ workspaceId, path: filePath });
      if (loaded.isBinary) {
        setError("Binary files are read-only and cannot be edited in this view.");
      }
      setOpenTabs((prev) => {
        const existing = prev.find((tab) => tab.path === filePath);
        if (existing && !options.forceReload) return prev;
        if (existing && options.forceReload) {
          return prev.map((tab) => (
            tab.path === filePath
              ? {
                ...tab,
                content: loaded.content,
                savedContent: loaded.content,
                languageId: loaded.languageId,
                isBinary: loaded.isBinary
              }
              : tab
          ));
        }
        return [
          ...prev,
          {
            path: filePath,
            content: loaded.content,
            savedContent: loaded.content,
            languageId: loaded.languageId,
            isBinary: loaded.isBinary
          }
        ];
      });
      if (!options.preserveMode) {
        setMode("edit");
      }
      setActiveTabPath(filePath);
      setSelectedNodePath(filePath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (!workspaces.length) return;

    const desiredWorkspaceId =
      pending.laneId != null
        ? workspaces.find((ws) => ws.kind !== "primary" && ws.laneId === pending.laneId)?.id ?? null
        : null;
    const targetWorkspaceId = desiredWorkspaceId ?? workspaceId;
    if (targetWorkspaceId && targetWorkspaceId !== workspaceId) {
      switchWorkspace(targetWorkspaceId);
      return;
    }
    if (!workspaceId) return;

    openFile(pending.filePath).catch(() => {});
    pendingOpenRef.current = null;
    navigate(location.pathname, { replace: true, state: null });
  }, [workspaces, workspaceId, switchWorkspace, openFile, navigate, location.pathname]);

  const closeTab = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const tab = prev.find((t) => t.path === filePath);
      if (!tab) return prev;
      if (tab.content !== tab.savedContent) {
        const ok = window.confirm(`"${filePath}" has unsaved changes. Close anyway?`);
        if (!ok) return prev;
      }
      const next = prev.filter((t) => t.path !== filePath);
      if (activeTabPath === filePath) {
        setActiveTabPath(next[next.length - 1]?.path ?? null);
      }
      return next;
    });
  }, [activeTabPath]);

  const saveActive = useCallback(async () => {
    if (!activeTab || !workspaceId || !canEdit || activeTab.isBinary) return;
    await window.ade.files.writeText({ workspaceId, path: activeTab.path, text: activeTab.content });
    setOpenTabs((prev) => prev.map((tab) => (tab.path === activeTab.path ? { ...tab, savedContent: tab.content } : tab)));
  }, [activeTab, workspaceId, canEdit]);

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
    if (activeTabPath === filePath) {
      await openFile(filePath, { forceReload: true });
    }
  }, [canEdit, laneIdForWorkspace, refreshTree, activeTabPath, openFile]);

  const renamePath = useCallback(async (targetPath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!workspaceId) return;
    const next = await requestTextInput({
      title: "Rename path",
      message: "Enter the new path.",
      defaultValue: targetPath,
      confirmLabel: "Rename",
      validate: (value) => {
        if (!value) return "Path is required.";
        if (value === targetPath) return "Path is unchanged.";
        return null;
      }
    });
    if (!next || next === targetPath) return;
    await window.ade.files.rename({ workspaceId, oldPath: targetPath, newPath: next });
    setOpenTabs((prev) => prev.map((tab) => (tab.path === targetPath ? { ...tab, path: next } : tab)));
    if (activeTabPath === targetPath) setActiveTabPath(next);
    setSelectedNodePath(next);
    await refreshTree();
  }, [canEdit, workspaceId, requestTextInput, activeTabPath, refreshTree]);

  const deletePath = useCallback(async (targetPath: string) => {
    if (!canEdit) {
      setError("Editing is disabled for the current workspace.");
      return;
    }
    if (!workspaceId) return;
    const ok = window.confirm(`Delete ${targetPath}?`);
    if (!ok) return;
    await window.ade.files.delete({ workspaceId, path: targetPath });
    setOpenTabs((prev) => prev.filter((tab) => tab.path !== targetPath));
    if (activeTabPath === targetPath) setActiveTabPath(null);
    setSelectedNodePath(null);
    await refreshTree();
  }, [canEdit, workspaceId, activeTabPath, refreshTree]);

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
    window.ade.files.listWorkspaces()
      .then((items) => {
        setWorkspaces(items);
        setWorkspaceId((current) => {
          if (current && items.some((workspace) => workspace.id === current)) return current;
          if (current) {
            setOpenTabs([]);
            setActiveTabPath(null);
            setSelectedNodePath(null);
          }
          return items[0]?.id ?? "";
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setExpanded(new Set());
    setContextMenu(null);
    treeRefreshStateRef.current.inFlight = false;
    treeRefreshStateRef.current.queuedFull = false;
    treeRefreshStateRef.current.queuedParents.clear();
    if (watcherRefreshTimerRef.current != null) {
      window.clearTimeout(watcherRefreshTimerRef.current);
      watcherRefreshTimerRef.current = null;
    }
    refreshTree().catch(() => {});
    window.ade.files.watchChanges({ workspaceId }).catch(() => {});

    const unsub = window.ade.files.onChange((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      if (ev.type === "renamed") {
        scheduleTreeRefresh(parentPathOf(ev.oldPath ?? ""));
        scheduleTreeRefresh(parentPathOf(ev.path));
        return;
      }
      scheduleTreeRefresh(parentPathOf(ev.path));
    });

    return () => {
      unsub();
      if (watcherRefreshTimerRef.current != null) {
        window.clearTimeout(watcherRefreshTimerRef.current);
        watcherRefreshTimerRef.current = null;
      }
      window.ade.files.stopWatching({ workspaceId }).catch(() => {});
    };
  }, [workspaceId, refreshTree, scheduleTreeRefresh]);

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
    const onWindowPointerDown = () => {
      if (contextMenu) setContextMenu(null);
    };
    window.addEventListener("pointerdown", onWindowPointerDown);
    return () => window.removeEventListener("pointerdown", onWindowPointerDown);
  }, [contextMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const activeTarget = e.target;
      const isTextInput = activeTarget instanceof HTMLInputElement || activeTarget instanceof HTMLTextAreaElement;

      if (e.key === "Escape") {
        setContextMenu(null);
        if (showQuickOpen) setShowQuickOpen(false);
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
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (isTextInput) return;

      if (e.key === "F2") {
        e.preventDefault();
        const target = selectedNodePath ?? activeTabPath;
        if (!target) return;
        renamePath(target).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive, activeTabPath, closeTab, renamePath, selectedNodePath, showQuickOpen, openInMenuOpen]);

  useEffect(() => {
    if (!quickOpen.trim()) {
      setQuickOpenResults([]);
      return;
    }
    if (!showQuickOpen) return;
    window.ade.files.quickOpen({ workspaceId, query: quickOpen, limit: 80 })
      .then(setQuickOpenResults)
      .catch(() => setQuickOpenResults([]));
  }, [quickOpen, workspaceId, showQuickOpen]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      window.ade.files.searchText({ workspaceId, query: searchQuery, limit: 200 })
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery, workspaceId]);

  useEffect(() => {
    if (mode !== "edit") return;
    if (!editorHostEl) return;
    if (editorRef.current) return;

    let disposed = false;
    setEditorStatus("loading");
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
        setOpenTabs((prev) => prev.map((tab) => (tab.path === targetPath ? { ...tab, content: next } : tab)));
      });
      setEditorStatus("ready");
    }).catch((err) => {
      if (disposed) return;
      setEditorStatus("failed");
      setError(`Monaco failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
    });

    return () => {
      disposed = true;
      try {
        editorRef.current?.setModel(null);
      } catch {
        // ignore
      }
      try {
        modelRef.current?.dispose();
      } catch {
        // ignore
      }
      try {
        editorRef.current?.dispose();
      } catch {
        // ignore
      }
      modelRef.current = null;
      modelKeyRef.current = null;
      editorRef.current = null;
    };
  }, [mode, editorHostEl, canEdit, editorTheme]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    monaco.editor.setTheme(editorTheme === "light" ? "vs" : "vs-dark");
  }, [editorTheme]);

  useEffect(() => {
    if (!editorRef.current || mode !== "edit") return;
    editorRef.current.updateOptions({ readOnly: !canEdit || Boolean(activeTab?.isBinary) });
  }, [mode, canEdit, activeTab?.isBinary]);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current || mode !== "edit") return;
    const editor = editorRef.current;
    if (!activeTab) {
      try {
        editor.setModel(null);
      } catch {
        // ignore
      }
      try {
        modelRef.current?.dispose();
      } catch {
        // ignore
      }
      modelRef.current = null;
      modelKeyRef.current = null;
      return;
    }
    const monaco = monacoRef.current;
    const language = activeTab.languageId || "plaintext";
    const modelKey = `${activeTab.path}::${language}`;
    if (modelRef.current && modelKeyRef.current === modelKey) {
      editor.updateOptions({ readOnly: !canEdit || activeTab.isBinary });
      return;
    }

    try {
      editor.setModel(null);
    } catch {
      // ignore
    }
    try {
      modelRef.current?.dispose();
    } catch {
      // ignore
    }
    modelRef.current = monaco.editor.createModel(activeTab.content, language);
    modelKeyRef.current = modelKey;
    editor.setModel(modelRef.current);
    editor.updateOptions({ readOnly: !canEdit || activeTab.isBinary });
  }, [activeTab?.path, activeTab?.languageId, activeTab?.isBinary, mode, canEdit]);

  useEffect(() => {
    if (!activeTab || !editorRef.current || mode !== "edit") return;
    const current = editorRef.current.getValue();
    if (current === activeTab.content) return;
    editorApplyingRef.current = true;
    editorRef.current.setValue(activeTab.content);
    editorApplyingRef.current = false;
  }, [activeTab?.path, activeTab?.content, mode]);

  useEffect(() => {
    setResolvedConflictKeys(new Set());
  }, [activeTabPath]);

  const renderTree = (nodes: FileTreeNode[], level = 0): React.ReactNode => (
    <div>
      {nodes.map((node) => {
        const isExpanded = expanded.has(node.path);
        const isActive = activeTabPath === node.path || selectedNodePath === node.path;
        const statusColor = changeStatusColor(node.changeStatus ?? null);
        const fileIcon = node.type === "file" ? getFileIcon(node.name) : null;
        const FileIcon = fileIcon?.icon;
        const folderColor = isActive ? COLORS.accent : COLORS.textMuted;

        return (
          <div key={node.path}>
            <button
              className="group relative flex w-full items-center gap-1.5 text-left transition-colors"
              style={{
                height: 26,
                paddingLeft: `${10 + level * 14}px`,
                paddingRight: 8,
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: isActive ? COLORS.textPrimary : COLORS.textSecondary,
                background: isActive ? COLORS.accentSubtle : "transparent",
                border: "none",
                borderLeft: isActive ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                cursor: "pointer",
              }}
              onClick={() => {
                setSelectedNodePath(node.path);
                if (node.type === "directory") {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                  if (!isExpanded && !node.children) refreshTree(node.path).catch(() => {});
                  return;
                }
                openFile(node.path).catch(() => {});
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedNodePath(node.path);
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  nodePath: node.path,
                  nodeType: node.type
                });
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = COLORS.hoverBg; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              title={node.path}
            >
              {level > 0 ? (
                <span className="pointer-events-none absolute inset-y-0 left-0">
                  {Array.from({ length: level }).map((_, idx) => (
                    <span
                      key={`${node.path}:guide:${idx}`}
                      className="absolute inset-y-0"
                      style={{ left: `${10 + idx * 14 + 5}px`, width: 1, background: `${COLORS.border}80` }}
                    />
                  ))}
                </span>
              ) : null}
              {node.type === "directory" ? (
                <>
                  {isExpanded
                    ? <ChevronDown size={12} weight="bold" style={{ color: folderColor, flexShrink: 0 }} />
                    : <ChevronRight size={12} weight="bold" style={{ color: folderColor, flexShrink: 0 }} />}
                  {isExpanded
                    ? <FolderOpen size={14} weight="fill" style={{ color: folderColor, flexShrink: 0 }} />
                    : <Folder size={14} weight="fill" style={{ color: folderColor, flexShrink: 0 }} />}
                </>
              ) : (
                <>
                  <span style={{ width: 12, flexShrink: 0 }} />
                  {FileIcon
                    ? <FileIcon size={14} weight="regular" style={{ color: fileIcon?.color, flexShrink: 0 }} />
                    : <FileText size={14} weight="regular" style={{ color: COLORS.textMuted, flexShrink: 0 }} />}
                </>
              )}
              <span className="truncate">{node.name}</span>
              {node.type === "directory" && node.changeStatus ? (
                <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
              ) : null}
              {node.type === "file" && node.changeStatus ? (
                <span style={{
                  marginLeft: "auto", flexShrink: 0,
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
                  color: statusColor,
                  padding: "1px 5px",
                  background: `${statusColor}18`,
                }}>{node.changeStatus}</span>
              ) : null}
            </button>
            {node.type === "directory" && isExpanded && node.children?.length ? renderTree(node.children, level + 1) : null}
          </div>
        );
      })}
    </div>
  );

  const breadcrumbs = activeTabPath ? activeTabPath.split("/") : [];
  const conflictHunks = activeTab ? parseConflictHunks(activeTab.content) : [];
  const laneIdForDiff = activeWorkspace?.laneId;
  const hasConflictMarkers = conflictHunks.length > 0;
  const activeContextNode = activeContextPath ? nodeByPath.get(activeContextPath) ?? null : null;
  const activeContextChangeStatus = activeContextNode?.changeStatus ?? null;
  const editorModeHint =
    mode === "edit"
      ? "Code view: edit the file directly."
      : mode === "diff"
        ? "Changes view: compare this file against unstaged, staged, or commit versions."
        : "Merge view: resolve conflict markers in this file.";

  const applyConflictResolution = (hunk: ConflictHunk, choice: "ours" | "theirs" | "both") => {
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
  };

  const activeContextDir = (() => {
    if (!activeContextPath) return "";
    if (contextMenu?.nodeType === "directory") return activeContextPath;
    return parentDirOfPath(activeContextPath);
  })();

  const runContextAction = (fn: () => Promise<void>) => {
    setContextMenu(null);
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  /* ---- Pane configs for the floating tiling layout ---- */

  const paneConfigs: Record<string, PaneConfig> = useMemo(() => ({
    explorer: {
      title: "Explorer",
      icon: FolderOpen,
      meta: activeWorkspace?.name,
      minimizable: true,
      headerActions: (
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="New file"
            style={{ ...outlineButton({ height: 24, padding: "0 6px", fontSize: 10 }) }}
            onClick={() => createFileAt(activeContextDir).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <FilePlus2 size={12} weight="regular" />
          </button>
          <button
            type="button"
            title="New folder"
            style={{ ...outlineButton({ height: 24, padding: "0 6px", fontSize: 10 }) }}
            onClick={() => createDirectoryAt(activeContextDir).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <FolderPlus size={12} weight="regular" />
          </button>
        </div>
      ),
      bodyClassName: "flex min-h-0 flex-col overflow-hidden",
      children: (
        <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 12 }}>
          {/* Search bar */}
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.border}` }}>
            <div className="relative flex items-center">
              <Search size={14} weight="regular" className="pointer-events-none absolute" style={{ left: 8, color: COLORS.textDim }} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="SEARCH FILES"
                style={{
                  height: 30, width: "100%", padding: "0 28px 0 28px", fontSize: 10,
                  fontFamily: MONO_FONT, fontWeight: 500,
                  background: COLORS.recessedBg, borderRadius: 8,
                  border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textSecondary,
                  outline: "none", textTransform: "uppercase", letterSpacing: "1px",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
              />
              {searchQuery.trim() ? (
                <button
                  type="button"
                  className="absolute"
                  style={{ right: 4, top: "50%", transform: "translateY(-50%)", display: "inline-flex", width: 18, height: 18, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer" }}
                  onClick={() => setSearchQuery("")}
                  title="Clear search"
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-center justify-end">
              <button
                type="button"
                style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}
                onClick={() => setShowQuickOpen(true)}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
              >
                <Search size={10} /> QUICK OPEN
              </button>
            </div>
          </div>
          {/* Search results */}
          {searchQuery.trim() ? (
            <div className="max-h-[38%] shrink-0 overflow-auto" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 4 }}>
              {searchResults.map((item, idx) => {
                const srIcon = getFileIcon(item.path.split("/").pop() ?? "");
                const SrIcon = srIcon.icon;
                return (
                  <button
                    key={`${item.path}:${item.line}:${idx}`}
                    className="flex w-full items-start gap-2 text-left"
                    style={{ padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                    onClick={() => { openFile(item.path).catch(() => {}); }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <SrIcon size={12} style={{ color: srIcon.color, flexShrink: 0, marginTop: 2 }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate" style={{ fontWeight: 600, color: COLORS.textPrimary }}>{item.path}:{item.line}:{item.column}</div>
                      <div className="truncate" style={{ color: COLORS.textMuted, fontSize: 10 }}>{item.preview}</div>
                    </div>
                  </button>
                );
              })}
              {!searchResults.length ? <div style={{ padding: "8px", fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT }}>No matches</div> : null}
            </div>
          ) : null}
          {/* File tree */}
          <div className="min-h-0 flex-1 overflow-auto" style={{ paddingTop: 4, paddingBottom: 4 }}>{renderTree(tree)}</div>
        </div>
      )
    },
    editor: {
      title: "Editor",
      icon: FileCode2,
      meta: activeTabPath ? activeTabPath.split("/").pop() : undefined,
      minimizable: true,
      headerActions: (
        <div className="flex items-center gap-1.5">
          {/* Mode toggle group */}
          <div className="inline-flex items-center" style={{ border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, overflow: "hidden" }}>
            {(["edit", "diff", "conflict"] as const).map((m) => {
              const label = m === "edit" ? "CODE" : m === "diff" ? "CHANGES" : "MERGE";
              const isActive = mode === m;
              const disabled = m === "diff" ? (!laneIdForDiff || !activeTabPath) : m === "conflict" ? !activeTabPath : false;
              return (
                <button
                  key={m}
                  type="button"
                  style={{
                    height: 24, padding: "0 10px",
                    fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, letterSpacing: "1px",
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
              );
            })}
          </div>
          <button
            type="button"
            style={{ ...outlineButton({ height: 24, padding: "0 8px", fontSize: 9 }) }}
            onClick={() => setEditorTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            title="Toggle editor theme"
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            {editorTheme === "dark" ? "LIGHT" : "DARK"}
          </button>
          <button
            type="button"
            style={{
              ...primaryButton({ height: 24, padding: "0 10px", fontSize: 9 }),
              opacity: (!activeTab || !canEdit || activeTab.isBinary) ? 0.35 : 1,
            }}
            onClick={() => saveActive().catch(() => {})}
            disabled={!activeTab || !canEdit || activeTab.isBinary}
          >
            <Save size={11} weight="bold" /> SAVE
          </button>
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
              const isActiveTab = activeTabPath === tab.path;
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

          {/* Breadcrumb + git actions */}
          <div className="flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "4px 12px" }}>
            <div className="truncate flex items-center gap-1" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
              {breadcrumbs.length ? breadcrumbs.map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span style={{ color: COLORS.textDim, margin: "0 2px" }}>/</span> : null}
                  <span style={{ color: i === breadcrumbs.length - 1 ? COLORS.textPrimary : COLORS.textMuted }}>{part}</span>
                </React.Fragment>
              )) : <span style={{ color: COLORS.textDim }}>NO FILE SELECTED</span>}
            </div>
            <div className="flex items-center gap-2">
              {activeContextPath && activeContextNodeType === "file" && laneIdForDiff ? (
                <>
                  {activeContextChangeStatus ? (
                    <span style={inlineBadge(changeStatusColor(activeContextChangeStatus), { fontSize: 8 })}>
                      {activeContextChangeStatus === "A" ? "ADDED" : activeContextChangeStatus === "D" ? "DELETED" : activeContextChangeStatus === "M" ? "MODIFIED" : activeContextChangeStatus}
                    </span>
                  ) : null}
                  <button type="button" style={outlineButton({ height: 22, padding: "0 8px", fontSize: 9 })} title="git add" onClick={() => stagePath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.success; e.currentTarget.style.color = COLORS.success; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                  >STAGE</button>
                  <button type="button" style={outlineButton({ height: 22, padding: "0 8px", fontSize: 9 })} title="git reset" onClick={() => unstagePath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.warning; e.currentTarget.style.color = COLORS.warning; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                  >UNSTAGE</button>
                  <button type="button" style={dangerButton({ height: 22, padding: "0 8px", fontSize: 9 })} title="Discard local changes" onClick={() => discardPath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>DISCARD</button>
                </>
              ) : null}
            </div>
          </div>
          {/* Mode hint */}
          <div className="shrink-0" style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "3px 12px", ...LABEL_STYLE, fontSize: 9, color: COLORS.textDim }}>
            {editorModeHint.toUpperCase()}
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
                <div ref={setEditorHostRef} className={cn("h-full", editorStatus === "failed" && "hidden")} />
                {editorStatus === "loading" ? (
                  <div className="flex h-full items-center justify-center" style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted }}>
                    <span className="animate-pulse">LOADING EDITOR...</span>
                  </div>
                ) : null}
                {editorStatus === "failed" ? (
                  <textarea
                    value={activeTab?.content ?? ""}
                    readOnly={!canEdit || Boolean(activeTab?.isBinary)}
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
                <FilesDiffPanel laneId={laneIdForDiff} path={activeTabPath} theme={editorTheme} />
              ) : (
                <div style={{ padding: 16, fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  DIFF MODE REQUIRES A LANE WORKSPACE AND AN OPEN FILE.
                </div>
              )
            ) : (
              <div className="grid h-full" style={{ gridTemplateColumns: "300px 1fr" }}>
                <div style={{ padding: 12, borderRight: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
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
                            <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "ours")}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.info; e.currentTarget.style.color = COLORS.info; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                            >OURS</button>
                            <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "theirs")}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.warning; e.currentTarget.style.color = COLORS.warning; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                            >THEIRS</button>
                            <button type="button" style={outlineButton({ height: 22, padding: "0 6px", fontSize: 8 })} onClick={() => applyConflictResolution(hunk, "both")}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
                            >BOTH</button>
                          </div>
                        </div>
                      );
                    })}
                    {conflictHunks.length === 0 ? (
                      <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>NO CONFLICT MARKERS IN CURRENT FILE.</div>
                    ) : null}
                  </div>
                </div>
                <div className="h-full">
                  <textarea
                    value={activeTab?.content ?? ""}
                    onChange={(e) => {
                      if (!activeTab) return;
                      setOpenTabs((prev) => prev.map((tab) => (tab.path === activeTab.path ? { ...tab, content: e.target.value } : tab)));
                    }}
                    style={{
                      height: "100%", width: "100%", resize: "none", padding: 12,
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
    },
    terminals: {
      title: "Terminals",
      icon: TerminalSquare,
      meta: laneIdForDiff ? `lane ${activeWorkspace?.name ?? ""}` : "Pick a lane workspace",
      minimizable: true,
      headerActions: (
        <button
          type="button"
          style={{
            ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }),
            opacity: laneIdForDiff ? 1 : 0.35,
          }}
          onClick={() => {
            if (!laneIdForDiff) return;
            navigate(`/work?laneId=${encodeURIComponent(laneIdForDiff)}`);
          }}
          disabled={!laneIdForDiff}
          title={laneIdForDiff ? "Open this lane in the dedicated Terminals tab" : "Select a lane workspace to open terminals"}
          onMouseEnter={(e) => { if (laneIdForDiff) { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; } }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
        >
          OPEN TAB
        </button>
      ),
      bodyClassName: "h-full overflow-hidden",
      children: (
        <LaneTerminalsPanel overrideLaneId={laneIdForDiff ?? null} />
      )
    }
  }), [
    tree, activeWorkspace, activeTabPath, activeContextDir, openTabs, activeTab,
    breadcrumbs, mode, canEdit, editorStatus, laneIdForDiff, activeContextPath, activeContextChangeStatus,
    activeContextNodeType, searchQuery, searchResults, conflictHunks, editorTheme, editorModeHint, hasConflictMarkers,
    resolvedConflictKeys, renderTree, createFileAt, createDirectoryAt, saveActive,
    closeTab, stagePath, unstagePath, discardPath, openFile, setShowQuickOpen, navigate
  ]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header bar */}
      <div style={{ padding: "0 24px", height: 64, display: "flex", alignItems: "center", gap: 20, background: "transparent", borderBottom: `1px solid ${COLORS.border}` }}>
        {/* Numbered title group */}
        <div className="flex items-center gap-2 shrink-0">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.accent }}>03</span>
          <FolderOpen size={18} weight="fill" style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>FILES</span>
          <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{workspaces.length} WS</span>
        </div>

        {/* Workspace selector */}
        <select
          value={workspaceId}
          onChange={(e) => switchWorkspace(e.target.value)}
          style={{
            height: 32, padding: "0 12px", fontSize: 12, fontFamily: MONO_FONT, fontWeight: 600,
            color: COLORS.success, background: COLORS.recessedBg, borderRadius: 8,
            border: `1px solid ${COLORS.outlineBorder}`, cursor: "pointer", outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; }}
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name} ({ws.kind})
            </option>
          ))}
        </select>

        {/* Read-only badge */}
        {activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? (
          <span style={inlineBadge(COLORS.warning, { fontSize: 9, gap: 4, display: "inline-flex", alignItems: "center" })}>
            <AlertTriangle size={10} weight="fill" /> READ-ONLY
          </span>
        ) : null}

        {/* Trust / edit toggle */}
        {activeWorkspace?.isReadOnlyByDefault ? (
          <button
            type="button"
            style={allowPrimaryEdit ? dangerButton({ height: 28, padding: "0 10px", fontSize: 9 }) : outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })}
            onClick={() => setAllowPrimaryEdit((v) => !v)}
            onMouseEnter={(e) => { if (!allowPrimaryEdit) { e.currentTarget.style.borderColor = COLORS.warning; e.currentTarget.style.color = COLORS.warning; } }}
            onMouseLeave={(e) => { if (!allowPrimaryEdit) { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; } }}
          >
            {allowPrimaryEdit ? "DISABLE EDITS" : "TRUST & EDIT"}
          </button>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1, height: 1 }} />

        {/* Open in external editor */}
        <div className="relative shrink-0" ref={openInMenuRef}>
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
          {openInMenuOpen ? (
            <div className="absolute right-0 top-full z-50 mt-1" style={{ width: 220, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "2px 0", overflow: "hidden" }}>
              {(
                [
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

        {/* Nav buttons */}
        <button
          type="button"
          style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })}
          onClick={() => navigate("/lanes")}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.outlineBorder; e.currentTarget.style.color = COLORS.textSecondary; }}
        >
          LANES
        </button>

        {/* File count stat */}
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {openTabs.length} OPEN
        </span>
      </div>

      {/* Warning banners */}
      {(activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit) || (activeWorkspace?.kind === "primary" && suggestedLaneWorkspace) ? (
        <div className="flex flex-wrap items-center gap-3 shrink-0" style={{
          padding: "6px 24px",
          borderBottom: `1px solid ${COLORS.warning}30`,
          background: activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? `${COLORS.warning}15` : `${COLORS.warning}08`,
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
          borderBottom: `1px solid ${COLORS.danger}30`,
          background: `${COLORS.danger}12`,
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

      {/* Floating pane tiling area */}
      <div className="flex-1 min-h-0">
        <PaneTilingLayout
          layoutId="files:tiling:v3"
          tree={FILES_TILING_TREE}
          panes={paneConfigs}
        />
      </div>

      {/* Context menu overlay */}
      {contextMenu ? (
        <div
          className="fixed z-40"
          style={{ left: contextMenu.x, top: contextMenu.y, minWidth: 200, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "4px 0" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeType === "file" ? (
            <>
              <div style={{ ...LABEL_STYLE, padding: "4px 12px", fontSize: 8 }}>FILE</div>
              {[
                { label: "OPEN", action: async () => openFile(contextMenu.nodePath), color: COLORS.textSecondary },
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
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: "0.5px", color: COLORS.accent, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => renamePath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>RENAME</button>
          <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
          <button className="flex w-full items-center text-left" style={{ padding: "6px 12px", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "0.5px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => runContextAction(async () => deletePath(contextMenu.nodePath))} onMouseEnter={(e) => { e.currentTarget.style.background = `${COLORS.danger}18`; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>DELETE</button>
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
                placeholder="Type to search files... (Cmd+P)"
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

function FilesDiffPanel({ laneId, path, theme }: { laneId: string; path: string; theme: EditorThemeMode }) {
  const [mode, setMode] = useState<"unstaged" | "staged" | "commit">("unstaged");
  const [diff, setDiff] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [compareRef, setCompareRef] = useState<string>("");

  useEffect(() => {
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
  }, [laneId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    const load = async () => {
      if (mode === "commit" && !compareRef.trim()) {
        setDiff(null);
        return;
      }

      const next = await window.ade.diff.getFile({
        laneId,
        path,
        mode,
        compareRef: mode === "commit" ? compareRef : undefined
      });
      if (cancelled) return;
      setDiff(next);
    };

    load().catch((err) => {
      if (cancelled) return;
      setDiff(null);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
    };
  }, [laneId, path, mode, compareRef]);

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
      <div className="min-h-0 flex-1">{diff ? <MonacoDiffView diff={diff} className="h-full" theme={theme} /> : null}</div>
    </div>
  );
}
