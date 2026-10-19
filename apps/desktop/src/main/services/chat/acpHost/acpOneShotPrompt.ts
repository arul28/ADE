/**
 * One prompt through a short-lived ACP agent, for an ADE background job (a
 * chat title, a summary) on a provider with no print mode (Antigravity).
 *
 * The agent starts for the call and is gone when it returns: `initialize`,
 * `session/new`, the chat's model, one `session/prompt`, then the process
 * tree is killed (the dialect's spawn plan and `createAcpConnection` give it
 * the same environment and per-launch scratch directory a chat gets, and the
 * scratch directory goes when the process exits). A permission request is
 * always refused: nobody watches a background job, and everything it needs is
 * in the prompt.
 */

import { isAcpAuthError, acpProbeConfigHome } from "../../ai/acpAuthProbe";
import type { AcpExecutableResolution } from "../../ai/acpExecutables";
import type { AcpChatProvider } from "../../../../shared/types/chat";
import { ACP_TERMINATE_GRACE_MS, createAcpConnection, initializeAcpConnection } from "./acpConnection";
import { acpDialectFor } from "./acpDialects";
import { behaviorOf } from "./acpHostTypes";
import { ACP_METHOD, normalizeAcpConfigOptions } from "./acpProtocolTypes";
import { resolveAcpConfigValue } from "./acpRuntimeCoordinator";

export type AcpOneShotPromptResult = { text: string; sessionId: string | null };

export async function runAcpOneShotPrompt(args: {
  provider: AcpChatProvider;
  executable: AcpExecutableResolution;
  /** Process and session cwd. A throwaway directory keeps the session out of the project's history. */
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  /** The provider's own model token; null keeps the agent's default. */
  modelToken: string | null;
  prompt: string;
  timeoutMs: number;
}): Promise<AcpOneShotPromptResult> {
  const dialect = acpDialectFor(args.provider);
  const spawnPlan = dialect.buildSpawnPlan({
    binaryPath: args.executable.path,
    ...(args.executable.args?.length ? { binaryArgs: args.executable.args } : {}),
    ...(args.executable.files ? { binaryFiles: args.executable.files } : {}),
    cwd: args.cwd,
    baseEnv: args.baseEnv,
    modelId: args.modelToken,
    configHome: acpProbeConfigHome(args.provider, args.baseEnv),
  });
  const connection = createAcpConnection({ dialect, spawnPlan });
  let timer: NodeJS.Timeout | null = null;
  try {
    connection.onRequest(ACP_METHOD.sessionRequestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
    const run = async (): Promise<AcpOneShotPromptResult> => {
      await initializeAcpConnection({ connection, dialect });
      let created: Record<string, unknown> | null;
      try {
        created = await connection.request<Record<string, unknown>>(ACP_METHOD.sessionNew, { cwd: args.cwd, mcpServers: [] });
      } catch (error) {
        if (!isAcpAuthError(error)) throw error;
        throw new Error([`${dialect.displayName} is not signed in on this machine.`, dialect.authProbe.signInHint].filter(Boolean).join(" "));
      }
      const sessionId = typeof created?.sessionId === "string" ? created.sessionId : null;
      if (!sessionId) throw new Error(`${dialect.displayName} opened no session.`);

      if (args.modelToken) {
        const optionId = dialect.modelConfigOptionId ?? "model";
        const options = normalizeAcpConfigOptions(created?.configOptions);
        const resolution = resolveAcpConfigValue(options, optionId, args.modelToken, dialect.modelIdFromAgent);
        // Never answer on a model the chat did not pick.
        if (resolution.kind === "not_offered") {
          throw new Error(`${dialect.displayName} does not offer model '${args.modelToken}' to this account.`);
        }
        if (resolution.kind === "unadvertised" || !resolution.current) {
          const setModel = behaviorOf(dialect.modelSelection);
          const setConfig = behaviorOf(dialect.sessionConfig);
          const call = setModel
            ? setModel({ sessionId, modelId: resolution.value })
            : setConfig?.({ sessionId, configId: optionId, value: resolution.value });
          if (!call) throw new Error(`${dialect.displayName} cannot switch its model over ACP.`);
          await connection.request(call.method, call.params);
        }
      }

      let text = "";
      connection.onSessionUpdate((notification) => {
        if (notification.sessionId !== sessionId) return;
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
        }
      });
      await connection.request(
        ACP_METHOD.sessionPrompt,
        { sessionId, prompt: [{ type: "text", text: args.prompt }] },
        { timeoutMs: args.timeoutMs },
      );
      return { text: text.trim(), sessionId };
    };
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${dialect.displayName} task timed out after ${args.timeoutMs}ms.`)),
          args.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    connection.dispose("one-shot task finished");
    // Return only once the agent is gone (dispose escalates to SIGKILL after
    // the grace period), so a caller never leaves a process behind.
    await Promise.race([
      connection.waitForExit(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, ACP_TERMINATE_GRACE_MS + 1_000).unref?.();
      }),
    ]);
  }
}
