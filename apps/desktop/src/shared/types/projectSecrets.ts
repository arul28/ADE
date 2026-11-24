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

/** `project_secret.copy` (`ade secrets copy --from`): another project's own secrets, copied into this one. */
export type ProjectSecretCopyArgs = {
  /** That project's folder on the machine that copies, or its repository (`owner/name`, a GitHub URL). */
  from: string;
  /** Only these names; without it, every secret of that project's own. */
  names?: string[];
  /** Replace a name this project already has; without it, that name is skipped and reported. */
  overwrite?: boolean;
};

/** What a copy did, by name. Never a value. */
export type ProjectSecretCopyResult = {
  from: string;
  copied: string[];
  /** Names this project had, replaced because `overwrite` was set. */
  replaced: string[];
  /** Names this project had, left as they were. */
  skipped: string[];
};
