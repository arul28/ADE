/**
 * Lending an official plugin ADE's OWN public OAuth client id.
 *
 * ## The gap this closes
 *
 * `pluginCredentialHandoff.ts` moves a connection that already exists. That is
 * the release-day path and it is the whole of it: a user who installs the
 * plugin on a fresh machine has no connection to inherit, and a user who
 * declined has chosen not to. Both were left with a Connect button that could
 * not build an authorize URL, because `client_id` identifies ADE to the
 * provider and no verb handed a plugin ADE's. The only reachable path was a
 * pasted API key — a real capability regression against the compiled
 * integration the plugin replaces, which offers "Sign in with Linear" out of
 * the box on a machine that has never been connected.
 *
 * ## Why lending the ID is safe
 *
 * ADE's bundled Linear app is a PUBLIC PKCE client: the id ships in the binary
 * and no secret ships at all (`cto/linearAppClient.ts:14`, and
 * `cto/linearCredentialService.ts:19-23` — "This is a public value (visible in
 * the auth URL); no secret is bundled (we use PKCE)"). The id is a query
 * parameter of every authorize URL ADE has ever opened, so a plugin that wanted
 * it could read it off one sign-in. Handing it over discloses nothing.
 *
 * A client SECRET is a different object entirely — it is ADE's identity to the
 * provider, and a plugin holding one could mint tokens in ADE's name on every
 * machine it is installed on. This module cannot leak one by construction:
 * every entry below resolves its id from a compile-time public constant and
 * never touches the credential store, `PluginOfficialOAuthClient` has no field
 * to put a secret in, and {@link assertNoClientSecret} re-checks the answer on
 * the way out anyway. Three independent reasons, because "we simply never put
 * one there" is the kind of invariant a later edit breaks quietly.
 *
 * ## Why ownership, and not a permission
 *
 * The same rule the credential handoff uses, and deliberately the same
 * mechanism: the honoured owner of the built-in surface ADE bundles the client
 * for, from `BUILTIN_SURFACE_OWNERS`, and nothing the plugin says about itself.
 * A plugin cannot become the Linear plugin by declaring that it is.
 *
 * A community plugin never calls this. It registers its own app with the
 * provider and declares that app's public id in its manifest
 * (`authSessions[].clientId`), which is why that field exists.
 */

import { builtinSurfaceOwnerForPlugin } from "../../../shared/plugins/builtinSurfaces";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";
import { PluginSdkError, type PluginOfficialOAuthClient } from "../../../shared/plugins/sdk";
import { ADE_LINEAR_APP_CLIENT_ID } from "../cto/linearAppClient";

/**
 * One provider ADE bundles a registered OAuth app for.
 *
 * `resolveClientId` is a function rather than a string so an environment
 * override is read at call time: `ADE_LINEAR_CLIENT_ID` is how a developer
 * points a build at a test app, and a value captured at module load would keep
 * answering with the shipped one for the life of the process.
 */
type OfficialOAuthClient = {
  /** The surface whose owner may borrow this. */
  builtin: PluginBuiltinSurfaceId;
  resolveClientId: () => string | null;
  authorizeUrl?: string;
  /**
   * The scopes ADE's own integration asks for, when the registration depends
   * on them. See the Linear entry.
   */
  scopes?: string[];
};

/**
 * Linear's ADE app.
 *
 * `admin` is in the scope list and it is not ambition. Linear only delivers
 * data-change webhooks for a workspace whose authorization carries it, so an
 * ADE-app connection made without `admin` is one whose ingress channel silently
 * never fires — and a webhook that never fires is indistinguishable from a
 * workspace where nothing happened (`cto/linearOAuthService.ts:257-261`). A
 * plugin borrowing this client id is borrowing that registration, so it is told
 * which grant the registration expects rather than left to guess.
 */
const LINEAR_OFFICIAL_CLIENT: OfficialOAuthClient = {
  builtin: "linear",
  resolveClientId: () => process.env.ADE_LINEAR_CLIENT_ID?.trim() || ADE_LINEAR_APP_CLIENT_ID,
  authorizeUrl: "https://linear.app/oauth/authorize",
  scopes: ["read", "write", "admin"],
};

