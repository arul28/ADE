/** The id used by the legacy one-key-per-provider store. */
export const DEFAULT_API_CREDENTIAL_ID = "default";

/** A non-secret description of one provider credential. */
export type ApiCredentialSummary = {
  provider: string;
  credentialId: string;
  label: string;
  envVar?: string;
  baseUrl?: string;
  protocol?: "openai-compatible" | "openai-responses" | "anthropic";
  models?: string[];
  source: "store" | "env" | "config";
  createdAt: string;
  updatedAt: string;
  maskedTail?: string;
};

export type ApiCredentialStoreArgs = {
  provider: string;
  credentialId?: string;
  label: string;
  key: string;
  envVar?: string;
  baseUrl?: string;
  protocol?: ApiCredentialSummary["protocol"];
  models?: string[];
  deviceOnly?: boolean;
};

export type ApiCredentialListArgs = {
  provider?: string;
};

export type ApiCredentialGetArgs = {
  provider: string;
  credentialId?: string;
};

export type ApiCredentialRemoveArgs = {
  provider: string;
  credentialId?: string;
};

// These aliases keep the argument names convenient for callers that describe
// the operation first while retaining the shared ApiCredential* naming.
export type StoreApiCredentialArgs = ApiCredentialStoreArgs;
export type ListApiCredentialsArgs = ApiCredentialListArgs;
export type GetApiCredentialArgs = ApiCredentialGetArgs;
export type RemoveApiCredentialArgs = ApiCredentialRemoveArgs;
