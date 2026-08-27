export type ProjectSecretSummary = {
  name: string;
  createdAt: string;
  updatedAt: string;
  valueLength: number;
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
};

export type ProjectSecretGetArgs = {
  name: string;
};

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

/**
 * What an ADE project secret may be called.
 *
 * Lives here rather than beside the store because two very different modules
 * need the same answer: `projectSecretService` normalizes every name it writes,
 * and the plugin manifest parser validates the names a plugin DECLARES it will
 * read. A plugin that declared a name the store could never hold would pass
 * parsing and then be refused at every call, which reads as a broken host
 * rather than as a typo in the manifest.
 */
export const PROJECT_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export function isValidProjectSecretName(value: unknown): value is string {
  return typeof value === "string" && PROJECT_SECRET_NAME_PATTERN.test(value);
}
