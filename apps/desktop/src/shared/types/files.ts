// ---------------------------------------------------------------------------
// Files workspace types
// ---------------------------------------------------------------------------

export type FilesWorkspace = {
  id: string;
  kind: "primary" | "worktree" | "attached";
  laneId: string | null;
  name: string;
  /** Stored branch ref for this lane workspace (e.g. refs/heads/foo). */
  branchRef?: string;
  rootPath: string;
  isReadOnlyByDefault: boolean;
  mobileReadOnly?: boolean;
};

export type FilesListWorkspacesArgs = {
  includeArchived?: boolean;
};

export type FileTreeChangeStatus = "M" | "A" | "D" | null;

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
};

export type FilesListTreeArgs = {
  workspaceId: string;
  parentPath?: string;
  depth?: number;
  includeIgnored?: boolean;
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
};

export type FilesReadFileArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
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
