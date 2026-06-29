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
