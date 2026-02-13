import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FileBraces,
  FileCog,
  FileCode2,
  FileImage,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Save,
  Search,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  FileTreeNode,
  FilesQuickOpenItem,
  FilesSearchTextMatch,
  FilesWorkspace,
  GitCommitSummary
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { MonacoDiffView } from "../lanes/MonacoDiffView";
import { useAppStore } from "../../state/appStore";

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

function applyConflictChoice(text: string, hunk: ConflictHunk, choice: "ours" | "theirs" | "both"): string {
  const lines = text.split("\n");
  const before = lines.slice(0, hunk.startLine - 1);
  const after = lines.slice(hunk.endLine);
  const middle = choice === "ours" ? hunk.ours : choice === "theirs" ? hunk.theirs : `${hunk.ours}\n${hunk.theirs}`;
  return [...before, middle, ...after].join("\n");
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function parentDirOfPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function getFileIcon(fileName: string): { icon: React.ComponentType<{ className?: string }>; className: string } {
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
    return { icon: FileCode2, className: "text-sky-500" };
  }
  if (ext === ".json" || ext === ".jsonc") {
    return { icon: FileBraces, className: "text-emerald-500" };
  }
  if (ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".ini") {
    return { icon: FileCog, className: "text-orange-500" };
  }
  if (ext === ".md" || ext === ".mdx") {
    return { icon: BookOpenText, className: "text-amber-500" };
  }
  if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") {
    return { icon: FileCode2, className: "text-indigo-500" };
  }
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh" || ext === ".fish" || ext === ".ps1") {
    return { icon: TerminalSquare, className: "text-teal-500" };
  }
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".svg" || ext === ".ico") {
    return { icon: FileImage, className: "text-fuchsia-500" };
  }
  if (ext === ".zip" || ext === ".tar" || ext === ".gz" || ext === ".tgz" || ext === ".rar" || ext === ".7z") {
    return { icon: FileArchive, className: "text-rose-500" };
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".xls" || ext === ".xlsx") {
    return { icon: FileSpreadsheet, className: "text-green-600" };
  }
  return { icon: FileText, className: "text-muted-fg" };
}

function changeStatusClasses(changeStatus: FileTreeNode["changeStatus"]): { dot: string; text: string } {
  if (changeStatus === "A") {
    return { dot: "bg-emerald-500", text: "text-emerald-600" };
  }
  if (changeStatus === "D") {
    return { dot: "bg-rose-500", text: "text-rose-600" };
  }
  if (changeStatus === "M") {
    return { dot: "bg-amber-500", text: "text-amber-600" };
  }
  return { dot: "bg-border", text: "text-muted-fg" };
}

