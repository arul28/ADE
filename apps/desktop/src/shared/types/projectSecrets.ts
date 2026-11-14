/**
 * A project's view of Passwords & Secrets: "account" syncs to every computer,
 * "device" stays on the computer that saved it.
 */
export type ProjectSecretStorage = "account" | "device";

export type ProjectSecretSummary = {
  name: string;
  createdAt: string;
  updatedAt: string;
  valueLength: number;
  storage: ProjectSecretStorage;
};

export type ProjectSecretsListResult = {
  secrets: ProjectSecretSummary[];
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

export type ProjectSecretDeleteArgs = {
  name: string;
  /** The name again; a delete without it is refused. */
  confirmName: string;
};
