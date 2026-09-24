import { useEffect, useRef } from "react";
import type { ChatLaunchSnapshot } from "../../../shared/types";
import {
  applyChatLaunchSnapshot,
  getChatLaunchEntry,
  getChatLaunchLocalRecord,
  getChatLaunchOriginClientId,
  useChatLaunchSelector,
} from "../../state/chatLaunchStore";
import { extractError } from "../../lib/format";
import type { WorkPtyLaunchArgs, WorkPtyLaunchResult } from "./cliLaunch";

/**
 * Starts the PTY for this window's new-lane CLI launches.
 *
 * The brain sets up the lane and then parks a CLI launch at `awaiting-client`:
 * the terminal is a renderer concern (xterm, the Work tab it opens in), so the
 * launching window starts it through the same `launchPtySession` path every
 * other Work CLI launch uses, then reports the session with `completeClient`.
 *
 * Mounted at the Work page level next to `useWorkSessions` — not in the draft
 * pane — so a launch still completes after the user navigates away from the
 * draft or the pane unmounts.
 */

// Launches whose PTY start is in flight. Module-level so a Work remount cannot
// start the same launch twice; an id leaves as soon as the launch leaves
// `awaiting-client`, so a retried launch can be started again.
const inFlight = new Set<string>();

const sameString = (a: string, b: string) => a === b;

const LOST_LAUNCH_MESSAGE =
  "This window can no longer start the CLI session (it was reloaded after the launch began). Delete the launch and start it again.";

export function useChatLaunchCliDriver(
  launchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>,
): void {
  const launchRef = useRef(launchPtySession);
  launchRef.current = launchPtySession;

  const awaitingSignature = useChatLaunchSelector((state) => {
    const originClientId = getChatLaunchOriginClientId();
    return Object.values(state.entries)
      .filter((entry) => entry.snapshot.kind === "cli"
        && entry.snapshot.phase === "awaiting-client"
        && entry.snapshot.originClientId === originClientId)
      .map((entry) => entry.launchId)
      .sort()
      .join("\n");
  }, sameString);

  useEffect(() => {
    const awaiting = new Set(awaitingSignature ? awaitingSignature.split("\n") : []);
    for (const id of [...inFlight]) {
      if (!awaiting.has(id)) inFlight.delete(id);
    }
    for (const launchId of awaiting) {
      if (inFlight.has(launchId)) continue;
      const entry = getChatLaunchEntry(launchId);
      if (!entry) continue;
      inFlight.add(launchId);
      const pin = entry.binding;
      const record = getChatLaunchLocalRecord(launchId);
      const report = (args: { sessionId?: string; error?: string }) => {
        const request = window.ade.chatLaunch.completeClient({ launchId, ...args }, pin);
        return Promise.resolve(request).then((snapshot: ChatLaunchSnapshot | null) => {
          if (snapshot) applyChatLaunchSnapshot(pin, snapshot);
          return snapshot;
        });
      };
      if (!record?.cli) {
        void report({ error: LOST_LAUNCH_MESSAGE }).catch(() => undefined);
        continue;
      }
      const snapshot = entry.snapshot;
      void launchRef.current({
        ...record.cli,
        laneId: snapshot.laneId,
        disposition: snapshot.mode,
        pin: record.pin,
      }).then(
        async (result) => {
          const snapshot = await report({ sessionId: result.sessionId });
          // The launch was cancelled (or otherwise left `awaiting-client`)
          // while the PTY started, so the host did not take this session:
          // close it rather than leave a terminal in a lane that is gone.
          if (!snapshot || snapshot.sessionId !== result.sessionId || snapshot.phase === "cancelled") {
            await window.ade.pty.dispose({ ptyId: result.ptyId, sessionId: result.sessionId }, record.pin)
              .catch((disposeError: unknown) => console.warn("chat launch orphan pty cleanup failed", disposeError));
          }
        },
        (error: unknown) => report({ error: extractError(error) }),
      ).catch((error: unknown) => {
        console.warn("chat launch completeClient failed", error);
      });
    }
  }, [awaitingSignature]);
}

export function resetChatLaunchCliDriverForTests(): void {
  inFlight.clear();
}