/**
 * Every provider ADE lends a client id for, keyed by the provider name a plugin
 * asks with.
 *
 * Keys are lowercase and the lookup lowercases what it is given, so a plugin
 * asking for `"Linear"` gets the same answer as one asking for `"linear"`. Two
 * spellings of one provider would be two different refusals, and neither would
 * tell the author which one the host wanted.
 */
const OFFICIAL_OAUTH_CLIENTS: Readonly<Record<string, OfficialOAuthClient>> = {
  linear: LINEAR_OFFICIAL_CLIENT,
};

/**
 * The last gate before the answer leaves the host.
 *
 * Nothing in this module can currently produce a secret, and that is exactly
 * why this exists: the check is cheap, it runs on the value that is actually
 * about to cross the process boundary, and it fails loudly rather than
 * disclosing. A future entry that resolved its id out of a stored blob — the
 * shape `linear.oauthClient.v1` already has — is the edit this catches.
 */
export function assertNoClientSecret(answer: PluginOfficialOAuthClient): void {
  for (const key of Object.keys(answer)) {
    const lowered = key.toLowerCase();
    if (lowered.includes("secret") || lowered.includes("password") || lowered.includes("token")) {
      throw new Error(
        `pluginOfficialClients: refusing to answer with a "${key}" field —`
          + " an official client answer carries the public id and nothing else.",
      );
    }
  }
}

/**
 * The refusal a non-owner gets, and the refusal for a provider ADE bundles
 * nothing for.
 *
 * ONE code for both. They are different facts about the host, but they are the
 * same fact about the plugin — it cannot have this, and no retry, no reinstall
 * and no user action changes that — and a plugin able to tell them apart could
 * enumerate which providers ADE has apps for by asking for each in turn.
 */
function notPermitted(pluginId: string, provider: string): PluginSdkError {
  return new PluginSdkError(
    "not_permitted",
    `"${pluginId}" cannot borrow ADE's OAuth client for "${provider}". Only the plugin that owns`
      + " the built-in surface ADE bundles that client for may, and community plugins register"
      + " their own app and declare its client id in authSessions[].clientId.",
  );
}

/**
 * Answer `ade.auth.officialClient(provider)` for one plugin.
 *
 * Pure apart from the environment read: no I/O, no credential store, no user
 * prompt. There is nothing here to consent to — the value is already public —
 * so unlike the credential handoff this needs no card and asks nobody.
 */
export function officialOAuthClientForPlugin(args: {
  pluginId: string;
  provider: string;
}): PluginOfficialOAuthClient {
  const provider = args.provider.trim().toLowerCase();
  if (!provider) {
    throw new PluginSdkError("invalid_args", '"provider" must be a non-empty string.');
  }

  const entry = OFFICIAL_OAUTH_CLIENTS[provider];
  if (!entry) throw notPermitted(args.pluginId, provider);

  const owner = builtinSurfaceOwnerForPlugin(args.pluginId);
  if (!owner || owner.builtinId !== entry.builtin) {
    throw notPermitted(args.pluginId, provider);
  }

  const clientId = entry.resolveClientId()?.trim() ?? "";
  // A build with the constant stripped and no override set. Not `not_permitted`
  // — this plugin IS permitted and there is simply nothing to lend — so it gets
  // the code that says "ask again on a machine where this exists".
  if (!clientId) {
    throw new PluginSdkError(
      "auth_unavailable",
      `This build of ADE bundles no OAuth client for "${provider}".`,
    );
  }

  const answer: PluginOfficialOAuthClient = {
    provider,
    clientId,
    ...(entry.authorizeUrl ? { authorizeUrl: entry.authorizeUrl } : {}),
    ...(entry.scopes ? { scopes: [...entry.scopes] } : {}),
  };
  assertNoClientSecret(answer);
  return answer;
}
