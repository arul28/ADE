import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { AdeExpectedError } from "../../../shared/expectedError";
import { capturePasswordsAnalytics } from "../analytics/featureProductAnalytics";
import { createDomainArgReaders } from "../adeActions/domainArgs";
import { requestPasswordLoginFromUser } from "./passwordLoginRequest";
import { signInWithPasswords, signUpWithPasswords, type PasswordAgentUse } from "./passwordSignin";

type OpaqueService = Record<string, unknown>;

/**
 * The `passwords` action domain over the brain's Passwords service. Each
 * method takes one plain object. `resolveForFill`, `revealValue` and
 * `passkeysForRp` are the only ones that return a value, and the policy
 * tables keep them for this computer's own desktop app (user-only,
 * this-desktop-only, secret-bearing).
 */
export function buildPasswordsDomainService(runtime: Partial<Pick<AdeRuntime, "passwordService" | "agentChatService" | "builtInBrowserService" | "productAnalyticsService">>): OpaqueService | null {
  const passwords = runtime.passwordService;
  if (!passwords) return null;
  const objectArg = createDomainArgReaders("passwords").objectArgs;
  // Values are read as given, never trimmed: a password's spaces are part of it.
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  // The secure sign-in card in the agent's own chat; null on a runtime without chats.
  const chats = runtime.agentChatService;
  const browser = runtime.builtInBrowserService;
  const askForLogin = chats
    ? (input: unknown) => requestPasswordLoginFromUser({ requestChatInput: (request) => chats.requestChatInput(request), passwords }, input)
    : null;
  // One coarse product fact per decision or agent use (never the site,
  // account, item or error), after the call settles.
  const counted = async <T>(
    action: "passwords_switched" | "logins_imported" | "agent_signed_in" | "agent_signed_up",
    run: () => Promise<T>,
    outcomeOf: (result: T) => "enabled" | "disabled" | "completed" | null = () => "completed",
  ): Promise<T> => {
    try {
      const result = await run();
      const outcome = outcomeOf(result);
      if (outcome) capturePasswordsAnalytics({ analytics: runtime.productAnalyticsService, surface: "api", action, outcome });
      return result;
    } catch (error) {
      // A person's no (a declined card, a page the agent should not fill) is
      // not a failure of Passwords.
      const outcome = error instanceof AdeExpectedError && error.adeExpected === "user" ? "cancelled" : "failed";
      capturePasswordsAnalytics({ analytics: runtime.productAnalyticsService, surface: "api", action, outcome });
      throw error;
    }
  };
  const noteAgentUse = async (use: PasswordAgentUse, line: string): Promise<void> => {
    await passwords.recordUse({ itemId: use.itemId, kind: "login", target: use.site, by: use.by, chatSessionId: use.chatSessionId });
    if (use.chatSessionId) chats?.postQuietNotice(use.chatSessionId, line);
  };
  return {
    status: () => passwords.status(),
    activity: () => passwords.activity(),
    passkeysForRp: (args?: unknown) => passwords.passkeysForRp(text(objectArg(args).rpId)),
    savePasskey: (args?: unknown) => {
      const input = objectArg(args);
      return passwords.savePasskey({
        rpId: text(input.rpId),
        credentialId: text(input.credentialId),
        userHandle: text(input.userHandle),
        userName: text(input.userName),
        userDisplayName: text(input.userDisplayName),
        privateKeyPkcs8: text(input.privateKeyPkcs8),
        signCount: typeof input.signCount === "number" ? input.signCount : 0,
      });
    },
    revealValue: (args?: unknown) => {
      const input = objectArg(args);
      const field = input.field === "username" || input.field === "value" || input.field === "notes" ? input.field : "password";
      return passwords.revealValue({ itemId: text(input.itemId), field });
    },
    // An authenticator code (never the key): agents may read it, it lasts seconds.
    code: (args?: unknown) => {
      const input = objectArg(args);
      return passwords.currentCode({
        itemId: typeof input.itemId === "string" ? input.itemId : null,
        site: typeof input.site === "string" ? input.site : null,
        username: typeof input.username === "string" ? input.username : null,
      });
    },
    // The person's own fills (the key button). Agent uses are recorded by `signin` itself.
    recordUse: (args?: unknown) => {
      const input = objectArg(args);
      const kind = input.kind === "secret" ? "secret" : "login";
      return passwords.recordUse({ itemId: text(input.itemId), kind, target: text(input.target), by: "person", chatSessionId: null });
    },
    setEnabled: (args?: unknown) => {
      const enabled = objectArg(args).enabled === true;
      return counted("passwords_switched", () => passwords.setEnabled(enabled), () => (enabled ? "enabled" : "disabled"));
    },
    setCloudEnabled: (args?: unknown) => passwords.setCloudEnabled(objectArg(args).enabled === true),
    reset: (args?: unknown) => {
      // The person typed it: a stray call can't wipe the account's vault.
      if (objectArg(args).confirm !== "reset") throw new Error("Reset Passwords needs confirm: \"reset\".");
      return passwords.reset();
    },
    list: () => passwords.listSummaries(),
    loginsForPage: (args?: unknown) => passwords.loginsForPage(text(objectArg(args).pageUrl), { exactOrigin: objectArg(args).exactOrigin === true }),
    saveLogin: (args?: unknown) => {
      const input = objectArg(args);
      // Only what the caller names: a change by id keeps the rest.
      return passwords.saveLogin({
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(Array.isArray(input.origins) ? { origins: input.origins.filter((origin): origin is string => typeof origin === "string") } : {}),
        ...(typeof input.username === "string" ? { username: input.username } : {}),
        password: text(input.password),
        ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
        ...(typeof input.totpUri === "string" || input.totpUri === null ? { totpUri: input.totpUri as string | null } : {}),
      });
    },
    saveSecret: (args?: unknown) => {
      const input = objectArg(args);
      return passwords.saveSecret({
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        name: text(input.name),
        value: text(input.value),
        projectScope: typeof input.projectScope === "string" ? input.projectScope : null,
        ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
      });
    },
    remove: (args?: unknown) => passwords.remove(text(objectArg(args).id)),
    importCsv: (args?: unknown) => counted("logins_imported", () => passwords.importCsv(text(objectArg(args).text))),
    sync: () => passwords.sync(),
    resolveForFill: (args?: unknown) => {
      const input = objectArg(args);
      return passwords.resolveForFill({ itemId: text(input.itemId), pageUrl: text(input.pageUrl), exactOrigin: input.exactOrigin === true });
    },
    ...(askForLogin ? { requestLogin: (args?: unknown) => askForLogin(args) } : {}),
    // `ade browser signin`: fill a saved login; with none, ask the person in
    // the agent's own chat (the RPC server stamps it), save, and fill.
    // `ade browser signup`: a new password, saved, then typed into the form.
    // Each writes an Activity row and a quiet line in the agent's chat.
    ...(browser
      ? {
          // Counted only when something was filled (not "sign in yourself").
          signin: (args?: unknown) => counted("agent_signed_in", () => signInWithPasswords({
            browser,
            passwords,
            noteUse: (use) => noteAgentUse(use, `Signed in to ${use.site}${use.username ? ` as ${use.username}` : ""} with a saved login.`),
            requestLogin: askForLogin,
          }, objectArg(args)), (result) => (result.signin?.filled.length ? "completed" : null)),
          signup: (args?: unknown) => counted("agent_signed_up", () => signUpWithPasswords({
            browser,
            noteUse: (use) => noteAgentUse(use, `Made a new password for ${use.site}${use.username ? ` (${use.username})` : ""} and saved it to Passwords.`),
          }, objectArg(args))),
        }
      : {}),
  } as unknown as OpaqueService;
}
