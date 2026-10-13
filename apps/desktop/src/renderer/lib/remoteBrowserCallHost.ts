import { useEffect, useRef } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { parseLoopbackUrl } from "../../shared/remoteLoopbackUrl";
import type {
  BuiltInBrowserRemoteCall,
  BuiltInBrowserRemoteCallReplyBody,
} from "../../shared/types/builtInBrowserRemote";
import { getDesktopClientId, isAddressedToThisDesktop } from "./desktopClient";

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
  /** Commands already answered, so a replayed event is not run twice. */
  handledIds: Set<string>;
  unsubscribe: () => void;
};

/** Machines whose chats are answered at once; each holds one event subscription. */
const MAX_SERVED_MACHINES = 4;
const MAX_CHATS_PER_MACHINE = 24;
const HANDLED_CAP = 64;

const machines = new Map<string, ServedMachine>();

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

/** Keep `id` as the newest entry of `ids`, and drop the oldest past `cap`. */
function rememberNewest(ids: Set<string>, id: string, cap: number): void {
  ids.delete(id);
  ids.add(id);
  while (ids.size > cap) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

async function handleCall(machine: ServedMachine, call: BuiltInBrowserRemoteCall): Promise<void> {
  // Meant for the desktop the user is talking from. Another desktop leaves it,
  // and so does this one for a chat it has never shown.
  if (!isAddressedToThisDesktop(call.targetClientId)) return;
  const chat = call.chatSessionId ? machine.chats.get(call.chatSessionId) ?? null : null;
  if (!chat || !call.requestId || machine.handledIds.has(call.requestId)) return;
  const api = browserApi();
  // A surface with only part of the browser API (the web client) runs nothing.
  if (!api?.runRemoteAgentCall || !api.replyRemoteCall || !api.claimRemoteRequest) return;
  rememberNewest(machine.handledIds, call.requestId, HANDLED_CAP);
  // Two windows of this desktop can both show the chat; the main process they
  // share picks one. When the pick itself fails, this window does not run the
  // command: a click run twice is worse than one the daemon runs elsewhere.
  const claimed = await api.claimRemoteRequest({ requestId: call.requestId })
    .then((result) => result.claimed !== false)
    .catch(() => false);
  if (!claimed) return;

  const reply = (body: BuiltInBrowserRemoteCallReplyBody) =>
    api.replyRemoteCall({ requestId: call.requestId, clientId: getDesktopClientId(), ...body }, machine.binding)
      .catch(() => ({ ok: false }));

  // The daemon runs the command on its own machine when "taken" comes too
  // late. A taken reply it refused means exactly that: run nothing here, or
  // a click would happen in two browsers.
  const taken = await reply({ phase: "taken" });
  if (taken.ok !== true) return;
  if (remoteBrowserCallNeedsPane(call)) {
    await reply({
      phase: "done",
      ok: false,
      code: "needs_pane",
      error: "This page is on the agent's machine and opens through the Browser pane.",
    });
    return;
  }
  const outcome = await api.runRemoteAgentCall({
    method: call.method,
    input: {
      ...call.input,
      // Who is calling is the daemon's answer; which tabs is this window's.
      chatSessionId: chat.chatSessionId,
      laneId: call.laneId ?? chat.laneId ?? undefined,
      ...(chat.projectRoot
        ? { projectRoot: chat.projectRoot, tabCollection: undefined }
        : { projectRoot: undefined, tabCollection: "personal" }),
    },
  }).catch((error: unknown) => ({ ok: false as const, error: errorText(error), machineName: "" }));
  const desktopLabel = outcome.machineName || undefined;
  await reply(outcome.ok
    ? {
      phase: "done",
      desktopLabel,
      ok: true,
      result: outcome.result,
      ...(outcome.files.length > 0 ? { files: outcome.files } : {}),
    }
    : { phase: "done", desktopLabel, ok: false, error: outcome.error });
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
    machine.binding = binding;
  } else {
    const created: ServedMachine = { binding, chats: new Map(), handledIds: new Set(), unsubscribe: () => {} };
    created.unsubscribe = api.onRemoteCall((call) => {
      void handleCall(created, call);
    }, binding);
    machine = created;
  }
  // Most recently shown last, so the oldest machine is the one dropped.
  machines.delete(binding.key);
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

/**
 * Serve the agent of the chat in front, when that chat runs on another
 * machine. Keyed on the machine's key, not the binding object (it can be
 * rebuilt with the same key); the latest object is read when the effect runs.
 */
export function useServeRemoteBrowserCalls(args: {
  active: boolean;
  binding: OpenProjectBinding | null | undefined;
  chatSessionId: string | null;
  laneId: string | null;
  projectRoot: string | null;
}): void {
  const { active, binding, chatSessionId, laneId, projectRoot } = args;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const machineKey = binding?.kind === "remote" ? binding.key : null;
  useEffect(() => {
    if (!active || !chatSessionId || !machineKey) return;
    serveRemoteBrowserCalls(bindingRef.current, { chatSessionId, laneId, projectRoot });
  }, [active, chatSessionId, laneId, machineKey, projectRoot]);
}
