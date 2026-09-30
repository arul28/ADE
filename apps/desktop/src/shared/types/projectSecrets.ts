export type ProjectSecretStorage = "account" | "device";

export type ProjectSecretSummary = {
  name: string;
  createdAt: string;
  updatedAt: string;
  valueLength: number;
  storage: ProjectSecretStorage;
};

export type ProjectSecretsStorageInfo = {
  path: string;
  encrypted: boolean;
  scope: "project";
};

export type ProjectSecretsListResult = {
  secrets: ProjectSecretSummary[];
  storage: ProjectSecretsStorageInfo;
};

export type ProjectSecretValueResult = ProjectSecretSummary & {
  value: string;
};

export type ProjectSecretSetArgs = {
  name: string;
  value: string;
  storage?: ProjectSecretStorage;
};

export type ProjectSecretGetArgs = {
  name: string;
};

/**
 * Outcome of a pull from the account vault, including the case where it could
 * not run at all.
 *
 * `unavailable` is a distinct answer, not an empty one. "Nothing to pull" and
 * "this machine cannot pull right now" are different sentences to show a person,
 * and collapsing them told a signed-out user their secrets were up to date.
 */
export type ProjectSecretPullResult =
  | {
    state: "pulled";
    /** Names this machine did not have. */
    added: number;
    /** Account-scoped names whose vault copy was newer. */
    updated: number;
    /**
     * Account-scoped names deleted on another machine, dropped here too.
     *
     * Optional because a runtime from before account-wide deletes answers
     * without it, and that is still a pull result.
     */
    removed?: number;
  }
  | { state: "unavailable" };

export type ProjectSecretDeleteArgs = {
  name: string;
  confirmName?: string;
};

export type ProjectSecretEnvFile = {
  fileName: string;
  content: string;
};

export type ProjectSecretEnvEntry = {
  name: string;
  value: string;
  exists: boolean;
};

export type ProjectSecretsImportPreview = {
  fileName: string;
  secrets: ProjectSecretEnvEntry[];
};

export type ProjectSecretsImportArgs = {
  secrets: Array<Pick<ProjectSecretEnvEntry, "name" | "value">>;
};

export type ProjectSecretsImportResult = {
  imported: string[];
  replaced: string[];
};

export type ProjectSecretsExportResult = {
  filePath: string;
  secretCount: number;
};
