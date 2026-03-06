import React from "react";
import {
  CaretDown,
  CaretRight,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  PencilSimple,
  Scissors,
  ClipboardText,
  FloppyDisk,
  Trash,
  X
} from "@phosphor-icons/react";
import type { FileTreeNode, FilesWorkspace } from "../../../shared/types";
import { cn } from "../ui/cn";

type OpenTab = {
  path: string;
  content: string;
  savedContent: string;
  languageId: string;
  isBinary: boolean;
};

type NodeContextMenuState = {
  x: number;
  y: number;
  nodePath: string;
  nodeType: "file" | "directory";
};

type ClipboardMode = "copy" | "cut";

type PathClipboard = {
  workspaceId: string;
  path: string;
  type: "file" | "directory";
  mode: ClipboardMode;
};

const MIN_CONTEXT_MENU_WIDTH = 176;

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

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinPath(parentPath: string, name: string): string {
  const parent = normalizePath(parentPath);
  const child = normalizePath(name);
  if (!parent) return child;
  if (!child) return parent;
  return `${parent}/${child}`;
}

function parentPathOf(pathValue: string): string {
  const normalized = normalizePath(pathValue);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function basename(pathValue: string): string {
  const normalized = normalizePath(pathValue);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return normalized;
  return normalized.slice(idx + 1);
}

function splitNameAndExtension(fileName: string): { base: string; ext: string } {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return { base: fileName, ext: "" };
  return {
    base: fileName.slice(0, idx),
    ext: fileName.slice(idx)
  };
}

function createCopyName(name: string, sequence: number): string {
  if (sequence <= 1) return `${name}-copy`;
  return `${name}-copy-${sequence}`;
}

function createCopyFileName(fileName: string, sequence: number): string {
  const { base, ext } = splitNameAndExtension(fileName);
  const suffix = sequence <= 1 ? "copy" : `copy-${sequence}`;
  return `${base}-${suffix}${ext}`;
}

function isPathEqualOrDescendant(pathValue: string, rootPath: string): boolean {
  const normalizedPath = normalizePath(pathValue);
  const normalizedRoot = normalizePath(rootPath);
  if (!normalizedRoot) return normalizedPath.length === 0;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function remapPathForRename(pathValue: string, oldPath: string, newPath: string): string {
  const normalizedPath = normalizePath(pathValue);
  const normalizedOld = normalizePath(oldPath);
  const normalizedNew = normalizePath(newPath);
  if (!normalizedOld || !normalizedNew) return normalizedPath;
  if (normalizedPath === normalizedOld) return normalizedNew;
  if (!normalizedPath.startsWith(`${normalizedOld}/`)) return normalizedPath;
  return `${normalizedNew}${normalizedPath.slice(normalizedOld.length)}`;
}

function flattenNodes(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
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

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;

  const next: FileTreeNode[] = [];
  for (const node of nodes) {
    const selfMatch = node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle);
    const childMatches = node.children ? filterTree(node.children, query) : [];
    if (selfMatch || childMatches.length > 0) {
      next.push({
        ...node,
        children: childMatches.length ? childMatches : node.children
      });
    }
  }

  return next;
}

export function FloatingFilesWorkspace({ preferredLaneId }: { preferredLaneId: string | null }) {
  const [workspaces, setWorkspaces] = React.useState<FilesWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [allowPrimaryEdit, setAllowPrimaryEdit] = React.useState(false);

  const [tree, setTree] = React.useState<FileTreeNode[]>([]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = React.useState<string | null>(null);

  const [openTabs, setOpenTabs] = React.useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<NodeContextMenuState | null>(null);
  const [clipboard, setClipboard] = React.useState<PathClipboard | null>(null);

  const [editorStatus, setEditorStatus] = React.useState<"loading" | "ready" | "failed">("loading");
  const [editorHost, setEditorHost] = React.useState<HTMLDivElement | null>(null);

  const monacoRef = React.useRef<typeof import("monaco-editor") | null>(null);
  const editorRef = React.useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const modelRef = React.useRef<import("monaco-editor").editor.ITextModel | null>(null);
  const modelKeyRef = React.useRef<string | null>(null);
  const applyingRef = React.useRef(false);
  const activeTabPathRef = React.useRef<string | null>(null);
  const openTabsRef = React.useRef<OpenTab[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const activeWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  const canEdit = React.useMemo(() => {
    if (!activeWorkspace) return false;
    if (!activeWorkspace.isReadOnlyByDefault) return true;
    return allowPrimaryEdit;
  }, [activeWorkspace, allowPrimaryEdit]);

  const activeTab = React.useMemo(
    () => openTabs.find((tab) => tab.path === activeTabPath) ?? null,
    [openTabs, activeTabPath]
  );

  const nodeMap = React.useMemo(() => flattenNodes(tree), [tree]);

  const filteredTree = React.useMemo(() => filterTree(tree, query), [tree, query]);

  React.useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  React.useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const refreshTree = React.useCallback(async () => {
    if (!workspaceId) {
      setTree([]);
      return;
    }

    try {
      const nodes = await window.ade.files.listTree({
        workspaceId,
        depth: 8
      });
      setTree(nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  const syncCleanTabFromDisk = React.useCallback(
    async (pathRaw: string) => {
      if (!workspaceId) return;
      const path = normalizePath(pathRaw);
      if (!path) return;
      const hasCleanOpenTab = openTabsRef.current.some((tab) => tab.path === path && tab.content === tab.savedContent);
      if (!hasCleanOpenTab) return;

      try {
        const file = await window.ade.files.readFile({ workspaceId, path });
        setOpenTabs((prev) => {
          let changed = false;
          const next = prev.map((tab) => {
            if (tab.path !== path) return tab;
            if (tab.content !== tab.savedContent) return tab;

            if (
              tab.content === file.content &&
              tab.savedContent === file.content &&
              tab.languageId === file.languageId &&
              tab.isBinary === file.isBinary
            ) {
              return tab;
            }

            changed = true;
            return {
              ...tab,
              content: file.content,
              savedContent: file.content,
              languageId: file.languageId,
              isBinary: file.isBinary
            };
          });
          return changed ? next : prev;
        });
      } catch {
        // A deleted/renamed path can race this read; ignore quietly.
      }
    },
    [workspaceId]
  );

  React.useEffect(() => {
    let cancelled = false;
    window.ade.files
      .listWorkspaces()
      .then((items) => {
        if (cancelled) return;
        setWorkspaces(items);
        setWorkspaceId((current) => {
          if (current && items.some((workspace) => workspace.id === current)) return current;

          if (preferredLaneId) {
            const laneWorkspace = items.find((workspace) => workspace.laneId === preferredLaneId);
            if (laneWorkspace) return laneWorkspace.id;
          }

          return items[0]?.id ?? "";
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [preferredLaneId]);

  React.useEffect(() => {
    if (!preferredLaneId) return;
    const laneWorkspace = workspaces.find((workspace) => workspace.laneId === preferredLaneId);
    if (!laneWorkspace) return;
    setWorkspaceId((current) => (current === laneWorkspace.id ? current : laneWorkspace.id));
  }, [preferredLaneId, workspaces]);

  React.useEffect(() => {
    if (!workspaceId) return;
    setMenu(null);
    void refreshTree();

    let timer: number | null = null;
    const pendingTabSyncPaths = new Set<string>();

    const scheduleFlush = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refreshTree();

        const paths = Array.from(pendingTabSyncPaths);
        pendingTabSyncPaths.clear();
        for (const path of paths) {
          void syncCleanTabFromDisk(path);
        }
      }, 120);
    };

    void window.ade.files.watchChanges({ workspaceId }).catch(() => {
      // best effort
    });

    const unsubscribe = window.ade.files.onChange((event) => {
      if (event.workspaceId !== workspaceId) return;

      const nextPath = normalizePath(event.path);
      const oldPath = normalizePath(event.oldPath ?? "");

      if (event.type === "renamed" && oldPath && nextPath) {
        setOpenTabs((prev) => {
          let changed = false;
          const next = prev.map((tab) => {
            const mappedPath = remapPathForRename(tab.path, oldPath, nextPath);
            if (mappedPath === tab.path) return tab;
            changed = true;
            if (tab.content === tab.savedContent) pendingTabSyncPaths.add(mappedPath);
            return { ...tab, path: mappedPath };
          });
          return changed ? next : prev;
        });
        setActiveTabPath((current) => (current ? remapPathForRename(current, oldPath, nextPath) : current));
        setSelectedNodePath((current) => (current ? remapPathForRename(current, oldPath, nextPath) : current));
      } else if (event.type === "deleted" && nextPath) {
        setOpenTabs((prev) => {
          const next = prev.filter((tab) => !isPathEqualOrDescendant(tab.path, nextPath));
          if (next.length !== prev.length) {
            const activePath = activeTabPathRef.current;
            if (activePath && !next.some((tab) => tab.path === activePath)) {
              setActiveTabPath(next[next.length - 1]?.path ?? null);
            }
          }
          return next.length === prev.length ? prev : next;
        });
        setSelectedNodePath((current) => (current && isPathEqualOrDescendant(current, nextPath) ? null : current));
      } else if (nextPath) {
        pendingTabSyncPaths.add(nextPath);
      }

      scheduleFlush();
    });

    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
      void window.ade.files.stopWatching({ workspaceId }).catch(() => {
        // best effort
      });
    };
  }, [workspaceId, refreshTree, syncCleanTabFromDisk]);

  React.useEffect(() => {
    const onPointerDown = () => setMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  React.useEffect(() => {
    if (!editorHost) return;
    if (editorRef.current) return;

    let disposed = false;
    setEditorStatus("loading");

    void loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        monacoRef.current = monaco;
        const editor = monaco.editor.create(editorHost, {
          value: "",
          language: "plaintext",
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
          lineHeight: 18,
          theme: "vs-dark",
          readOnly: true
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => {
          const tabPath = activeTabPathRef.current;
          if (!tabPath || applyingRef.current) return;
          const value = editor.getValue();
          setOpenTabs((prev) =>
            prev.map((tab) => (tab.path === tabPath ? { ...tab, content: value } : tab))
          );
        });
        setEditorStatus("ready");
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setEditorStatus("failed");
        setError(`Editor failed to load: ${err instanceof Error ? err.message : String(err)}`);
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
  }, [editorHost]);

  React.useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;

    if (!activeTab) {
      try {
        editorRef.current.setModel(null);
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

    const modelKey = `${activeTab.path}:${activeTab.languageId}`;
    if (modelRef.current && modelKeyRef.current === modelKey) {
      editorRef.current.updateOptions({
        readOnly: !canEdit || activeTab.isBinary
      });
      return;
    }

    try {
      editorRef.current.setModel(null);
    } catch {
      // ignore
    }
    try {
      modelRef.current?.dispose();
    } catch {
      // ignore
    }

    modelRef.current = monacoRef.current.editor.createModel(
      activeTab.content,
      activeTab.languageId || "plaintext"
    );
    modelKeyRef.current = modelKey;
    editorRef.current.setModel(modelRef.current);
    editorRef.current.updateOptions({
      readOnly: !canEdit || activeTab.isBinary
    });
  }, [activeTab?.path, activeTab?.languageId, activeTab?.isBinary, canEdit]);

  React.useEffect(() => {
    if (!activeTab || !editorRef.current) return;
    const current = editorRef.current.getValue();
    if (current === activeTab.content) return;
    applyingRef.current = true;
    editorRef.current.setValue(activeTab.content);
    applyingRef.current = false;
  }, [activeTab?.path, activeTab?.content]);

  const openFile = React.useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      try {
        const next = await window.ade.files.readFile({ workspaceId, path });
        setOpenTabs((prev) => {
          const existing = prev.find((tab) => tab.path === path);
          if (existing) {
            return prev.map((tab) =>
              tab.path === path
                ? {
                  ...tab,
                  content: next.content,
                  savedContent: next.content,
                  languageId: next.languageId,
                  isBinary: next.isBinary
                }
                : tab
            );
          }
          return [
            ...prev,
            {
              path,
              content: next.content,
              savedContent: next.content,
              languageId: next.languageId,
              isBinary: next.isBinary
            }
          ];
        });
        setActiveTabPath(path);
        setSelectedNodePath(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId]
  );

  const closeTab = React.useCallback((path: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => tab.path !== path);
      if (activeTabPathRef.current === path) {
        setActiveTabPath(next[next.length - 1]?.path ?? null);
      }
      return next;
    });
  }, []);

  const saveActive = React.useCallback(async () => {
    if (!workspaceId || !activeTab || !canEdit || activeTab.isBinary) return;
    try {
      await window.ade.files.writeText({
        workspaceId,
        path: activeTab.path,
        text: activeTab.content
      });
      setOpenTabs((prev) =>
        prev.map((tab) => (tab.path === activeTab.path ? { ...tab, savedContent: tab.content } : tab))
      );
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, activeTab, canEdit, refreshTree]);

  const createFile = React.useCallback(
    async (baseDir: string) => {
      if (!workspaceId || !canEdit) return;
      const defaultPath = baseDir ? `${baseDir}/new-file.ts` : "new-file.ts";
      const nextPath = window.prompt("New file path", defaultPath)?.trim();
      if (!nextPath) return;
      try {
        await window.ade.files.createFile({
          workspaceId,
          path: normalizePath(nextPath),
          content: ""
        });
        await refreshTree();
        await openFile(normalizePath(nextPath));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, canEdit, refreshTree, openFile]
  );

  const createDirectory = React.useCallback(
    async (baseDir: string) => {
      if (!workspaceId || !canEdit) return;
      const defaultPath = baseDir ? `${baseDir}/new-folder` : "new-folder";
      const nextPath = window.prompt("New folder path", defaultPath)?.trim();
      if (!nextPath) return;
      try {
        await window.ade.files.createDirectory({
          workspaceId,
          path: normalizePath(nextPath)
        });
        await refreshTree();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, canEdit, refreshTree]
  );

  const renamePath = React.useCallback(
    async (path: string) => {
      if (!workspaceId || !canEdit) return;
      const nextPath = window.prompt("Rename path", path)?.trim();
      if (!nextPath || nextPath === path) return;
      try {
        await window.ade.files.rename({
          workspaceId,
          oldPath: path,
          newPath: normalizePath(nextPath)
        });
        setOpenTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, path: normalizePath(nextPath) } : tab)));
        setActiveTabPath((current) => (current === path ? normalizePath(nextPath) : current));
        setSelectedNodePath(normalizePath(nextPath));
        await refreshTree();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, canEdit, refreshTree]
  );

  const deletePath = React.useCallback(
    async (path: string) => {
      if (!workspaceId || !canEdit) return;
      const confirmed = window.confirm(`Delete ${path}?`);
      if (!confirmed) return;
      try {
        await window.ade.files.delete({ workspaceId, path });
        setOpenTabs((prev) => prev.filter((tab) => tab.path !== path));
        setActiveTabPath((current) => (current === path ? null : current));
        setSelectedNodePath((current) => (current === path ? null : current));
        await refreshTree();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, canEdit, refreshTree]
  );

  const makeUniqueDestinationPath = React.useCallback(
    (targetDir: string, sourceName: string, isDirectory: boolean) => {
      let sequence = 0;
      while (sequence < 200) {
        const candidateName =
          sequence === 0
            ? sourceName
            : isDirectory
              ? createCopyName(sourceName, sequence)
              : createCopyFileName(sourceName, sequence);
        const candidatePath = joinPath(targetDir, candidateName);
        if (!nodeMap.has(candidatePath)) return candidatePath;
        sequence += 1;
      }
      return joinPath(targetDir, `${sourceName}-${Date.now()}`);
    },
    [nodeMap]
  );

  const copyDirectoryRecursive = React.useCallback(
    async (sourceWorkspaceId: string, sourceDir: string, destDir: string) => {
      await window.ade.files.createDirectory({ workspaceId, path: destDir });
      const children = await window.ade.files.listTree({
        workspaceId: sourceWorkspaceId,
        parentPath: sourceDir,
        depth: 1
      });
      for (const child of children) {
        const childDestPath = joinPath(destDir, child.name);
        if (child.type === "directory") {
          await copyDirectoryRecursive(sourceWorkspaceId, child.path, childDestPath);
        } else {
          const content = await window.ade.files.readFile({
            workspaceId: sourceWorkspaceId,
            path: child.path
          });
          if (content.isBinary) {
            throw new Error(`Binary file copy is not supported yet (${child.path}).`);
          }
          await window.ade.files.createFile({
            workspaceId,
            path: childDestPath,
            content: content.content
          });
        }
      }
    },
    [workspaceId]
  );

  const pasteInto = React.useCallback(
    async (targetDirRaw: string) => {
      if (!workspaceId || !canEdit || !clipboard) return;

      const targetDir = normalizePath(targetDirRaw);
      const sourceName = basename(clipboard.path);
      const destinationPath = makeUniqueDestinationPath(targetDir, sourceName, clipboard.type === "directory");

      if (clipboard.mode === "cut") {
        if (clipboard.workspaceId !== workspaceId) {
          setError("Cut/paste currently works only within the same workspace.");
          return;
        }

        if (destinationPath === clipboard.path) return;
        if (
          clipboard.type === "directory" &&
          destinationPath.startsWith(`${clipboard.path}/`)
        ) {
          setError("Cannot move a folder into itself.");
          return;
        }

        try {
          await window.ade.files.rename({
            workspaceId,
            oldPath: clipboard.path,
            newPath: destinationPath
          });
          setClipboard(null);
          await refreshTree();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      try {
        if (clipboard.type === "file") {
          const source = await window.ade.files.readFile({
            workspaceId: clipboard.workspaceId,
            path: clipboard.path
          });
          if (source.isBinary) {
            throw new Error(`Binary file copy is not supported yet (${clipboard.path}).`);
          }
          await window.ade.files.createFile({
            workspaceId,
            path: destinationPath,
            content: source.content
          });
        } else {
          await copyDirectoryRecursive(clipboard.workspaceId, clipboard.path, destinationPath);
        }
        await refreshTree();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, canEdit, clipboard, makeUniqueDestinationPath, refreshTree, copyDirectoryRecursive]
  );

  const renderTree = React.useCallback(
    (nodes: FileTreeNode[], level = 0): React.ReactNode => {
      return nodes.map((node) => {
        const isExpanded = expanded.has(node.path);
        const isSelected = selectedNodePath === node.path;

        return (
          <div key={node.path}>
            <button
              type="button"
              className={cn(
                "group flex w-full items-center gap-1.5 text-left px-2 h-6 text-[11px] font-mono border-l-2",
                isSelected
                  ? "border-l-accent bg-accent/10 text-fg"
                  : "border-l-transparent text-muted-fg hover:bg-muted/40 hover:text-fg"
              )}
              style={{ paddingLeft: `${8 + level * 14}px` }}
              onClick={() => {
                setSelectedNodePath(node.path);
                if (node.type === "directory") {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                  return;
                }
                void openFile(node.path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedNodePath(node.path);
                if (!containerRef.current) return;
                const bounds = containerRef.current.getBoundingClientRect();
                const left = event.clientX - bounds.left;
                const top = event.clientY - bounds.top;
                setMenu({
                  x: Math.max(8, left),
                  y: Math.max(8, top),
                  nodePath: node.path,
                  nodeType: node.type
                });
              }}
              title={node.path}
            >
              {node.type === "directory" ? (
                <>
                  {isExpanded ? (
                    <CaretDown size={12} className="shrink-0 text-muted-fg" />
                  ) : (
                    <CaretRight size={12} className="shrink-0 text-muted-fg" />
                  )}
                  {isExpanded ? (
                    <FolderOpen size={13} className="shrink-0 text-accent" weight="fill" />
                  ) : (
                    <Folder size={13} className="shrink-0 text-muted-fg" weight="fill" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileText size={12} className="shrink-0 text-muted-fg" />
                </>
              )}

              <span className="truncate">{node.name}</span>

              {node.changeStatus ? (
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold",
                    node.changeStatus === "M" && "bg-amber-500/20 text-amber-300",
                    node.changeStatus === "A" && "bg-emerald-500/20 text-emerald-300",
                    node.changeStatus === "D" && "bg-red-500/20 text-red-300"
                  )}
                >
                  {node.changeStatus}
                </span>
              ) : null}
            </button>

            {node.type === "directory" && isExpanded && node.children?.length ? (
              <div>{renderTree(node.children, level + 1)}</div>
            ) : null}
          </div>
        );
      });
    },
    [expanded, selectedNodePath, openFile]
  );

  const contextBaseDir = React.useMemo(() => {
    if (!menu) return "";
    if (menu.nodeType === "directory") return menu.nodePath;
    return parentPathOf(menu.nodePath);
  }, [menu]);

  const menuX = React.useMemo(() => {
    if (!menu || !containerRef.current) return 8;
    return Math.min(menu.x, Math.max(8, containerRef.current.clientWidth - MIN_CONTEXT_MENU_WIDTH - 8));
  }, [menu]);

  const menuY = React.useMemo(() => {
    if (!menu || !containerRef.current) return 8;
    return Math.min(menu.y, Math.max(8, containerRef.current.clientHeight - 280));
  }, [menu]);

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2 py-1.5">
        <select
          value={workspaceId}
          onChange={(event) => {
            setWorkspaceId(event.target.value);
            setOpenTabs([]);
            setActiveTabPath(null);
            setSelectedNodePath(null);
          }}
          className="h-7 min-w-[140px] max-w-[220px] rounded border border-border/60 bg-surface px-2 text-[11px] font-mono text-fg"
          data-pane-control="true"
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        {activeWorkspace?.isReadOnlyByDefault ? (
          <button
            type="button"
            className={cn(
              "h-7 rounded border px-2 text-[10px] font-mono",
              allowPrimaryEdit
                ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                : "border-border/70 bg-surface text-muted-fg"
            )}
            onClick={() => setAllowPrimaryEdit((prev) => !prev)}
            data-pane-control="true"
          >
            {allowPrimaryEdit ? "Edits On" : "Read Only"}
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="h-7 rounded border border-border/60 bg-surface px-2 text-[10px] font-mono text-muted-fg hover:text-fg"
            onClick={() => void createFile("")}
            data-pane-control="true"
            title="New file"
          >
            <FilePlus size={12} />
          </button>
          <button
            type="button"
            className="h-7 rounded border border-border/60 bg-surface px-2 text-[10px] font-mono text-muted-fg hover:text-fg"
            onClick={() => void createDirectory("")}
            data-pane-control="true"
            title="New folder"
          >
            <FolderPlus size={12} />
          </button>
          <button
            type="button"
            className={cn(
              "h-7 rounded border px-2 text-[10px] font-mono",
              activeTab && canEdit && !activeTab.isBinary
                ? "border-accent/40 bg-accent/15 text-accent hover:text-fg"
                : "border-border/60 bg-surface text-muted-fg/50"
            )}
            onClick={() => void saveActive()}
            disabled={!activeTab || !canEdit || activeTab.isBinary}
            data-pane-control="true"
            title="Save"
          >
            <FloppyDisk size={12} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex shrink-0 items-center justify-between border-b border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-mono text-red-200">
          <span className="truncate">{error}</span>
          <button
            type="button"
            className="ml-2 text-red-100/80 hover:text-red-100"
            onClick={() => setError(null)}
            data-pane-control="true"
          >
            <X size={10} />
          </button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "minmax(180px, 38%) minmax(220px, 1fr)" }}>
        <div className="flex min-h-0 flex-col border-r border-border/40">
          <div className="border-b border-border/30 p-1.5">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter files"
              className="h-7 w-full rounded border border-border/60 bg-surface px-2 text-[11px] font-mono text-fg placeholder:text-muted-fg"
              data-pane-control="true"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto py-1">
            {filteredTree.length ? (
              renderTree(filteredTree)
            ) : (
              <div className="px-3 py-4 text-[11px] font-mono text-muted-fg">No files match.</div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex min-h-8 shrink-0 items-end overflow-x-auto border-b border-border/40">
            {openTabs.length === 0 ? (
              <span className="px-3 py-1.5 text-[10px] font-mono text-muted-fg">No open files</span>
            ) : null}

            {openTabs.map((tab) => {
              const active = activeTabPath === tab.path;
              const dirty = tab.content !== tab.savedContent;
              return (
                <div
                  key={tab.path}
                  className={cn(
                    "group flex h-8 shrink-0 items-center gap-1.5 border-l-2 px-2 text-[10px] font-mono",
                    active
                      ? "border-l-accent bg-accent/10 text-fg"
                      : "border-l-transparent text-muted-fg hover:bg-muted/35 hover:text-fg"
                  )}
                >
                  <button
                    type="button"
                    className="max-w-[180px] truncate text-left"
                    onClick={() => setActiveTabPath(tab.path)}
                    data-pane-control="true"
                  >
                    {basename(tab.path)}
                  </button>
                  {dirty ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}
                  <button
                    type="button"
                    className="opacity-60 hover:opacity-100"
                    onClick={() => closeTab(tab.path)}
                    data-pane-control="true"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="relative min-h-0 flex-1">
            {!activeTab ? (
              <div className="flex h-full items-center justify-center text-[11px] font-mono text-muted-fg">
                Open a file to edit.
              </div>
            ) : null}

            {editorStatus === "failed" && activeTab ? (
              <textarea
                value={activeTab.content}
                readOnly={!canEdit || activeTab.isBinary}
                onChange={(event) => {
                  if (!activeTab) return;
                  setOpenTabs((prev) =>
                    prev.map((tab) => (tab.path === activeTab.path ? { ...tab, content: event.target.value } : tab))
                  );
                }}
                className="h-full w-full resize-none border-none bg-surface p-3 text-[12px] font-mono text-fg outline-none"
                data-pane-control="true"
              />
            ) : null}

            {editorStatus !== "failed" ? (
              <div
                ref={(node) => setEditorHost(node)}
                className={cn("h-full", !activeTab && "hidden")}
                data-pane-control="true"
              />
            ) : null}

            {editorStatus === "loading" && activeTab ? (
              <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-muted-fg">
                Loading editor...
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {menu ? (
        <div
          className="absolute z-40 w-[176px] rounded border border-border/70 bg-card p-1 shadow-float"
          style={{ left: menuX, top: menuY }}
          onPointerDown={(event) => event.stopPropagation()}
          data-pane-control="true"
        >
          {menu.nodeType === "file" ? (
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
              onClick={() => {
                setMenu(null);
                void openFile(menu.nodePath);
              }}
            >
              <FileText size={12} /> Open
            </button>
          ) : null}

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setClipboard({
                workspaceId,
                path: menu.nodePath,
                type: menu.nodeType,
                mode: "cut"
              });
              setMenu(null);
            }}
            disabled={!workspaceId || !canEdit}
          >
            <Scissors size={12} /> Cut
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setClipboard({
                workspaceId,
                path: menu.nodePath,
                type: menu.nodeType,
                mode: "copy"
              });
              setMenu(null);
            }}
            disabled={!workspaceId}
          >
            <Copy size={12} /> Copy
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setMenu(null);
              void pasteInto(contextBaseDir);
            }}
            disabled={!clipboard || !workspaceId || !canEdit}
          >
            <ClipboardText size={12} /> Paste
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setMenu(null);
              void renamePath(menu.nodePath);
            }}
            disabled={!workspaceId || !canEdit}
          >
            <PencilSimple size={12} /> Rename
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setMenu(null);
              void createFile(contextBaseDir);
            }}
            disabled={!workspaceId || !canEdit}
          >
            <FilePlus size={12} /> New File
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-muted-fg hover:bg-muted/40 hover:text-fg"
            onClick={() => {
              setMenu(null);
              void createDirectory(contextBaseDir);
            }}
            disabled={!workspaceId || !canEdit}
          >
            <FolderPlus size={12} /> New Folder
          </button>

          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-[11px] font-mono text-red-300 hover:bg-red-500/15 hover:text-red-200"
            onClick={() => {
              setMenu(null);
              void deletePath(menu.nodePath);
            }}
            disabled={!workspaceId || !canEdit}
          >
            <Trash size={12} /> Delete
          </button>
        </div>
      ) : null}

      {clipboard ? (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-border/70 bg-card/90 px-2 py-1 text-[10px] font-mono text-muted-fg">
          {clipboard.mode.toUpperCase()}: {basename(clipboard.path)}
        </div>
      ) : null}
    </div>
  );
}
