import { useEffect, useRef } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { parseLoopbackUrl } from "../../shared/remoteLoopbackUrl";
import {
  isBuiltInBrowserRemoteBroadcastMethod,
  type BuiltInBrowserRemoteCall,
  type BuiltInBrowserRemoteCallReplyBody,
} from "../../shared/types/builtInBrowserRemote";
import { logRendererDebugEvent } from "./debugLog";
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
 * what is mounted. A machine is served once a chat on it is shown (the Work
 * page, a chat pane anywhere) and stays served after the user moves on; only
 * the least recently shown machines are dropped, so an agent that worked an
 * hour ago does not keep a stream open.
 *
 * A command addressed to this desktop by name is run even for a chat this
 * window has not shown since it started: the daemon names this desktop only
 * because the chat's last message came from here, or because the tab is here.
 * Answering only for chats shown since the last reload made the route depend
 * on what the user happened to look at (ledger R3).
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
  /** When a chat on this machine was last shown here (saved, for resuming after a reload). */
  shownAt: number;
  /** The `shownAt` last written to storage. */
  savedShownAt: number;
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

/**
 * Which of this desktop's collections a command means, as this window names
 * it: the chat's registered project, else what the daemon said (its project,
 * or the personal collection). Null when there is no way to tell, which is an
 * older daemon asking about a chat this window has not shown: left alone.
 */
function servedChatFor(machine: ServedMachine, call: BuiltInBrowserRemoteCall): ServedChat | null {
  // A lane's release is about every collection, and no chat asks for it.
  if (call.broadcast && call.method === "releaseLaneTabs") {
    const laneId = call.laneId ?? (typeof call.input.laneId === "string" ? call.input.laneId : null);
    return laneId ? { chatSessionId: "", laneId, projectRoot: null } : null;
  }
  // A chat's lifecycle is about its tabs in every collection, like a lane's release.
  if (call.broadcast && call.method === "chatBrowserLifecycle") {
    const chatSessionId = call.chatSessionId ?? (typeof call.input.chatSessionId === "string" ? call.input.chatSessionId : null);
    return chatSessionId ? { chatSessionId, laneId: call.laneId ?? null, projectRoot: null } : null;
  }
  const registered = call.chatSessionId ? machine.chats.get(call.chatSessionId) ?? null : null;
  if (registered) return registered;
  const myId = getDesktopClientId();
  const addressedHere = Boolean(myId && call.targetClientId === myId);
  if (!call.broadcast && !addressedHere) return null;
  if (call.collection !== "project" && call.collection !== "personal") return null;
  // A broadcast lists a project's tabs only. The personal collection is the
  // user's own browsing (the Browser top tab): a chat they never drove from
  // here does not get to read it.
  if (call.broadcast && call.collection === "personal") return null;
  return {
    chatSessionId: call.chatSessionId ?? "",
    laneId: call.laneId,
    // A remote binding names the project by the other machine's path, and the
    // pane keys that project's tabs by the same path.
    projectRoot: call.collection === "personal" ? null : machine.binding.rootPath,
  };
}

