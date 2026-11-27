import { accountRepoScopeKey } from "../../../desktop/src/shared/accountSettingsScope";
import { CLOUD_ACCOUNT_SECRET_KINDS, type CloudAccountSecretKind, type CloudAccountSecrets } from "./contract";
import { readVaultKeys, relayFetch, type RelayEnv } from "./accountVault";
import { fail, json } from "./http";

/**
 * Which secrets the account keeps, for a client with no computer
 * (`GET /cloud/account-secrets?kind=&origin=`): MCP secret status (kind
 * `secret`, keys `mcp/<server>/…`), the API keys (`provider_api_key`, and the
 * older `cloud-key-*` items under `integration`), project secrets.
 *
 * Keys and times only, NEVER a value: the relay's keys read opens nothing,
 * and on an older relay the values of the full read are dropped here before
 * anything else sees them. Kinds that are not secrets a person names
 * (provider sign-ins, the CTO copy, ADE MCP's own) are never listed.
 */

const KINDS: ReadonlySet<string> = new Set(CLOUD_ACCOUNT_SECRET_KINDS);

export async function routeAccountSecrets(request: Request, url: URL, env: RelayEnv): Promise<Response> {
  if (request.method !== "GET") return fail("not_found", "Daex Cloud has no such route.", 404);
  const authorization = request.headers.get("authorization");
  if (!authorization) return fail("unauthorized", "Sign in to Daex to use Daex Cloud.", 401);
  if (!relayFetch(env)) return fail("unavailable", "Daex can't reach your account's secrets right now. Try again soon.", 503);

  const kindParam = url.searchParams.get("kind");
  const kind = kindParam?.trim() || null;
  if (kind && !KINDS.has(kind)) return fail("bad_request", "Daex Cloud doesn't list that kind of secret.", 400);
  const originParam = url.searchParams.get("origin");
  const scope = originParam ? accountRepoScopeKey(originParam) : "all";
  if (!scope) return fail("bad_request", "That isn't a repository Daex can name.", 400);

  const keys = await readVaultKeys(env, authorization, scope, kind ?? undefined);
  if (!keys) return fail("unavailable", "Daex can't reach your account's secrets right now. Try again soon.", 503);
  const body: CloudAccountSecrets = {
    secrets: keys
      .filter((row) => KINDS.has(row.kind))
      .map((row) => ({ scope: row.scope, kind: row.kind as CloudAccountSecretKind, key: row.key, updatedAt: row.updatedAt })),
  };
  return json(body);
}
