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
