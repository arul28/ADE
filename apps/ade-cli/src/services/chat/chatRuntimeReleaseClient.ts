import { JsonRpcClient } from "../../lib/jsonRpcClient";
import { SYSTEM_PROJECT_REGISTRATION } from "../projects/projectRegistry";
import { chatRuntimeReclaimInitializeParams } from "../../../../desktop/src/shared/runtimeClientNames";
import {
  isChatRuntimeReleaseResult,
  type ChatRuntimeReleaseResult,
} from "../../../../desktop/src/main/services/chat/chatRuntimeOwnership";

/**
 * How long the machine brain's send waits for a lane brain to hand a chat
 * back: the whole exchange (connect, handshake, project, release), not each
 * step. Past it the send is refused with the owner's socket, as before.
 */
export const CHAT_RUNTIME_RELEASE_TIMEOUT_MS = 10_000;

/**
 * Ask the brain on `socketPath` to release one of this project's chats
 * (`chat.releaseChatRuntime`). Throws when that brain does not answer in time,
 * refuses, or answers something that is not a release result.
 */
export async function requestChatRuntimeReleaseFromBrain(args: {
  socketPath: string;
  sessionId: string;
  projectRoot: string;
  version: string;
  timeoutMs?: number;
}): Promise<ChatRuntimeReleaseResult> {
  const timeoutMs = args.timeoutMs ?? CHAT_RUNTIME_RELEASE_TIMEOUT_MS;
  let client: JsonRpcClient | null = null;
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The other ADE did not hand the chat back within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  const exchange = (async (): Promise<ChatRuntimeReleaseResult> => {
    const connected = await JsonRpcClient.connect(args.socketPath);
    // A connect that finished after the deadline: the send was already
    // refused, so nothing may be released now.
    if (settled) {
      connected.close();
      throw new Error("The other ADE answered after the send gave up.");
    }
    client = connected;
    await client.request("ade/initialize", chatRuntimeReclaimInitializeParams(args.version));
    const registered = await client.request<{ projectId?: unknown } | null>("projects.add", {
      rootPath: args.projectRoot,
      ...SYSTEM_PROJECT_REGISTRATION,
      withoutIcon: true,
    });
    const projectId = typeof registered?.projectId === "string" ? registered.projectId : null;
    if (!projectId) throw new Error("The other ADE did not open this project.");
    const raw = await client.request("ade/actions/call", {
      name: "run_ade_action",
      arguments: { domain: "chat", action: "releaseChatRuntime", args: { sessionId: args.sessionId } },
      projectId,
    });
    return readChatRuntimeReleaseAnswer(raw);
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    // Also ends an exchange the deadline cut short in a request; one cut
    // short in its connect closes itself (above).
    try { (client as JsonRpcClient | null)?.close(); } catch { /* already closed */ }
    exchange.catch(() => { /* settled by the race above */ });
  }
}

/**
 * The answer of a local `ade/actions/call`: `{ domain, action, result }`, or
 * `{ ok: false, error }` for a refusal (an elevated-role check, for one).
 */
export function readChatRuntimeReleaseAnswer(raw: unknown): ChatRuntimeReleaseResult {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (record?.ok === false) {
    const error = record.error && typeof record.error === "object" ? record.error as { message?: unknown } : null;
    throw new Error(typeof error?.message === "string" ? error.message : "The other ADE refused to hand the chat back.");
  }
  const answer = record && "result" in record ? record.result : raw;
  if (!isChatRuntimeReleaseResult(answer)) throw new Error("The other ADE gave no release answer.");
  return answer;
}
