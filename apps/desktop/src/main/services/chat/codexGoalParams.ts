/**
 * Who mutated a Codex goal, and the params that carry it.
 *
 * Codex 0.162 added `origin` to `thread/goal/set` and `thread/goal/clear`, and
 * reads a missing provenance as "supplies no user authorization". A concept is
 * whole here — the enum, the version gate it depends on, the param shapes, and
 * the one place that turns a runtime actor into an origin — instead of being
 * split between the app-server feature gates and a 67k-line service.
 *
 * Pure and service-free on purpose: every function below is a function of its
 * arguments, so the goal RPC payloads can be read and tested without a chat.
 */
import { codexServerSupportsGoalMutationOrigin, type CodexAppServerVersion } from "./codexAppServerFeatures";
import type { AgentChatEventMetadata, AgentChatRuntimeActor } from "../../../shared/types/chat";

/**
 * `"user"` means a person acted: the composer's `/goal` command, the goal
 * controls in the chat, and the goal RPCs when the runtime stamped no actor.
 * Everything ADE does on its own — seeding a goal into a fresh thread, clearing
 * a token budget the user never set, tidying up around a fork or handoff — is
 * `"automatic"`, which is also what an unclassified path falls back to:
 * claiming the user authorized something they did not is worse than claiming
 * nothing.
 */
export type CodexGoalMutationOrigin = "user" | "automatic";

/**
 * The origin for a goal call, from who made it.
 *
 * The runtime stamps `runtimeActor` on an agent's or the CTO's call and never
 * lets a renderer send one, so an absent actor is the only trustworthy signal
 * that a person acted — which matters because `ade chat goal` is an agent
 * command that reaches the same method as the chat's own goal controls.
 */
export function codexGoalOrigin(args: { runtimeActor?: AgentChatRuntimeActor }): CodexGoalMutationOrigin {
  return args.runtimeActor ? "automatic" : "user";
}

/**
 * The origin for a goal mutation that arrived as *message text* — the
 * composer's `/goal` commands, and the card that confirms replacing a goal.
 *
 * The same method serves a person typing and an agent sending into its own
 * chat (`ade chat send <chat> "/goal set …"`), so this cannot be a literal.
 * `agentRelay` marks a message another bound agent sent, and `spawnDispatch`
 * marks a parent-dispatched child turn; both are stamped by the runtime and
 * never by a caller, the same trust boundary `runtimeActor` uses on the goal
 * RPCs. Everything else is a person — including `voiceInput`, which is the
 * user speaking. Anything unrecognised stays `"user"` here because the only
 * thing that reaches this function is a message the user or their agent typed
 * into a chat, and the two are told apart by the stamps above.
 */
export function codexGoalOriginFromMessage(
  metadata: AgentChatEventMetadata | null | undefined,
): CodexGoalMutationOrigin {
  const dispatched = Boolean(metadata?.spawnDispatch?.parentSessionId?.trim());
  return metadata?.agentRelay || dispatched ? "automatic" : "user";
}

/** `origin` on the goal RPCs. Omitted entirely on servers that predate it. */
function codexGoalOriginParams(
  origin: CodexGoalMutationOrigin,
  serverVersion: CodexAppServerVersion | null,
): { origin?: CodexGoalMutationOrigin } {
  return codexServerSupportsGoalMutationOrigin(serverVersion) ? { origin } : {};
}

/** `thread/goal/set`, under ADE's unlimited-budget policy. */
export function codexGoalSetParams(
  params: Record<string, unknown>,
  origin: CodexGoalMutationOrigin,
  serverVersion: CodexAppServerVersion | null,
): Record<string, unknown> {
  return {
    ...params,
    tokenBudget: null,
    ...codexGoalOriginParams(origin, serverVersion),
  };
}

/**
 * `thread/goal/clear`, which takes the same provenance as `set`.
 *
 * The id is typed loosely on purpose: the composer's `/goal clear` sends the
 * session's current thread id, which callers have always passed through as-is
 * rather than inventing an empty string, and a missing one is the server's to
 * reject.
 */
export function codexGoalClearParams(
  threadId: string | undefined,
  origin: CodexGoalMutationOrigin,
  serverVersion: CodexAppServerVersion | null,
): Record<string, unknown> {
  return {
    threadId,
    ...codexGoalOriginParams(origin, serverVersion),
  };
}