export function FilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [allowPrimaryEdit, setAllowPrimaryEdit] = useState(false);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const pendingOpenRef = useRef<{ filePath: string; laneId: string | null; key: string } | null>(null);

  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "diff" | "conflict">("edit");

  const [quickOpen, setQuickOpen] = useState("");
  const [quickOpenResults, setQuickOpenResults] = useState<FilesQuickOpenItem[]>([]);
  const [showQuickOpen, setShowQuickOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FilesSearchTextMatch[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  const [resolvedConflictKeys, setResolvedConflictKeys] = useState<Set<string>>(new Set());
  const [textPrompt, setTextPrompt] = useState<TextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<"loading" | "ready" | "failed">("loading");

  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<import("monaco-editor").editor.ITextModel | null>(null);
  const modelKeyRef = useRef<string | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorApplyingRef = useRef(false);
  const activeTabPathRef = useRef<string | null>(null);

  const activeWorkspace = useMemo(() => workspaces.find((ws) => ws.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const activeTab = useMemo(() => openTabs.find((tab) => tab.path === activeTabPath) ?? null, [openTabs, activeTabPath]);
  const activeDirty = Boolean(activeTab && activeTab.content !== activeTab.savedContent);
  const canEdit = Boolean(activeWorkspace) && (!activeWorkspace?.isReadOnlyByDefault || allowPrimaryEdit);

  const hasUnsavedTabs = useMemo(
    () => openTabs.some((tab) => tab.content !== tab.savedContent),
    [openTabs]
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

  const refreshTree = useCallback(async (parentPath?: string) => {
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
        setWorkspaceId((current) => current || items[0]?.id || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setExpanded(new Set());
    setContextMenu(null);
    refreshTree().catch(() => {});
    window.ade.files.watchChanges({ workspaceId }).catch(() => {});

    const unsub = window.ade.files.onChange((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      refreshTree().catch(() => {});
    });

    return () => {
      unsub();
      window.ade.files.stopWatching({ workspaceId }).catch(() => {});
    };
  }, [workspaceId, refreshTree]);

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
        if (showSearch) setShowSearch(false);
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
        setShowSearch(true);
        return;
      }

      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setExplorerCollapsed((v) => !v);
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
  }, [saveActive, activeTabPath, closeTab, renamePath, selectedNodePath, showQuickOpen, showSearch]);

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
    if (!showSearch || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      window.ade.files.searchText({ workspaceId, query: searchQuery, limit: 200 })
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery, workspaceId, showSearch]);

  useEffect(() => {
    if (mode !== "edit") return;
    if (!editorHostRef.current) return;
    if (editorRef.current) return;

    let disposed = false;
    setEditorStatus("loading");
    loadMonaco().then((monaco) => {
      if (disposed || !editorHostRef.current) return;
      monacoRef.current = monaco;
      const editor = monaco.editor.create(editorHostRef.current, {
        value: "",
        language: "plaintext",
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        readOnly: !canEdit
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
  }, [mode, canEdit]);

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
        const statusClasses = changeStatusClasses(node.changeStatus ?? null);
        const fileIcon = node.type === "file" ? getFileIcon(node.name) : null;
        const FileIcon = fileIcon?.icon;

        return (
          <div key={node.path}>
            <button
              className={cx(
                "group relative flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs text-muted-fg transition-colors hover:bg-muted/70 hover:text-fg",
                isActive && "bg-accent/10 text-fg ring-1 ring-accent/30",
              )}
              style={{ paddingLeft: `${8 + level * 12}px` }}
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
              title={node.path}
            >
              {level > 0 ? (
                <span className="pointer-events-none absolute inset-y-0 left-0">
                  {Array.from({ length: level }).map((_, idx) => (
                    <span
                      key={`${node.path}:guide:${idx}`}
                      className="absolute inset-y-0 w-px bg-border/45 transition-colors group-hover:bg-border/70"
                      style={{ left: `${8 + idx * 12 + 4}px` }}
                    />
                  ))}
                </span>
              ) : null}
              {isActive ? <span className="absolute inset-y-1 left-0 w-[2px] rounded bg-accent" /> : null}
              {node.type === "directory" ? (
                <>
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-fg/90 transition-colors group-hover:text-fg" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-fg/90 transition-colors group-hover:text-fg" />}
                  {isExpanded ? <FolderOpen className="h-3.5 w-3.5 text-muted-fg/90 transition-colors group-hover:text-fg" /> : <Folder className="h-3.5 w-3.5 text-muted-fg/90 transition-colors group-hover:text-fg" />}
                </>
              ) : (
                <>
                  <span className="w-3.5" />
                  {FileIcon ? <FileIcon className={cx("h-3.5 w-3.5", fileIcon?.className)} /> : <FileText className="h-3.5 w-3.5 text-muted-fg" />}
                </>
              )}
              <span className="truncate">{node.name}</span>
              {node.type === "directory" && node.changeStatus ? <span className={cx("ml-auto h-1.5 w-1.5 rounded-full", statusClasses.dot)} /> : null}
              {node.type === "file" && node.changeStatus ? <span className={cx("ml-auto text-[10px]", statusClasses.text)}>{node.changeStatus}</span> : null}
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

  return (
    <div className="relative flex h-full min-h-0 flex-col rounded-lg border border-border bg-card/60 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-sm font-semibold">Files</div>
          <select
            value={workspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
            className="h-8 rounded border border-border bg-card/70 px-2 text-xs"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name} ({ws.kind})
              </option>
            ))}
          </select>
          {activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
              <AlertTriangle className="h-3 w-3" />
              Primary workspace is read-only
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {activeWorkspace?.isReadOnlyByDefault ? (
            <Button size="sm" variant="outline" onClick={() => setAllowPrimaryEdit((v) => !v)}>
              {allowPrimaryEdit ? "Disable edits" : "Trust and enable edits"}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => navigate("/lanes")}>Jump to Lanes</Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/conflicts")}>Jump to Conflicts</Button>
          <Button size="sm" variant="outline" onClick={() => setMode("edit")}>Edit</Button>
          <Button size="sm" variant="outline" onClick={() => setMode("diff")}>Diff</Button>
          <Button size="sm" variant="outline" onClick={() => setMode("conflict")}>Conflict</Button>
          <Button size="sm" onClick={() => saveActive().catch(() => {})} disabled={!activeTab || !canEdit || activeTab.isBinary}>
            <Save className="h-4 w-4" />
            Save
          </Button>
        </div>
      </div>

      {(activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit) || (activeWorkspace?.kind === "primary" && suggestedLaneWorkspace) ? (
        <div className={cx(
          "flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs",
          activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-orange-300 bg-orange-50 text-orange-900"
        )}>
          {activeWorkspace?.isReadOnlyByDefault && !allowPrimaryEdit ? (
            <span>
              Editing is disabled for Primary workspace by default. Use <span className="font-semibold">Trust and enable edits</span> to unlock writes.
            </span>
          ) : (
            <span>
              You are editing directly in Primary workspace. Lane workspaces are safer for branch-scoped edits.
            </span>
          )}
          {suggestedLaneWorkspace ? (
            <Button size="sm" variant="outline" onClick={() => switchWorkspace(suggestedLaneWorkspace.id)}>
              Switch to lane: {suggestedLaneWorkspace.name}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="border-b border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">{error}</div> : null}

      <div className="flex min-h-0 flex-1">
        {!explorerCollapsed ? (
          <div className="w-[280px] shrink-0 border-r border-border bg-card/50">
            <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-[11px] text-muted-fg">
              <span>Explorer</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" title="New file" onClick={() => createFileAt(activeContextDir).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  <FilePlus2 className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" title="New folder" onClick={() => createDirectoryAt(activeContextDir).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="h-[calc(100%-28px)] overflow-auto">{renderTree(tree)}</div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1">
            {openTabs.map((tab) => {
              const dirty = tab.content !== tab.savedContent;
              return (
                <div key={tab.path} className={cx("flex items-center gap-1 rounded border px-2 py-1 text-xs", activeTabPath === tab.path ? "border-accent/40 bg-muted/70" : "border-border bg-card/70")}>
                  <button className="max-w-[220px] truncate text-left" onClick={() => setActiveTabPath(tab.path)}>
                    {tab.path.split("/").pop()}
                    {dirty ? " •" : ""}
                  </button>
                  <button className="text-muted-fg hover:text-fg" onClick={() => closeTab(tab.path)}>x</button>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted-fg">
            <div>{breadcrumbs.length ? breadcrumbs.join(" > ") : "No file selected"}</div>
            <div className="flex items-center gap-2">
              {activeContextPath && activeContextNodeType === "file" && laneIdForDiff ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => stagePath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>Stage</Button>
                  <Button size="sm" variant="ghost" onClick={() => unstagePath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>Unstage</Button>
                  <Button size="sm" variant="ghost" onClick={() => discardPath(activeContextPath).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>Discard</Button>
                </>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setExplorerCollapsed((v) => !v)}>
                {explorerCollapsed ? "Show Explorer" : "Hide Explorer"}
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {mode === "edit" ? (
              <div className="h-full">
                <div ref={editorHostRef} className={cx("h-full", editorStatus === "failed" && "hidden")} />
                {editorStatus === "loading" ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-fg">Loading editor...</div>
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
                    className="h-full w-full resize-none bg-bg p-3 font-mono text-xs outline-none"
                  />
                ) : null}
              </div>
            ) : mode === "diff" ? (
              laneIdForDiff && activeTabPath ? (
                <FilesDiffPanel laneId={laneIdForDiff} path={activeTabPath} />
              ) : (
                <div className="p-4 text-sm text-muted-fg">Diff mode requires a lane workspace and an open file.</div>
              )
            ) : (
              <div className="grid h-full grid-cols-[300px_1fr]">
                <div className="border-r border-border p-2">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold">
                    <span>Conflict Hunks</span>
                    <span className="text-muted-fg">{resolvedConflictKeys.size}/{conflictHunks.length} resolved</span>
                  </div>
                  <div className="space-y-2">
                    {conflictHunks.map((hunk) => {
                      const resolved = resolvedConflictKeys.has(hunk.key);
                      return (
                        <div key={hunk.key} className={cx("rounded border bg-card/70 p-2 text-xs", resolved ? "border-emerald-500/40" : "border-border")}>
                          <div className="flex items-center justify-between">
                            <span>Lines {hunk.startLine}-{hunk.endLine}</span>
                            {resolved ? <span className="inline-flex items-center gap-1 text-emerald-300"><Sparkles className="h-3 w-3" />Resolved</span> : null}
                          </div>
                          <div className="mt-1 flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => applyConflictResolution(hunk, "ours")}>Accept Ours</Button>
                            <Button size="sm" variant="outline" onClick={() => applyConflictResolution(hunk, "theirs")}>Accept Theirs</Button>
                            <Button size="sm" variant="outline" onClick={() => applyConflictResolution(hunk, "both")}>Accept Both</Button>
                          </div>
                        </div>
                      );
                    })}
                    {conflictHunks.length === 0 ? <div className="text-xs text-muted-fg">No conflict markers in current file.</div> : null}
                  </div>
                </div>
                <div className="h-full">
                  <textarea
                    value={activeTab?.content ?? ""}
                    onChange={(e) => {
                      if (!activeTab) return;
                      setOpenTabs((prev) => prev.map((tab) => (tab.path === activeTab.path ? { ...tab, content: e.target.value } : tab)));
                    }}
                    className="h-full w-full resize-none bg-bg p-3 font-mono text-xs outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {contextMenu ? (
        <div
          className="fixed z-40 min-w-[190px] rounded border border-border bg-card/95 p-1 shadow-2xl backdrop-blur"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeType === "file" ? (
            <>
              <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => openFile(contextMenu.nodePath))}>Open</button>
              <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => {
                await openFile(contextMenu.nodePath);
                setMode("diff");
              })}>Open Diff</button>
              {laneIdForWorkspace ? (
                <>
                  <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => stagePath(contextMenu.nodePath))}>Stage</button>
                  <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => unstagePath(contextMenu.nodePath))}>Unstage</button>
                  <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => discardPath(contextMenu.nodePath))}>Discard</button>
                </>
              ) : null}
            </>
          ) : null}

          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
            setContextMenu(null);
            navigator.clipboard.writeText(contextMenu.nodePath).catch(() => {});
          }}>Copy Path</button>
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => createFileAt(contextMenu.nodeType === "directory" ? contextMenu.nodePath : parentDirOfPath(contextMenu.nodePath)))}>New File</button>
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => createDirectoryAt(contextMenu.nodeType === "directory" ? contextMenu.nodePath : parentDirOfPath(contextMenu.nodePath)))}>New Folder</button>
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => runContextAction(async () => renamePath(contextMenu.nodePath))}>Rename</button>
          <button className="block w-full rounded px-2 py-1 text-left text-xs text-red-300 hover:bg-red-500/20" onClick={() => runContextAction(async () => deletePath(contextMenu.nodePath))}>Delete</button>
        </div>
      ) : null}

      {showQuickOpen ? (
        <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/40 pt-20">
          <div className="w-[640px] rounded-lg border border-border bg-card p-3 shadow-2xl">
            <div className="flex items-center gap-2 rounded border border-border bg-card/70 px-2">
              <Search className="h-4 w-4 text-muted-fg" />
              <input
                autoFocus
                value={quickOpen}
                onChange={(e) => setQuickOpen(e.target.value)}
                placeholder="Quick open (Ctrl/Cmd+P)"
                className="h-9 w-full bg-transparent text-sm outline-none"
              />
              <Button size="sm" variant="ghost" onClick={() => setShowQuickOpen(false)}>Esc</Button>
            </div>
            <div className="mt-2 max-h-[40vh] overflow-auto rounded border border-border">
              {quickOpenResults.map((item) => (
                <button
                  key={item.path}
                  className="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/50"
                  onClick={() => {
                    openFile(item.path).catch(() => {});
                    setShowQuickOpen(false);
                  }}
                >
                  {item.path}
                </button>
              ))}
              {!quickOpenResults.length ? <div className="px-3 py-2 text-xs text-muted-fg">No matches</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {showSearch ? (
        <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/40 pt-20">
          <div className="w-[760px] rounded-lg border border-border bg-card p-3 shadow-2xl">
            <div className="flex items-center gap-2 rounded border border-border bg-card/70 px-2">
              <Search className="h-4 w-4 text-muted-fg" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search in files (Ctrl/Cmd+Shift+F)"
                className="h-9 w-full bg-transparent text-sm outline-none"
              />
              <Button size="sm" variant="ghost" onClick={() => setShowSearch(false)}>Esc</Button>
            </div>
            <div className="mt-2 max-h-[40vh] overflow-auto rounded border border-border">
              {searchResults.map((item, idx) => (
                <button
                  key={`${item.path}:${item.line}:${idx}`}
                  className="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/50"
                  onClick={() => {
                    openFile(item.path).catch(() => {});
                    setShowSearch(false);
                  }}
                >
                  <div className="font-medium">{item.path}:{item.line}:{item.column}</div>
                  <div className="text-muted-fg">{item.preview}</div>
                </button>
              ))}
              {!searchResults.length ? <div className="px-3 py-2 text-xs text-muted-fg">No matches</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {textPrompt ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
          <div className="w-[min(520px,100%)] rounded border border-border bg-card p-3 shadow-2xl">
            <div className="mb-1 text-sm font-semibold text-fg">{textPrompt.title}</div>
            {textPrompt.message ? <div className="mb-2 text-xs text-muted-fg">{textPrompt.message}</div> : null}
            <input
              autoFocus
              value={textPrompt.value}
              onChange={(event) => {
                const nextValue = event.target.value;
                setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
                if (textPromptError) setTextPromptError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelTextPrompt();
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitTextPrompt();
                }
              }}
              placeholder={textPrompt.placeholder}
              className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none"
            />
            {textPromptError ? <div className="mt-2 text-xs text-red-300">{textPromptError}</div> : null}
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={cancelTextPrompt}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={submitTextPrompt}>
                {textPrompt.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilesDiffPanel({ laneId, path }: { laneId: string; path: string }) {
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
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <Button size="sm" variant="outline" onClick={() => setMode("unstaged")}>Unstaged</Button>
        <Button size="sm" variant="outline" onClick={() => setMode("staged")}>Staged</Button>
        <Button size="sm" variant="outline" onClick={() => setMode("commit")}>Commit</Button>

        {mode === "commit" ? (
          <select
            value={compareRef}
            onChange={(e) => setCompareRef(e.target.value)}
            className="h-8 rounded border border-border bg-card/70 px-2 text-xs"
          >
            {commits.map((commit) => (
              <option key={commit.sha} value={commit.sha}>
                {commit.shortSha} - {commit.subject}
              </option>
            ))}
          </select>
        ) : null}

        <div className="truncate text-xs text-muted-fg">{path}</div>
      </div>

      {error ? <div className="p-3 text-xs text-red-800">{error}</div> : null}
      <div className="min-h-0 flex-1">{diff ? <MonacoDiffView diff={diff} className="h-full" /> : null}</div>
    </div>
  );
}
