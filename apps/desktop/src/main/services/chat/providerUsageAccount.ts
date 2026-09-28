import type {
  AgentChatUsageAccount,
  AgentChatUsageAccountKind,
} from "../../../shared/types/chat";
import type { ProviderInstance, ProviderInstanceProvider } from "../../../shared/types/providerInstances";
import { createOpenCodeUsageAccountResolver } from "./openCodeTurnUsage";

/**
 * Who paid for a Claude or Codex turn.
 *
 * Both harnesses run either on a plan login (claude.ai / ChatGPT) or on an API
 * key. The runtime reports which when it can — Claude's `system/init` names
 * the `apiKeySource`, Codex's `account/updated` names the `authMode` — and the
 * provider-instance record ADE keeps supplies the login's email and plan. When
 * neither says, the kind is `unknown` rather than a guess.
 */

/** `apiKeySource` values that mean Claude billed an API key, not a plan. */
const CLAUDE_API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

type UsageRoute = NonNullable<AgentChatUsageAccount["routedAway"]>;

/**
 * Who paid for a turn, and why the harness's plan did not when it did not.
 *
 * `routedAway` names the route that took the turn off the plan: a
 * non-first-party model route (`cloud`: Bedrock, Vertex, a gateway), a keyed
 * preset (`preset`), or a redirected base URL / auth token (`endpoint`). A
 * subscription turn is never marked, since the plan did pay for it. The
 * subscription burn rate leaves a marked turn out; `upstream` stays the model
 * vendor's name only.
 */
export type UsageAccountKindResult = {
  kind: AgentChatUsageAccountKind;
  routedAway: UsageRoute | null;
};

/** The first route, in precedence order, that bills someone other than the plan. */
function usageRoute(args: {
  modelProvider?: string | null;
  keyedPreset: boolean;
  redirectedEndpoint?: boolean;
}): UsageRoute | null {
  const modelProvider = args.modelProvider?.trim();
  if (modelProvider && modelProvider !== "firstParty") return "cloud";
  if (args.keyedPreset) return "preset";
  if (args.redirectedEndpoint) return "endpoint";
  return null;
}

function usageAccountKindResult(kind: AgentChatUsageAccountKind, route: UsageRoute | null): UsageAccountKindResult {
  return { kind, routedAway: kind === "subscription" ? null : route };
}

export function claudeUsageAccountKind(args: {
  /** `system/init.apiKeySource`, when the turn's query reported one. */
  apiKeySource: string | null | undefined;
  /** `modelUsage[*].provider` (firstParty, bedrock, vertex, ...), when reported. */
  modelProvider: string | null | undefined;
  /** A preset that launches Claude on a key or an endpoint rather than an account. */
  keyedPreset: boolean;
  /** `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` point the CLI somewhere else. */
  redirectedEndpoint: boolean;
  instanceSignedIn: boolean;
}): UsageAccountKindResult {
  const route = usageRoute(args);
  const source = args.apiKeySource?.trim() ?? "";
  // Any route is billed by someone ADE cannot see, so the plan login did not pay.
  const kind: AgentChatUsageAccountKind = CLAUDE_API_KEY_SOURCES.has(source) ? "api_key"
    : route ? "unknown"
    : source === "none" || (!source && args.instanceSignedIn) ? "subscription"
    : "unknown";
  return usageAccountKindResult(kind, route);
}

/** Codex auth modes that bill an AWS account through Amazon Bedrock. */
function isCodexBedrockAuthMode(mode: string): boolean {
  return mode === "amazonbedrock" || mode.startsWith("bedrock");
}

export function codexUsageAccountKind(args: {
  /**
   * Codex `authMode` (`apikey`, `chatgpt`, `chatgptAuthTokens`,
   * `bedrockApiKey`, ...) from `account/updated`, or the one `account/read`
   * implies (see `codexAuthModeFromAccountRead`).
   */
  authMode: string | null | undefined;
  keyedPreset: boolean;
  instanceSignedIn: boolean;
}): UsageAccountKindResult {
  const mode = args.authMode?.trim().toLowerCase() ?? "";
  const route = usageRoute({ modelProvider: isCodexBedrockAuthMode(mode) ? "bedrock" : null, keyedPreset: args.keyedPreset });
  const kind: AgentChatUsageAccountKind = mode === "apikey" ? "api_key"
    : mode === "chatgpt" || mode === "chatgptauthtokens" ? "subscription"
    : mode || route ? "unknown"
    : args.instanceSignedIn ? "subscription"
    : "unknown";
  return usageAccountKindResult(kind, route);
}

/**
 * What Codex's `account/read` says about the login, in `account/updated`
 * terms. The app-server sends `account/updated` only when the login changes,
 * never at startup, so this read is the only report a normal session gets.
 * Null when the response names no account.
 */
export function codexAuthModeFromAccountRead(response: unknown): { authMode: string; planType: string | null } | null {
  const account = response && typeof response === "object"
    ? (response as { account?: unknown }).account
    : null;
  if (!account || typeof account !== "object") return null;
  const record = account as { type?: unknown; planType?: unknown };
  const planType = typeof record.planType === "string" && record.planType.trim() ? record.planType.trim() : null;
  switch (record.type) {
    case "apiKey":
      return { authMode: "apikey", planType: null };
    case "chatgpt":
      return { authMode: "chatgpt", planType };
    case "amazonBedrock":
      return { authMode: "amazonBedrock", planType: null };
    default:
      return null;
  }
}

