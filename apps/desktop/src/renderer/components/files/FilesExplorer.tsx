import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CaretDown as ChevronDown,
  CaretRight as ChevronRight,
  FilePlus as FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  MagnifyingGlass as Search,
  TextAlignLeft,
  X,
} from "@phosphor-icons/react";
import type { FileTreeNode } from "../../../shared/types";
import { arePathsEqual, normalizePath } from "../../lib/pathUtils";
import { modifierKeyLabel } from "../../lib/platform";
import { COLORS, LABEL_STYLE, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { SmartTooltip } from "../ui/SmartTooltip";
import { changeStatusColor, changeStatusLabel, changeStatusTitle, getFileIcon } from "./filePresentation";

const ROW_HEIGHT = 26;

type InlineRenameRequest = {
  path: string;
  nonce: number;
} | null;

type ExplorerRow = {
  node: FileTreeNode;
  level: number;
};

export type FilesExplorerContextMenuEvent = {
  x: number;
  y: number;
  nodePath: string;
  nodeType: "file" | "directory";
};

export type FilesExplorerProps = {
  tree: FileTreeNode[];
  expanded: Set<string>;
  selectedNodePath: string | null;
  activeTabPath: string | null;
  activeContextDir: string;
  workspaceComparisonRoot: string | null;
  searchQuery: string;
  inlineRenameRequest: InlineRenameRequest;
  onSearchQueryChange: (value: string) => void;
  onOpenQuickOpen: () => void;
  onOpenContentSearch: () => void;
  onCreateFile: (basePath: string) => void;
  onCreateDirectory: (basePath: string) => void;
  onToggleDirectory: (path: string, isExpanded: boolean, hasLoadedChildren: boolean) => void;
  onOpenFile: (path: string) => void;
  onSelectNode: (path: string) => void;
  onContextMenu: (event: FilesExplorerContextMenuEvent) => void;
  onRenamePath: (sourcePath: string, destinationPath: string) => Promise<void>;
  onInlineRenameSettled: () => void;
};

function parentDirOfPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  if (!normalized) return "";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function destinationPathForName(sourcePath: string, nextName: string): string {
  const parent = parentDirOfPath(sourcePath);
  return parent ? `${parent}/${nextName}` : nextName;
}

function matchesQuery(node: FileTreeNode, query: string): boolean {
  if (!query) return true;
  const haystack = `${node.name} ${node.path}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

function flattenVisibleRows(args: {
  nodes: FileTreeNode[];
  expanded: Set<string>;
  query: string;
  level?: number;
}): ExplorerRow[] {
  const level = args.level ?? 0;
  const rows: ExplorerRow[] = [];
  const query = args.query.trim().toLowerCase();

  for (const node of args.nodes) {
    const children = node.children ?? [];
    if (!query) {
      rows.push({ node, level });
      if (node.type === "directory" && args.expanded.has(node.path) && children.length) {
        rows.push(...flattenVisibleRows({ nodes: children, expanded: args.expanded, query, level: level + 1 }));
      }
      continue;
    }

    const childRows = children.length
      ? flattenVisibleRows({ nodes: children, expanded: args.expanded, query, level: level + 1 })
      : [];
    if (matchesQuery(node, query) || childRows.length > 0) {
      rows.push({ node, level });
      rows.push(...childRows);
    }
  }

  return rows;
}

export function FilesExplorer({
  tree,
  expanded,
  selectedNodePath,
  activeTabPath,
  activeContextDir,
  workspaceComparisonRoot,
  searchQuery,
  inlineRenameRequest,
  onSearchQueryChange,
  onOpenQuickOpen,
  onOpenContentSearch,
  onCreateFile,
  onCreateDirectory,
  onToggleDirectory,
  onOpenFile,
  onSelectNode,
  onContextMenu,
  onRenamePath,
  onInlineRenameSettled,
}: FilesExplorerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameSubmittingRef = useRef(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const rows = useMemo(
    () => flattenVisibleRows({ nodes: tree, expanded, query: searchQuery }),
    [tree, expanded, searchQuery],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  useEffect(() => {
    if (!inlineRenameRequest?.path) return;
    const target = rows.find((row) => arePathsEqual(row.node.path, inlineRenameRequest.path, workspaceComparisonRoot));
    setRenamingPath(inlineRenameRequest.path);
    setRenameValue(target?.node.name ?? inlineRenameRequest.path.split("/").pop() ?? inlineRenameRequest.path);
    setRenameError(null);
    onInlineRenameSettled();
  }, [inlineRenameRequest, onInlineRenameSettled, rows, workspaceComparisonRoot]);

  useEffect(() => {
    if (!renamingPath) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renamingPath]);

  const cancelRename = () => {
    setRenamingPath(null);
    setRenameValue("");
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renamingPath) return;
    if (renameSubmittingRef.current) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameError("Name is required.");
      return;
    }
    if (nextName === "." || nextName === "..") {
      setRenameError("Name cannot be '.' or '..'.");
      return;
    }
    if (nextName.includes("/") || nextName.includes("\\")) {
      setRenameError("Use a file name, not a path.");
      return;
    }
    const destinationPath = destinationPathForName(renamingPath, nextName);
    if (arePathsEqual(destinationPath, renamingPath, workspaceComparisonRoot)) {
      cancelRename();
      return;
    }
    try {
      renameSubmittingRef.current = true;
      await onRenamePath(renamingPath, destinationPath);
      cancelRename();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      renameSubmittingRef.current = false;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: COLORS.cardBg, borderRadius: 8 }}>
      <div style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.border}` }} data-tour="files.searchBar">
        <div className="relative flex items-center">
          <Search size={14} weight="regular" className="pointer-events-none absolute" style={{ left: 8, color: COLORS.textDim }} />
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            aria-label="Filter paths"
            placeholder="Filter paths"
            style={{
              height: 30,
              width: "100%",
              padding: "0 28px 0 28px",
              fontSize: 11,
              fontFamily: MONO_FONT,
              fontWeight: 500,
              background: COLORS.recessedBg,
              borderRadius: 8,
              border: `1px solid ${COLORS.outlineBorder}`,
              color: COLORS.textSecondary,
              outline: "none",
            }}
            onFocus={(event) => { event.currentTarget.style.borderColor = COLORS.accent; }}
            onBlur={(event) => { event.currentTarget.style.borderColor = COLORS.outlineBorder; }}
          />
          {searchQuery.trim() ? (
            <button
              type="button"
              className="absolute"
              style={{ right: 4, top: "50%", transform: "translateY(-50%)", display: "inline-flex", width: 18, height: 18, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={() => onSearchQueryChange("")}
              title="Clear filter"
              aria-label="Clear path filter"
            >
              <X size={10} />
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <SmartTooltip content={{ label: "Content search", description: "Search file contents in this workspace.", shortcut: `${modifierKeyLabel}+Shift+F` }}>
            <button
              type="button"
              style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}
              onClick={onOpenContentSearch}
              onMouseEnter={(event) => { event.currentTarget.style.borderColor = COLORS.accent; event.currentTarget.style.color = COLORS.accent; }}
              onMouseLeave={(event) => { event.currentTarget.style.borderColor = COLORS.outlineBorder; event.currentTarget.style.color = COLORS.textSecondary; }}
            >
              <TextAlignLeft size={10} /> CONTENT
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "Quick open", description: "Search and open any file in the project.", shortcut: `${modifierKeyLabel}+P` }}>
            <button
              type="button"
              style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}
              onClick={onOpenQuickOpen}
              onMouseEnter={(event) => { event.currentTarget.style.borderColor = COLORS.accent; event.currentTarget.style.color = COLORS.accent; }}
              onMouseLeave={(event) => { event.currentTarget.style.borderColor = COLORS.outlineBorder; event.currentTarget.style.color = COLORS.textSecondary; }}
            >
              <Search size={10} /> QUICK OPEN
            </button>
          </SmartTooltip>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1" style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.border}` }}>
        <SmartTooltip content={{ label: "New file", description: "Create a new file in the current directory." }}>
          <button
            type="button"
            title="New file"
            aria-label="New file"
            style={{ ...outlineButton({ height: 24, padding: "0 6px", fontSize: 10 }) }}
            onClick={() => onCreateFile(activeContextDir)}
            onMouseEnter={(event) => { event.currentTarget.style.borderColor = COLORS.accent; event.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(event) => { event.currentTarget.style.borderColor = COLORS.outlineBorder; event.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <FilePlus2 size={12} weight="regular" />
          </button>
        </SmartTooltip>
        <SmartTooltip content={{ label: "New folder", description: "Create a new folder in the current directory." }}>
          <button
            type="button"
            title="New folder"
            aria-label="New folder"
            style={{ ...outlineButton({ height: 24, padding: "0 6px", fontSize: 10 }) }}
            onClick={() => onCreateDirectory(activeContextDir)}
            onMouseEnter={(event) => { event.currentTarget.style.borderColor = COLORS.accent; event.currentTarget.style.color = COLORS.accent; }}
            onMouseLeave={(event) => { event.currentTarget.style.borderColor = COLORS.outlineBorder; event.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <FolderPlus size={12} weight="regular" />
          </button>
        </SmartTooltip>
        <span className="ml-auto" style={{ ...LABEL_STYLE, fontSize: 9, color: COLORS.textDim }}>
          {rows.length} rows
        </span>
      </div>

      {renameError ? (
        <div style={{ padding: "5px 10px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.danger, fontFamily: MONO_FONT, fontSize: 11 }}>
          {renameError}
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" style={{ paddingTop: 4, paddingBottom: 4 }} data-tour="files.fileTree">
        {rows.length === 0 ? (
          <div style={{ padding: 12, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
            {searchQuery.trim() ? "No matching paths." : "No files."}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              const { node, level } = row;
              const isExpanded = expanded.has(node.path);
              const isActive = (activeTabPath != null && arePathsEqual(activeTabPath, node.path, workspaceComparisonRoot))
                || (selectedNodePath != null && arePathsEqual(selectedNodePath, node.path, workspaceComparisonRoot));
              const statusColor = changeStatusColor(node.changeStatus ?? null);
              const statusLabel = changeStatusLabel(node.changeStatus ?? null);
              const fileIcon = node.type === "file" ? getFileIcon(node.name) : null;
              const FileIcon = fileIcon?.icon;
              const folderColor = isActive ? COLORS.accent : COLORS.textMuted;
              const isRenaming = renamingPath != null && arePathsEqual(renamingPath, node.path, workspaceComparisonRoot);
              const rowStyle: React.CSSProperties = {
                height: ROW_HEIGHT,
                paddingLeft: `${10 + level * 14}px`,
                paddingRight: 8,
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: isActive ? COLORS.textPrimary : COLORS.textSecondary,
                background: isActive ? COLORS.accentSubtle : "transparent",
                border: "none",
                borderLeft: isActive ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                cursor: isRenaming ? "text" : "pointer",
              };
              const handleRowActivate = () => {
                onSelectNode(node.path);
                if (node.type === "directory") {
                  onToggleDirectory(node.path, isExpanded, Boolean(node.children));
                  return;
                }
                onOpenFile(node.path);
              };
              const handleRowContextMenu = (event: React.MouseEvent) => {
                event.preventDefault();
                onSelectNode(node.path);
                onContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  nodePath: node.path,
                  nodeType: node.type,
                });
              };
              const handleRowMouseEnter = (event: React.MouseEvent<HTMLElement>) => {
                if (!isActive) event.currentTarget.style.background = COLORS.hoverBg;
              };
              const handleRowMouseLeave = (event: React.MouseEvent<HTMLElement>) => {
                if (!isActive) event.currentTarget.style.background = "transparent";
              };
              const rowContent = (
                <>
                  {level > 0 ? (
                    <span className="pointer-events-none absolute inset-y-0 left-0">
                      {Array.from({ length: level }).map((_, idx) => (
                        <span
                          key={`${node.path}:guide:${idx}`}
                          className="absolute inset-y-0"
                          style={{ left: `${10 + idx * 14 + 5}px`, width: 1, background: "color-mix(in srgb, var(--color-border) 80%, transparent)" }}
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
                        : null}
                    </>
                  )}
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Rename ${node.name}`}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitRename();
                        }
                      }}
                      onBlur={() => void submitRename()}
                      style={{
                        minWidth: 0,
                        flex: 1,
                        height: 20,
                        padding: "0 4px",
                        fontFamily: MONO_FONT,
                        fontSize: 11,
                        color: COLORS.textPrimary,
                        background: COLORS.recessedBg,
                        border: `1px solid ${COLORS.accent}`,
                        borderRadius: 4,
                        outline: "none",
                      }}
                    />
                  ) : (
                    <span className="truncate">{node.name}</span>
                  )}
                  {node.type === "directory" && node.changeStatus ? (
                    <span title={changeStatusTitle(node.changeStatus)} style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                  ) : null}
                  {node.type === "file" && statusLabel ? (
                    <span style={{
                      marginLeft: "auto",
                      flexShrink: 0,
                      fontFamily: MONO_FONT,
                      fontSize: 9,
                      fontWeight: 700,
                      color: statusColor,
                      padding: "1px 5px",
                      background: `${statusColor}18`,
                      borderRadius: 4,
                    }} title={changeStatusTitle(node.changeStatus)}>
                      {statusLabel}
                    </span>
                  ) : null}
                </>
              );

              return (
                <div
                  key={node.path}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  {isRenaming ? (
                    <div
                      className="group relative flex w-full items-center gap-1.5 text-left transition-colors"
                      style={rowStyle}
                      onContextMenu={handleRowContextMenu}
                      onMouseEnter={handleRowMouseEnter}
                      onMouseLeave={handleRowMouseLeave}
                      title={node.path}
                    >
                      {rowContent}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="group relative flex w-full items-center gap-1.5 text-left transition-colors"
                      style={rowStyle}
                      onClick={handleRowActivate}
                      onContextMenu={handleRowContextMenu}
                      onMouseEnter={handleRowMouseEnter}
                      onMouseLeave={handleRowMouseLeave}
                      title={node.path}
                    >
                      {rowContent}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
