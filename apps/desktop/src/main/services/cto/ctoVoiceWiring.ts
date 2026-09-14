import { BrowserWindow, type IpcMain } from "electron";

import { IPC } from "../../../shared/ipc";
import {
  CTO_VOICE_DESTRUCTIVE_TOOLS,
  CTO_VOICE_USD_PER_MINUTE,
  isVoiceCallLive,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
import { getMachineApiKey } from "../ai/apiKeyStore";
import { beginIdentityConfirmHold } from "../chat/identitySessionPolicy";
// Type-only, so it is erased at compile time and no import cycle exists at
// runtime even though `registerIpc` imports this module.
import type { AppContext } from "../ipc/registerIpc";
import {
  createCtoVoiceCallService,
  type CtoVoiceCallDeps,
  type CtoVoiceCallService,
} from "./ctoVoiceCallService";

/**
 * Transport for the CTO voice call.
 *
 * One call at a time: the CTO is a single project-level thread, so a second
 * concurrent call would be a second CTO. The service is built per call, not
 * kept for the life of the app, so each call reads the project, the lane and
 * the CTO's name as they are when it starts. The renderer gets state pushed to
 * it rather than polling, because the pill's phase and the interrupt have to
 * land in the same frame the audio does.
 *
 * Everything the service needs from the rest of ADE arrives through
 * `CtoVoiceWiringDeps`. That keeps `ctoVoiceCallService` free of imports on the
 * chat and memory services, which is what makes its delegation loop testable
 * without a model or a socket.
 */

/**
 * Everything the call needs from the rest of ADE.
 *
 * Derived from the service's own dep type rather than restated: the two had
 * already drifted on `persistCall`, and a new optional dep on the service would
 * otherwise be silently never supplied. What the wiring does NOT provide is
 * exactly the three the IPC layer owns — the two broadcast callbacks and the
 * socket factory the tests inject.
 */
export type CtoVoiceWiringDeps = Omit<
  CtoVoiceCallDeps,
  "onState" | "onOutputAudio" | "createWebSocket"
>;

/**
 * What the voice wiring needs from the app around it.
 *
 * `getCtx` is a getter, and the lane resolver a closure, because both change
 * under the app while it runs. A call started after a project switch must talk
 * about the project the user is actually looking at.
 */
export type CtoVoiceHost = {
  getCtx: () => AppContext;
  resolvePrimaryLaneId: () => Promise<string>;
  saveTempAttachment: (content: Buffer, filename: string) => Promise<{ path: string }>;
};

/**
 * Build the dependency factory for a CTO voice call.
 *
 * It lives beside the service rather than in `registerIpc` because none of it
 * is IPC: it is the CTO thread, the read-only window, and the durable call
 * transcript. `registerIpc` keeps the one line that registers the channels.
 */
export function createCtoVoiceWiringDeps(host: CtoVoiceHost): () => CtoVoiceWiringDeps | null {
  return () => {
    const ctx = host.getCtx();
    if (!ctx.agentChatService || !ctx.ctoStateService) return null;
    const agentChatService = ctx.agentChatService;
    const ctoStateService = ctx.ctoStateService;
    const ctoMemoryService = ctx.ctoMemoryService ?? null;

    /**
     * Released when this call hangs up; null when it holds nothing.
     *
     * Per call, not per factory. `beginIdentityConfirmHold` counts precisely so
     * two overlapping calls cannot release each other early, and a single hold
     * shared across calls threw that away: a failed call's late socket close
     * would release the hold a live call was relying on.
     */
    let releaseConfirmHold: (() => void) | null = null;
    /** The CTO session this call is driving, once confirm mode is on. */
    let callSessionId: string | null = null;

    /**
     * The interrupt fired by the last barge-in, still unwinding.
     *
     * `runSessionTurn` refuses a session that already has a turn running, and a
     * fire-and-forget interrupt does not finish before the superseding turn
     * asks for one — so the next answer used to be "That didn't work."
     */
    let inFlightInterrupt: Promise<unknown> = Promise.resolve();

    /**
     * A call puts the CTO in confirm-first mode, and restores full-auto when it
     * hangs up.
     *
     * The hold is what enforces it — see `beginIdentityConfirmHold`. Writing a
     * mode onto the session alone does nothing: the CTO is pinned to full-auto
     * by `normalizeIdentityPermissionMode`, and every path that sets an identity
     * session's permission mode re-runs that normalizer, including the
     * `ensureIdentitySession` call before each turn. A session-level change is
     * snapped back before the first word reaches a tool.
     *
     * The session write still happens, after the hold, so a session already in
     * memory flips now rather than at its next `ensureIdentitySession` and the
     * chat shows the right mode while the call runs.
     *
     * It is enforced in code rather than asked for in the prompt because a
     * misheard sentence must not be able to reach a tool that writes unasked.
     */
    const setCallConfirmMode = async (confirmFirst: boolean): Promise<void> => {
      if (!confirmFirst) {
        releaseConfirmHold?.();
        releaseConfirmHold = null;
      }
      // Take the hold BEFORE resolving the lane: resolution can fail, and a
      // call must never reach the socket with the CTO still on full-auto.
      if (confirmFirst && !releaseConfirmHold) releaseConfirmHold = beginIdentityConfirmHold();
      try {
        const laneId = await host.resolvePrimaryLaneId();
        if (!laneId) {
          // Only fail on the way in. On the way out a missing lane means there
          // is no session left to restore, which is not an error.
          if (confirmFirst) throw new Error("No primary lane is available to host the CTO chat session.");
          return;
        }
        const session = await agentChatService.ensureIdentitySession({ identityKey: "cto", laneId });
        callSessionId = confirmFirst ? session.id : null;
        await agentChatService.updateSession({
          sessionId: session.id,
          permissionMode: confirmFirst ? "default" : "full-auto",
        });
      } catch (error) {
        // A hold nobody will release leaves the CTO asking forever, so a failure
        // on the way in gives it back.
        if (confirmFirst) {
          releaseConfirmHold?.();
          releaseConfirmHold = null;
        }
        throw error;
      }
    };

    return {
      getApiKey: async () => {
        // A locked Windows `safeStorage` or a denied macOS Keychain makes this
        // throw. An unreadable store is "no key", not a crash: the throw used
        // to escape all the way out of the invoke, so Talk flickered and did
        // nothing instead of opening the key sheet.
        try {
          return getMachineApiKey("openai");
        } catch {
          return null;
        }
      },
      setCallConfirmMode,

      /**
       * Let a blocked turn through, or turn it away.
       *
       * `approveToolUse` is the same call the approval card in the chat makes,
       * so a spoken yes and a tap land on one code path — the call is a second
       * mouth on the CTO thread, not a second permission system.
       */
      resolveApproval: async ({ itemId, approved }) => {
        if (!callSessionId) return;
        await agentChatService.approveToolUse({
          sessionId: callSessionId,
          itemId,
          decision: approved ? "accept" : "decline",
        });
      },

      /**
       * Watch the CTO thread for approvals while a call is up.
       *
       * The gate lives in `canUseTool`, which parks the turn on a promise — so
       * nothing comes back through `runBackendTurn` to tell the call it is
       * waiting. Without this the user would hear the CTO go quiet mid-sentence
       * and have to find the chat to unblock it, which is the whole thing a
       * call exists to avoid.
       */
      watchApprovals: (onApproval: (a: { itemId: string; toolName: string; prompt: string }) => void) =>
        agentChatService.subscribeToEvents((envelope) => {
          if (!callSessionId || envelope.sessionId !== callSessionId) return;
          const event = envelope.event;
          if (event.type !== "approval_request") return;
          // `requestKind` distinguishes "approve this tool" from "answer this
          // question"; only the former is a yes/no a voice can carry.
          if (event.requestKind && event.requestKind !== "approval") return;
          onApproval({
            itemId: event.itemId,
            toolName: describeApprovalTool(event),
            prompt: event.description.trim() || "Go ahead?",
          });
        }),
      ctoName: () => ctoStateService.getIdentity().name || "CTO",
      // ProjectInfo carries no display name; the folder name is what the user
      // calls this project everywhere else in ADE.
      projectName: () => {
        const root = ctx.project?.rootPath ?? "";
        return root.split(/[\\/]/).filter(Boolean).pop() ?? "this project";
      },
      // Backchannels are a comfort setting, not a capability. Default on; the
      // toggle lives with the other voice settings.
      backchannelsEnabled: () => true,

      runBackendTurn: async ({ intent, imageBase64, signal }) => {
        const laneId = await host.resolvePrimaryLaneId();
        if (!laneId) throw new Error("No primary lane is available to host the CTO chat session.");
        const session = await agentChatService.ensureIdentitySession({
          identityKey: "cto",
          laneId,
        });

        const attachments = [];
        if (imageBase64) {
          const saved = await host.saveTempAttachment(
            Buffer.from(imageBase64, "base64"),
            `voice-capture-${Date.now()}.png`,
          );
          attachments.push({ path: saved.path, type: "image" as const });
        }

        // The framing matters: the thread is answering a person who is
        // listening, not reading. Without it the CTO writes a document and the
        // voice model has to read it aloud.
        // A barge-in aborts the controller the service handed us. The turn is
        // already running on the CTO's one session, so the only way to stop it
        // is to interrupt that session — otherwise superseded turns stack up
        // and each still speaks its answer over the next one.
        const onAbort = () => {
          // Published to the shared slot, not a local: the superseding turn
          // reads it immediately, long before this invocation's `finally`
          // could hand it over.
          inFlightInterrupt = agentChatService
            // `stop_only`, not `stop_and_clear`: the CTO thread is one shared
            // session, so clearing the queue would throw away a message the
            // user typed into the chat and is still waiting on.
            .interrupt({ sessionId: session.id, mode: "stop_only" })
            .catch(() => { /* the turn had already finished */ });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // The turn this one supersedes is still unwinding, and `runSessionTurn`
        // throws on a session that already has one running. Waiting for that
        // interrupt is the difference between the next answer and
        // "That didn't work."
        await inFlightInterrupt;
        try {
          const result = await agentChatService.runSessionTurn({
            sessionId: session.id,
            text: [
              "[voice call] The user is speaking with you right now and will hear your reply.",
              "Answer in at most three sentences, in plain spoken language, with no markdown, no lists and no code.",
              // The sentence below does not create the gate — the hold in
              // `setCallConfirmMode` does. It only tells the CTO what is about
              // to happen, so the pause reads as deliberate rather than broken.
              "You can do anything here that you can do in the chat. Before anything that writes, ADE will stop you and ask the user out loud — say what you are about to do in one short sentence and wait for their answer.",
              "",
              intent,
            ].join("\n"),
            displayText: intent,
            attachments,
          });

          return { spoken: result.outputText.trim() };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },

      persistCall: async ({ callId, startedAt, endedAt, captions, costUsd }) => {
        if (!ctoMemoryService) return;
        const minutes = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
        const lines = [
          `# Voice call ${callId}`,
          "",
          `- Started: ${startedAt}`,
          `- Ended: ${endedAt}`,
          `- Length: ${minutes.toFixed(1)} min`,
          `- Cost: $${costUsd.toFixed(2)} at $${CTO_VOICE_USD_PER_MINUTE.toFixed(2)}/min`,
          "",
          "## Transcript",
          "",
          ...captions.map((caption) => `**${caption.role}**: ${caption.text}`),
          "",
        ].join("\n");
        await ctoMemoryService.writeCallTranscript(callId, lines);
      },
    };
  };
}

/**
 * Send the call state to every window, telling exactly one of them it owns the
 * microphone.
 *
 * Every window mounts the HUD, so a call stays visible wherever the user is
 * working. Audio is different: two windows capturing means two PCM streams
 * interleaved into one socket, and two copies of the CTO's voice played back.
 */
/**
 * The tool name a voice confirmation should be judged against.
 *
 * `CTO_VOICE_DESTRUCTIVE_TOOLS` names ADE's own operations (`gitForcePush`,
 * `mergePr`), while a Claude approval names the SDK tool (`Bash`, `Write`). The
 * description is where the ADE operation actually appears, so it is searched
 * too — a force-push must reach the card path whichever layer raised it.
 */
function describeApprovalTool(event: { kind: string; description: string; detail?: unknown }): string {
  const haystack = `${event.description} ${typeof event.detail === "string" ? event.detail : ""}`;
  const named = (CTO_VOICE_DESTRUCTIVE_TOOLS as readonly string[])
    .find((tool) => haystack.toLowerCase().includes(tool.toLowerCase()));
  return named ?? event.kind;
}

function broadcastState(state: CtoVoiceState, ownerWebContentsId: number | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.ctoVoiceState, {
        ...state,
        isCallOwner: win.webContents.id === ownerWebContentsId,
      });
    } catch {
      // As above: a window closing mid-broadcast is not a call failure.
    }
  }
}

