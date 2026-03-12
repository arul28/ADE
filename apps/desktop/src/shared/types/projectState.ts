export type AdePathKind = "tracked" | "ignored";

export type AdePathType = "file" | "directory";

export type AdeHealthSeverity = "info" | "warning" | "error";

export type AdePathEntry = {
  relativePath: string;
  absolutePath: string;
  kind: AdePathKind;
  pathType: AdePathType;
  exists: boolean;
  notes?: string[];
};

export type AdeHealthIssue = {
  code: string;
  severity: AdeHealthSeverity;
  message: string;
  relativePath?: string | null;
};

export type AdeSyncActionKind =
  | "create_dir"
  | "create_file"
  | "move"
  | "delete"
  | "rewrite"
  | "truncate_jsonl"
  | "scrub_exclude"
  | "reconcile";

export type AdeSyncAction = {
  kind: AdeSyncActionKind;
  relativePath: string;
  detail?: string | null;
};

export type AdeCleanupResult = {
  changed: boolean;
  actions: AdeSyncAction[];
};

export type AdeProjectSnapshot = {
  rootPath: string;
  adeDir: string;
  lastCheckedAt: string;
  entries: AdePathEntry[];
  health: AdeHealthIssue[];
  cleanup: AdeCleanupResult;
  config: {
    sharedPath: string;
    localPath: string;
    secretPath: string;
    trust: {
      sharedHash: string;
      localHash: string;
      approvedSharedHash?: string | null;
      requiresSharedTrust: boolean;
    };
  };
};

export type AdeProjectEvent = {
  type: "config-changed";
  at: string;
  filePath: string;
  snapshot: AdeProjectSnapshot;
};
