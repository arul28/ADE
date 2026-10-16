import type {
  ChatLaunchArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchQueueMessageArgs,
  ChatLaunchSnapshot,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/**
 * `window.ade.chatLaunch` for the hosted web client: brain-owned new-lane
 * launches over the sync command channel (`chat.startLaunch` …
 * `chat.completeLaunchClient`, the same names as the brain's `chat` action
 * domain), with live updates from the pushed `chat_launch_event` envelope.
 */
export function createChatLaunchNamespace(infra: AdapterInfra): AdeNamespace<"chatLaunch"> {
  const { client, commands, events } = infra;

  function guardPin(operation: string, pin: RuntimePinArg): void {
    assertWebRuntimePinRoutable(`chatLaunch.${operation}`, pin, infra);
  }

  function call<T>(action: string, args: unknown, idempotent: boolean): Promise<T> {
    return commands.call<T>(action, asRecord(args), {
      fallback: () => {
        throw new Error(`New-lane launch action '${action}' is unavailable on the connected ADE host.`);
      },
      idempotent,
    });
  }

  return {
    start: async (args: ChatLaunchArgs, pin?: RuntimePinArg) => {
      guardPin("start", pin);
      // A write: never served from the read cache, and an older host that
      // lacks the action rejects (the composer then falls back to its own
      // create-lane chain) instead of resolving a fallback.
      return await call<ChatLaunchSnapshot>("chat.startLaunch", args, false);
    },
    get: async (args: ChatLaunchIdArgs, pin?: RuntimePinArg) => {
      guardPin("get", pin);
      return await call<ChatLaunchSnapshot | null>("chat.getLaunch", args, true);
    },
    list: async (pin?: RuntimePinArg) => {
      guardPin("list", pin);
      return await commands.call<ChatLaunchSnapshot[]>("chat.listLaunches", {}, { fallback: [], idempotent: true });
    },
    cancel: async (args: ChatLaunchIdArgs, pin?: RuntimePinArg) => {
      guardPin("cancel", pin);
      return await call<ChatLaunchSnapshot | null>("chat.cancelLaunch", args, false);
    },
    retry: async (args: ChatLaunchIdArgs, pin?: RuntimePinArg) => {
      guardPin("retry", pin);
      return await call<ChatLaunchSnapshot | null>("chat.retryLaunch", args, false);
    },
    startNow: async (args: ChatLaunchIdArgs, pin?: RuntimePinArg) => {
      guardPin("startNow", pin);
      return await call<ChatLaunchSnapshot | null>("chat.startLaunchNow", args, false);
    },
    queueMessage: async (args: ChatLaunchQueueMessageArgs, pin?: RuntimePinArg) => {
      guardPin("queueMessage", pin);
      return await call<ChatLaunchSnapshot>("chat.queueLaunchMessage", args, false);
    },
    completeClient: async (args: ChatLaunchCompleteClientArgs, pin?: RuntimePinArg) => {
      guardPin("completeClient", pin);
      return await call<ChatLaunchSnapshot | null>("chat.completeLaunchClient", args, false);
    },
    onEvent: (listener: (event: ChatLaunchEvent) => void, pin?: RuntimePinArg, onResync?: () => void) => {
      guardPin("onEvent", pin);
      const removeEvents = events.on("chatLaunchEvent", listener);
      if (!onResync) return removeEvents;
      // Events pushed while the socket was down are gone; a reconnect is a resync.
      const isReady = () => {
        const status = client.getStatus();
        return status.state === "connected" && status.readiness === "ready";
      };
      let ready = isReady();
      const removeStatus = client.subscribe(() => {
        const next = isReady();
        const reconnected = next && !ready;
        ready = next;
        if (reconnected) onResync();
      });
      return () => {
        removeStatus();
        removeEvents();
      };
    },
  };
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
}
