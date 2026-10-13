import type { OpenProjectBinding } from "../../shared/types";
import { THIS_MACHINE_NAME } from "../../shared/machineIdentity";
import { parseLoopbackUrl } from "../../shared/remoteLoopbackUrl";
import type {
  BuiltInBrowserRemoteCall,
  BuiltInBrowserRemoteCallReply,
} from "../../shared/types/builtInBrowserRemote";
import { isAddressedToThisDesktop } from "./desktopClient";

/**
 * This desktop running the browser commands of chats that live on another
 * machine.
 *
 * A chat on a Windows PC, driven from this Mac: its agent's `ade browser`
 * commands are sent here (`built_in_browser_remote_call`), because this is the
 * browser its user can see. This module is what answers them. It runs each
 * command in this desktop's own browser, as that chat, in the project the
 * chat's window shows, and sends the result back to the machine that asked.
 *
 * Not a component, on purpose. The agent keeps working while the user reads
 * another chat or has Git in the tools pane, so the answer cannot depend on
 * what is mounted. A chat is registered when the Work page shows it and stays
 * registered after the user moves on; only the least recently shown machines
 * are dropped, so an agent that worked an hour ago does not keep a stream open.
 */

type RemoteBinding = Extract<OpenProjectBinding, { kind: "remote" }>;

type ServedChat = {
  chatSessionId: string;
  laneId: string | null;
  /** The project whose tab collection the chat's commands act on, as this window names it. */
  projectRoot: string | null;
};

type ServedMachine = {
  binding: RemoteBinding;
  chats: Map<string, ServedChat>;
  unsubscribe: () => void;
};

/** Machines whose chats are answered at once; each holds one event subscription. */
const MAX_SERVED_MACHINES = 4;
const MAX_CHATS_PER_MACHINE = 24;
const HANDLED_CAP = 64;

const machines = new Map<string, ServedMachine>();
const handledIds = new Set<string>();

function browserApi() {
  return typeof window === "undefined" ? null : window.ade?.builtInBrowser ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An open this desktop cannot do without its Browser pane: a loopback URL
 * reaches the other machine through a port forward, and the first use of a
 * port needs a person to allow it in the pane's approval bar. The daemon then
 * sends the open down the request path, which brings the pane up.
 */
export function remoteBrowserCallNeedsPane(call: Pick<BuiltInBrowserRemoteCall, "method" | "input">): boolean {
  if (call.method !== "navigate" && call.method !== "createTab") return false;
  const url = typeof call.input.url === "string" ? call.input.url : "";
  return Boolean(url && parseLoopbackUrl(url));
}

async function answer(binding: RemoteBinding, reply: BuiltInBrowserRemoteCallReply): Promise<void> {
  await browserApi()?.replyRemoteCall?.(reply, binding).catch(() => {});
}

async function handleCall(machine: ServedMachine, call: BuiltInBrowserRemoteCall): Promise<void> {
  // Meant for the desktop the user is talking from. Another desktop leaves it,
  // and so does this one for a chat it has never shown.
  if (!isAddressedToThisDesktop(call.targetClientId)) return;
  const chat = call.chatSessionId ? machine.chats.get(call.chatSessionId) ?? null : null;
  if (!chat) return;
  if (handledIds.has(call.requestId)) return;
  handledIds.add(call.requestId);
  while (handledIds.size > HANDLED_CAP) {
    const oldest = handledIds.values().next().value;
    if (oldest === undefined) break;
    handledIds.delete(oldest);
  }
  const api = browserApi();
  if (!api?.runRemoteAgentCall || !api.replyRemoteCall) return;
  // Two windows of this desktop can both show the chat; the main process they
  // share picks one, as it does for a forwarded open.
  const claimed = await api.claimRemoteRequest?.({ requestId: call.requestId })
    .then((result) => result?.claimed !== false)
    .catch(() => true);
  if (claimed === false) return;

  await answer(machine.binding, { requestId: call.requestId, phase: "taken", desktopLabel: THIS_MACHINE_NAME });
  if (remoteBrowserCallNeedsPane(call)) {
    await answer(machine.binding, {
      requestId: call.requestId,
      phase: "done",
      desktopLabel: THIS_MACHINE_NAME,
      ok: false,
      code: "needs_pane",
      error: "This page is on the agent's machine and opens through the Browser pane.",
    });
    return;
  }
  try {
    const outcome = await api.runRemoteAgentCall({
      method: call.method,
      input: {
        ...call.input,
        // Who is calling is the daemon's answer; which tabs is this window's.
        chatSessionId: chat.chatSessionId,
        laneId: call.laneId ?? chat.laneId ?? undefined,
        ...(chat.projectRoot ? { projectRoot: chat.projectRoot } : { tabCollection: "personal" }),
      },
    });
    await answer(machine.binding, {
      requestId: call.requestId,
      phase: "done",
      desktopLabel: outcome.machineName || THIS_MACHINE_NAME,
      ok: true,
      result: outcome.result,
      ...(outcome.files.length > 0 ? { files: outcome.files } : {}),
    });
  } catch (error) {
    await answer(machine.binding, {
      requestId: call.requestId,
      phase: "done",
      desktopLabel: THIS_MACHINE_NAME,
      ok: false,
      error: errorText(error),
    });
  }
}

/**
 * Answer the browser commands of one chat that runs on `binding`'s machine.
 *
 * Safe to call on every render of the chat: it only records the chat and, the
 * first time a machine is seen, opens that machine's one subscription. Keyed
 * on `binding.key`, never on the object, which can be rebuilt with the same key.
 */
export function serveRemoteBrowserCalls(
  binding: OpenProjectBinding | null | undefined,
  chat: ServedChat,
): void {
  if (binding?.kind !== "remote" || !chat.chatSessionId) return;
  const api = browserApi();
  if (!api?.onRemoteCall) return;
  let machine = machines.get(binding.key) ?? null;
  if (machine) {
    // Most recently shown last, so the oldest machine is the one dropped.
    machines.delete(binding.key);
    machine.binding = binding;
  } else {
    const created: ServedMachine = { binding, chats: new Map(), unsubscribe: () => {} };
    created.unsubscribe = api.onRemoteCall((call) => {
      void handleCall(created, call);
    }, binding);
    machine = created;
  }
  machines.set(binding.key, machine);
  machine.chats.delete(chat.chatSessionId);
  machine.chats.set(chat.chatSessionId, chat);
  while (machine.chats.size > MAX_CHATS_PER_MACHINE) {
    const oldest = machine.chats.keys().next().value;
    if (oldest === undefined) break;
    machine.chats.delete(oldest);
  }
  while (machines.size > MAX_SERVED_MACHINES) {
    const oldestKey = machines.keys().next().value;
    if (oldestKey === undefined) break;
    machines.get(oldestKey)?.unsubscribe();
    machines.delete(oldestKey);
  }
}
