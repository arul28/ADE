import { useMemo } from "react";
import { DEFAULT_API_CREDENTIAL_ID, type ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import { useAdeCloudAccountRead } from "../../../../lib/adeCloudAccountRead";

const PROVIDER_KEY_NAMES_CALL = { call: "accountSecrets", kind: "provider_api_key" } as const;

/** The account vault name of one stored key: `<provider>`, or `<provider>#<credentialId>` for a second key. */
export function accountKeyNameOf(credential: Pick<ApiCredentialSummary, "provider" | "credentialId">): string {
  const provider = credential.provider.trim().toLowerCase();
  return credential.credentialId === DEFAULT_API_CREDENTIAL_ID ? provider : `${provider}#${credential.credentialId}`;
}

/**
 * The names (never the values) of the API keys your ADE account holds for
 * every computer. Null while unknown: signed out, an older server, or a read
 * that failed. A caller shows nothing then, never a false "this computer only".
 * One read when the panel opens, again on focus (at most once a minute) and
 * on `refresh`; no timer.
 */
export function useAccountProviderKeyNames(): { names: ReadonlySet<string> | null; refresh: () => void } {
  const { state, retry } = useAdeCloudAccountRead(PROVIDER_KEY_NAMES_CALL);
  const secrets = state.status === "ready" ? state.data.secrets : null;
  const names = useMemo(() => {
    if (!secrets) return null;
    const next = new Set<string>();
    for (const secret of secrets) {
      if (secret.scope === "all" && secret.kind === "provider_api_key") next.add(secret.key.trim().toLowerCase());
    }
    return next;
  }, [secrets]);
  return { names, refresh: retry };
}
