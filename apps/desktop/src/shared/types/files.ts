// ---------------------------------------------------------------------------
// Files workspace types
// ---------------------------------------------------------------------------

export type FilesWorkspace = {
  id: string;
  kind: "primary" | "worktree" | "attached" | "external";
  laneId: string | null;
  name: string;
  /** Stored branch ref for this lane workspace (e.g. refs/heads/foo). */
  branchRef?: string;
  rootPath: string;
  isReadOnlyByDefault: boolean;
  mobileReadOnly?: boolean;
};

export const EXTERNAL_FILES_WORKSPACE_ID_PREFIX = "external-local:";

export type FilesListWorkspacesArgs = {
  includeArchived?: boolean;
};

export type FileTreeChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "unknown"
  // Legacy short codes are accepted while older callers/tests migrate.
  | "M"
  | "A"
  | "D"
  | null;

export type FileTreeNode = {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "directory";
  hasChildren?: boolean;
  children?: FileTreeNode[];
  changeStatus?: FileTreeChangeStatus;
  size?: number;
  // Set on a directory node when its children list was truncated at MAX_TREE_CHILDREN_PER_DIRECTORY.
  childrenTruncated?: boolean;
  // Offset to request the next page of children via listTreeChildren, or null/undefined
  // when all children are loaded. Replaces the old silent truncation behaviour.
  loadMoreOffset?: number | null;
};

export type FilesListTreeArgs = {
  workspaceId: string;
  parentPath?: string;
  depth?: number;
  includeIgnored?: boolean;
  /** Prefer cached/background Git decorations unless the caller explicitly needs fresh status. */
  forceFreshStatus?: boolean;
};

export type FilesRefreshGitDecorationsArgs = {
  workspaceId: string;
  /** Block on a fresh `git status` instead of returning the cached snapshot. */
  forceFresh?: boolean;
};

export type FilesListTreeChildrenArgs = {
  workspaceId: string;
  parentPath: string;
  /** Page offset into the directory's sorted, filtered children. Defaults to 0. */
  offset?: number;
  /** Page size, clamped to [1, 2000]. Defaults to 500. */
  limit?: number;
  includeIgnored?: boolean;
};

export type FilesListTreeChildrenResult = {
  parentPath: string;
  children: FileTreeNode[];
  offset: number;
  limit: number;
  /** Total visible children in the directory after filtering. */
  total: number;
  /** Offset for the next page, or null when this page is the last. */
  nextOffset: number | null;
};

export type FileTreeStatusEntry = {
  path: string;
  changeStatus: FileTreeChangeStatus;
};

/**
 * Resolved Git decorations for a workspace, sent independently of the tree
 * structure so `listTree` never blocks on `git status`. `directories` already
 * includes every ancestor of a changed file, so callers can apply it flat
 * without recomputing roll-ups.
 */
export type FilesGitStatusEvent = {
  workspaceId: string;
  files: FileTreeStatusEntry[];
  directories: FileTreeStatusEntry[];
  /**
   * Set when a dirty tree was large enough that the entry lists were capped
   * (shallowest paths kept). Deep files then render undecorated instead of the
   * response growing past the sync transport's byte budget.
   */
  truncated?: boolean;
};

export type FilePreviewKind = "text" | "image" | "binary";

export type FileContent = {
  content: string;
  encoding: "utf-8" | "base64";
  size: number;
  languageId: string;
  isBinary: boolean;
  previewKind?: FilePreviewKind;
  mimeType?: string | null;
  dataUrl?: string;
  contentOmitted?: boolean;
  omittedReason?: "too_large" | "unsupported_binary";
  // Streaming fields: when a text file exceeds the inline editor limit, `content`
  // holds the first chunk, `isPartial` is true, and the rest is fetched via
  // readFileRange starting at `nextOffset`. `totalSize` is the file's full byte size.
  totalSize?: number;
  isPartial?: boolean;
  rangeStart?: number;
  rangeEnd?: number;
  nextOffset?: number | null;
};

export type FilesReadFileRangeArgs = {
  workspaceId: string;
  path: string;
  /** Byte offset to start reading from. */
  offset: number;
  /** Bytes to read, clamped to [1, 512KB]. Defaults to 256KB. */
  length?: number;
};

export type FilesReadFileRangeResult = {
  path: string;
  encoding: "utf-8" | "base64";
  /** UTF-8 text slice (encoding "utf-8") or base64 bytes (encoding "base64"). */
  content: string;
  rangeStart: number;
  /** Exclusive end byte offset actually returned (may trim a partial UTF-8 char). */
  rangeEnd: number;
  totalSize: number;
  /** Next byte offset to request, or null at EOF. */
  nextOffset: number | null;
  eof: boolean;
};

export type FilesGitBlameArgs = {
  workspaceId: string;
  path: string;
  /** Optional 1-based inclusive line range; omitted = whole file. */
  startLine?: number;
  endLine?: number;
};

export type FilesGitBlameLine = {
  line: number;
  sha: string;
  author: string;
  /** Commit time as epoch seconds. */
  authorTime: number;
  summary: string;
};

export type FilesGitBlameResult = {
  path: string;
  lines: FilesGitBlameLine[];
};

export type FilesReadFileArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
};

export type FilesOpenExternalPathArgs = {
  /** Absolute local path from Finder, Electron open-file, or OS drag/drop. */
  path: string;
};

export type FilesOpenExternalPathResult = {
  workspace: FilesWorkspace;
  /** Relative file path to open, or null when the external path is a directory. */
  openPath: string | null;
  pathType: "file" | "directory";
};

export type FilesWriteTextArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
  text: string;
};

export type FilesCreateFileArgs = {
  workspaceId: string;
  path: string; // relative path
  content?: string;
};

export type FilesCreateDirectoryArgs = {
  workspaceId: string;
  path: string; // relative path
};

export type FilesRenameArgs = {
  workspaceId: string;
  oldPath: string;
  newPath: string;
};

export type FilesDeleteArgs = {
  workspaceId: string;
  path: string;
};

export type FilesWatchArgs = {
  workspaceId: string;
  includeIgnored?: boolean;
};

export type FileChangeEvent = {
  workspaceId: string;
  type: "created" | "modified" | "deleted" | "renamed";
  path: string;
  oldPath?: string;
  ts: string;
  /**
   * Set when this client caused the change. The web adapter tags its own
   * writes so the Files workbench can skip reloading bytes it just sent — the
   * relay transport has no host-side watcher, so an untagged `modified` event
   * is a genuine remote change.
   */
  origin?: "self";
};

export type FilesQuickOpenArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
  includeIgnored?: boolean;
};

export type FilesQuickOpenItem = {
  path: string;
  score: number;
};

export type FilesSearchTextArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
  includeIgnored?: boolean;
};

export type FilesSearchTextMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};