/**
 * The account block for a done event. The login's email and plan are only
 * attached to a subscription turn: on an API-key turn the login did not pay.
 * `plan` is the runtime's own report, used when the instance record has none.
 */
export function buildInstanceUsageAccount(args: {
  provider: ProviderInstanceProvider;
  kind: AgentChatUsageAccountKind;
  instance: Pick<ProviderInstance, "id" | "account"> | null;
  routedAway?: AgentChatUsageAccount["routedAway"];
  plan?: string | null;
}): AgentChatUsageAccount {
  const email = args.kind === "subscription" ? args.instance?.account?.email?.trim() : undefined;
  const plan = args.kind === "subscription"
    ? args.instance?.account?.plan?.trim() || args.plan?.trim() || undefined
    : undefined;
  return {
    provider: args.provider,
    kind: args.kind,
    ...(args.instance?.id ? { instanceId: args.instance.id } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(args.routedAway ? { routedAway: args.routedAway } : {}),
  };
}

const PROVIDER_INSTANCE_USAGE_TTL_MS = 60_000;

/**
 * Caches the provider-instance lookup behind a turn's account. The store reads
 * its registry file on every call; a done event must not.
 */
export function createProviderInstanceUsageLookup(
  resolve: (provider: ProviderInstanceProvider, instanceId: string | null) => ProviderInstance | null,
  now: () => number = Date.now,
): (provider: ProviderInstanceProvider, instanceId: string | null | undefined) => ProviderInstance | null {
  const cache = new Map<string, { at: number; instance: ProviderInstance | null }>();
  return (provider, instanceId) => {
    const requested = instanceId?.trim() || null;
    const key = `${provider}:${requested ?? ""}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < PROVIDER_INSTANCE_USAGE_TTL_MS) return cached.instance;
    let instance: ProviderInstance | null = null;
    try {
      instance = resolve(provider, requested);
    } catch {
      instance = null;
    }
    cache.set(key, { at: now(), instance });
    return instance;
  };
}

/**
 * Who paid for a turn (`done.account`), for every harness whose account ADE
 * derives itself. Read on every done event, so the instance registry,
 * OpenCode's auth store, and the local-endpoint config sit behind caches and a
 * turn never touches disk for this.
 */
export function createTurnUsageAccountResolvers<Session>(deps: {
  resolveInstance: (provider: ProviderInstanceProvider, instanceId: string | null) => ProviderInstance | null;
  /** The harness-preset launch plan the session runs on, when it has one. */
  launchPlan: (session: Session) => { instanceId?: string | null } | null;
  sessionInstanceId: (session: Session) => string | null | undefined;
  /** The endpoint ADE hands OpenCode for a local server, or null for any other provider. */
  openCodeLocalEndpoint: (providerID: string) => string | null;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
}) {
  const env = deps.env ?? (() => process.env);
  const lookupInstance = createProviderInstanceUsageLookup(deps.resolveInstance, deps.now);
  const resolveOpenCode = createOpenCodeUsageAccountResolver({
    localEndpoint: deps.openCodeLocalEndpoint,
    ...(deps.now ? { now: deps.now } : {}),
  });

  /** A preset that launches the harness on a key or endpoint instead of an account. */
  const runsKeyedPreset = (session: Session): boolean => {
    const plan = deps.launchPlan(session);
    return Boolean(plan && !plan.instanceId);
  };

  const sessionInstance = (session: Session, provider: ProviderInstanceProvider): ProviderInstance | null =>
    lookupInstance(provider, deps.launchPlan(session)?.instanceId ?? deps.sessionInstanceId(session));

  return {
    lookupInstance,

    claude(session: Session, args: {
      apiKeySource: string | null | undefined;
      modelProvider: string | null | undefined;
    }): AgentChatUsageAccount {
      const instance = sessionInstance(session, "claude");
      const current = env();
      const { kind, routedAway } = claudeUsageAccountKind({
        apiKeySource: args.apiKeySource,
        modelProvider: args.modelProvider,
        keyedPreset: runsKeyedPreset(session),
        redirectedEndpoint: Boolean(current.ANTHROPIC_BASE_URL?.trim() || current.ANTHROPIC_AUTH_TOKEN?.trim()),
        instanceSignedIn: instance?.signedIn === true,
      });
      return buildInstanceUsageAccount({ provider: "claude", kind, instance, routedAway });
    },

    codex(session: Session, authMode: string | null | undefined, planType?: string | null): AgentChatUsageAccount {
      const instance = sessionInstance(session, "codex");
      const { kind, routedAway } = codexUsageAccountKind({
        authMode,
        keyedPreset: runsKeyedPreset(session),
        instanceSignedIn: instance?.signedIn === true,
      });
      return buildInstanceUsageAccount({ provider: "codex", kind, instance, routedAway, plan: planType });
    },

    /**
     * OpenCode account for the upstream provider that served the turn. The
     * shared lookup order leads with ADE's owned store and keeps the user's
     * behind it for a legacy session re-opened on its original home, so one
     * reader covers both.
     */
    openCode(_session: Session, providerID: string): AgentChatUsageAccount {
      return resolveOpenCode({ providerID });
    },
  };
}