/** Output audio goes to the owning window only; nobody else may play it. */
function sendToOwner(channel: string, payload: unknown, ownerWebContentsId: number | null): void {
  if (ownerWebContentsId == null) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== ownerWebContentsId) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // The owning window closed; `ctoVoiceEnd` tears the call down.
    }
    return;
  }
}

export function registerCtoVoiceIpc(ipcMain: IpcMain, getDeps: () => CtoVoiceWiringDeps | null): void {
  let service: CtoVoiceCallService | null = null;
  /** The window that started the current call: the only one with the mic. */
  let ownerWebContentsId: number | null = null;
  /** Detaches the owner's close/reload watchers when the call is over. */
  let releaseOwnerWatch: (() => void) | null = null;

  /**
   * Serializes start and end.
   *
   * Tearing a call down is long — it hangs up the socket, gives the read-only
   * hold back (which resolves a lane and updates a session) and writes the
   * transcript — and it nulls `service` before all of that. Without this chain
   * the `if (service)` guard in the start handler is blind for the whole
   * teardown, so a second Talk press walks straight past it: two sockets, two
   * holds, and the newer call's ownership stomped by the older teardown when it
   * finally resumes. The stranded hold is the bad one — it leaves the CTO
   * unable to write in every chat for the life of the app.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    // The chain must not break on a rejection, and must not report one twice.
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const endCurrentCall = async (): Promise<void> => {
    const ending = service;
    if (!ending) return;
    // Captured, so a call started while this teardown is awaiting keeps its own
    // owner and watcher. Clearing unconditionally used to silence a live call's
    // microphone and leak the listeners of the window that owned it.
    const endingWatch = releaseOwnerWatch;
    const endingOwner = ownerWebContentsId;
    service = null;
    releaseOwnerWatch = null;
    endingWatch?.();
    await ending.end();
    // Cleared after `end`, so the final `ended` state still reaches the window
    // that owned the call — and only if nothing newer has claimed it since.
    if (ownerWebContentsId === endingOwner) ownerWebContentsId = null;
  };

  /**
   * End the call if the window holding the microphone goes away.
   *
   * Closing or reloading that window destroys the renderer's audio graph, so
   * the call is already over in every way that matters — but the socket, the
   * keep-alive and the CTO's read-only hold all live in the main process and
   * would survive. A reloaded window cannot rescue it either: its store starts
   * at `idle` and only learns otherwise from a state push, which needs audio it
   * is no longer sending. Left alone that is a CTO that silently refuses to
   * write for the rest of the session, with a billing socket still open.
   */
  const watchOwner = (sender: Electron.WebContents): void => {
    const finish = () => { void serialize(endCurrentCall); };
    // `did-navigate` covers a reload; `destroyed` covers the window closing.
    sender.on("did-navigate", finish);
    sender.once("destroyed", finish);
    releaseOwnerWatch = () => {
      try {
        sender.off("did-navigate", finish);
        sender.off("destroyed", finish);
      } catch {
        // The sender is already gone, which is the case this exists for.
      }
    };
  };

  ipcMain.handle(IPC.ctoVoiceStart, async (event): Promise<{ ok: boolean; error?: string }> => serialize(async () => {
    // One call at a time: the CTO is a single project-level thread, so a second
    // concurrent call would be a second CTO.
    if (service) {
      if (isVoiceCallLive(service.getState().phase)) return { ok: true };
      // A call can end without the wiring being told — the socket closes, or
      // errors — leaving `service`, the owner id and an attached watcher
      // behind. Without this, `watchOwner` below would overwrite the watcher
      // without detaching it: listeners pile up on that window, and a stale one
      // later hangs up whichever call happens to be live then.
      await endCurrentCall();
    }
    const deps = getDeps();
    if (!deps) return { ok: false, error: "unavailable" };
    // Built here rather than memoized for the life of the app. The deps close
    // over the project, the primary lane and the CTO's own name, all of which
    // change under a running app; a service kept from the first call would go
    // on describing the project the user has already left.
    ownerWebContentsId = event.sender.id;
    watchOwner(event.sender);
    service = createCtoVoiceCallService({
      ...deps,
      onState: (state) => broadcastState(state, ownerWebContentsId),
      onOutputAudio: (base64) => sendToOwner(IPC.ctoVoiceAudio, base64, ownerWebContentsId),
    });
    // A failed start must not leave its deps behind for the next attempt, and
    // `ipcMain.handle` has no catch of its own, so a throw would skip it.
    try {
      const result = await service.start();
      if (!result.ok) await endCurrentCall();
      return result;
    } catch (error) {
      await endCurrentCall();
      throw error;
    }
  }));

  ipcMain.handle(IPC.ctoVoiceEnd, async (): Promise<void> => {
    await serialize(endCurrentCall);
  });

  // Audio frames arrive continuously while a call runs. `on`, not `handle`:
  // a reply per frame would be pure overhead on the busiest channel in the app.
  ipcMain.on(IPC.ctoVoicePushAudio, (event, arg: { audio?: unknown; level?: unknown }) => {
    // A window that does not own the call has no business feeding the socket.
    if (ownerWebContentsId != null && event.sender.id !== ownerWebContentsId) return;
    const audio = typeof arg?.audio === "string" ? arg.audio : null;
    if (!audio) return;
    const level = typeof arg?.level === "number" ? arg.level : undefined;
    service?.pushAudio(audio, level);
  });

  ipcMain.handle(IPC.ctoVoiceSetMuted, async (_event, arg: { muted?: unknown }): Promise<void> => {
    service?.setMuted(Boolean(arg?.muted));
  });

  ipcMain.handle(IPC.ctoVoiceApprove, async (_event, arg: { id?: unknown }): Promise<void> => {
    if (typeof arg?.id === "string") service?.approve(arg.id);
  });

  ipcMain.handle(IPC.ctoVoiceDeny, async (_event, arg: { id?: unknown }): Promise<void> => {
    if (typeof arg?.id === "string") service?.deny(arg.id);
  });

  ipcMain.handle(IPC.ctoVoiceAttachImage, async (_event, arg: { pngBase64?: unknown; note?: unknown }): Promise<void> => {
    const pngBase64 = typeof arg?.pngBase64 === "string" ? arg.pngBase64 : null;
    if (!pngBase64) return;
    service?.attachImage({ pngBase64, note: typeof arg?.note === "string" ? arg.note : "" });
  });

  ipcMain.handle(IPC.ctoVoiceHasKey, async (): Promise<boolean> => {
    const deps = getDeps();
    if (!deps) return false;
    return Boolean(await deps.getApiKey().catch(() => null));
  });
}