async function handleCall(machine: ServedMachine, call: BuiltInBrowserRemoteCall): Promise<void> {
  // Meant for the desktop the user is talking from, or the one holding the
  // tab. Another desktop leaves it. A broadcast is for every desktop.
  if (!isAddressedToThisDesktop(call.targetClientId)) return;
  if (Boolean(call.broadcast) !== isBuiltInBrowserRemoteBroadcastMethod(call.method)) return;
  const myId = getDesktopClientId();
  if (call.broadcast && myId && call.excludeClientIds?.includes(myId)) return;
  const chat = servedChatFor(machine, call);
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
      // The pane's request path opens it in the sign-in the agent asked for.
      requestCarriesSignIn: true,
    });
    return;
  }
  const outcome = await api.runRemoteAgentCall({
    method: call.method,
    input: {
      ...call.input,
      // Who is calling is the daemon's answer; which tabs is this window's.
      chatSessionId: chat.chatSessionId || undefined,
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

/** The machines served, kept so a reload or an update serves them again (ledger R3). */
const SERVED_MACHINES_STORAGE_KEY = "ade.remoteBrowserCallHost.machines.v1";
/** A machine not shown for this long is not served again after a reload: it may be gone. */
const SERVED_MACHINE_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function saveServedMachines(): void {
  try {
    for (const machine of machines.values()) machine.savedShownAt = machine.shownAt;
    const bindings = [...machines.values()].map((machine) => {
      const { binding } = machine;
      // The icon is a data URL; the rest is a few names and ids.
      const { iconDataUrl: _icon, ...rest } = binding;
      return { ...rest, servedAt: machine.shownAt };
    });
    window.localStorage.setItem(SERVED_MACHINES_STORAGE_KEY, JSON.stringify(bindings));
  } catch (error) {
    // No storage (the web client, a full disk): served until the next reload.
    logRendererDebugEvent("renderer.remote_browser_calls.save_failed", { error: errorText(error) });
  }
}

/** A saved time older than this is rewritten, so a machine in steady use does not expire. */
const SHOWN_AT_RESAVE_MS = 24 * 60 * 60_000;

/**
 * Open the machine's one subscription if it has none, and mark it the most
 * recently shown. `shownAt` is now for a chat shown here, or the saved time
 * for a machine served again after a reload.
 */
function serveMachine(binding: RemoteBinding, shownAt = Date.now()): ServedMachine | null {
  const api = browserApi();
  if (!api?.onRemoteCall) return null;
  let machine = machines.get(binding.key) ?? null;
  if (machine) {
    machine.binding = binding;
    machine.shownAt = Math.max(machine.shownAt, shownAt);
  } else {
    const created: ServedMachine = {
      binding,
      chats: new Map(),
      handledIds: new Set(),
      unsubscribe: () => {},
      shownAt,
      savedShownAt: 0,
    };
    created.unsubscribe = api.onRemoteCall((call) => {
      void handleCall(created, call);
    }, binding);
    machine = created;
  }
  // Most recently shown last, so the oldest machine is the one dropped.
  const isNewest = [...machines.keys()].at(-1) === binding.key;
  machines.delete(binding.key);
  machines.set(binding.key, machine);
  while (machines.size > MAX_SERVED_MACHINES) {
    const oldestKey = machines.keys().next().value;
    if (oldestKey === undefined) break;
    machines.get(oldestKey)?.unsubscribe();
    machines.delete(oldestKey);
  }
  if (!isNewest || machine.shownAt - machine.savedShownAt > SHOWN_AT_RESAVE_MS) saveServedMachines();
  return machine;
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
  const machine = serveMachine(binding);
  if (!machine) return;
  machine.chats.delete(chat.chatSessionId);
  machine.chats.set(chat.chatSessionId, chat);
  while (machine.chats.size > MAX_CHATS_PER_MACHINE) {
    const oldest = machine.chats.keys().next().value;
    if (oldest === undefined) break;
    machine.chats.delete(oldest);
  }
}

/**
 * Serve again the machines this desktop served before it reloaded or updated.
 * Without it, an agent's commands went to its own machine until the user
 * happened to open one of its chats here, while the user watched this screen.
 */
export function resumeServedRemoteBrowserCalls(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(window.localStorage.getItem(SERVED_MACHINES_STORAGE_KEY) ?? "[]");
  } catch (error) {
    // Nothing saved that can be read: machines are served again as their chats are shown.
    logRendererDebugEvent("renderer.remote_browser_calls.resume_failed", { error: errorText(error) });
    return;
  }
  if (!Array.isArray(saved)) return;
  for (const entry of saved.slice(-MAX_SERVED_MACHINES)) {
    const servedAt = entry && typeof entry === "object" ? (entry as { servedAt?: unknown }).servedAt : null;
    if (typeof servedAt !== "number" || Date.now() - servedAt > SERVED_MACHINE_RESUME_MAX_AGE_MS) continue;
    if (
      entry && typeof entry === "object"
      && (entry as { kind?: unknown }).kind === "remote"
      && typeof (entry as { key?: unknown }).key === "string"
      && typeof (entry as { targetId?: unknown }).targetId === "string"
      && typeof (entry as { rootPath?: unknown }).rootPath === "string"
    ) {
      const { servedAt: _servedAt, ...binding } = entry as RemoteBinding & { servedAt?: number };
      serveMachine(binding as RemoteBinding, servedAt);
    }
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
    if (!active || !machineKey) return;
    const current = bindingRef.current;
    if (current?.kind !== "remote") return;
    // No chat yet (a draft, a launch in the background): serve the machine
    // anyway, so the chat's first browser command finds this desktop.
    if (!chatSessionId) {
      serveMachine(current);
      return;
    }
    serveRemoteBrowserCalls(current, { chatSessionId, laneId, projectRoot });
  }, [active, chatSessionId, laneId, machineKey, projectRoot]);
}
