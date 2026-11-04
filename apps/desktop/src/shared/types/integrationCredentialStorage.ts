/**
 * Where an integration credential is kept. "account" means it reaches the
 * person's other computers through the ADE account vault; "device" means it
 * stays on this one, and `reason`/`message` say why.
 */
export type IntegrationCredentialStorage = {
  storage: "account" | "device";
  reason: "no_remote" | "signed_out" | "vault_unavailable" | null;
  message: string | null;
};
