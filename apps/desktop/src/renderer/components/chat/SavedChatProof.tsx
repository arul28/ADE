import { Play, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CloudSavedChatProofResult } from "../../../shared/cloudSavedChats";
import { savedChatLocation, savedChatLocationForSession } from "../../state/cloudSavedChats";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { chatMachineReach, useChatMachineWake } from "./useChatMachineWake";

/**
 * Proof an ADE Cloud computer saved with a chat's copy before it rested
 * (`cloudProofSave.ts`): the cited picture, or a still of a cited video.
 * Read from the account (`window.ade.cloud.savedChats.readProof`) only while
 * the chat's computer rests or is gone, so it never wakes the computer.
 */
export type SavedChatProofState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; proof: CloudSavedChatProofResult };

/** What answered, by saved copy and artifact. A "none" is asked again after `NONE_KEPT_MS`: a later rest may save it. */
const answers = new Map<string, { at: number; proof: CloudSavedChatProofResult | null }>();
const pending = new Map<string, Promise<CloudSavedChatProofResult | null>>();
const NONE_KEPT_MS = 5 * 60_000;
/** The pictures kept in memory, as data URL characters (about 40 MiB). The oldest go first. */
const KEPT_CHARS = 40 * 1024 * 1024;
let keptChars = 0;

function remember(key: string, proof: CloudSavedChatProofResult | null): void {
  const old = answers.get(key);
  if (old?.proof) keptChars -= old.proof.dataUrl.length;
  answers.delete(key);
  answers.set(key, { at: Date.now(), proof });
  if (proof) keptChars += proof.dataUrl.length;
  for (const [oldest, entry] of answers) {
    if (keptChars <= KEPT_CHARS || oldest === key) break;
    if (entry.proof) keptChars -= entry.proof.dataUrl.length;
    answers.delete(oldest);
  }
}

function cached(key: string): { proof: CloudSavedChatProofResult | null } | null {
  const entry = answers.get(key);
  if (!entry) return null;
  if (!entry.proof && Date.now() - entry.at > NONE_KEPT_MS) return null;
  return entry;
}

/**
 * The saved copy of one cited proof, asked for only when `wanted` (the
 * chat's own read failed) and the chat's computer rests or is gone. The
 * account machine key comes from the chat's own saved location, never from
 * the tab's machine; an account read, so no pin.
 */
export function useSavedChatProof(artifactId: string, wanted: boolean): SavedChatProofState {
  const scope = useChatRuntimeScope();
  const reach = chatMachineReach(useChatMachineWake());
  const sessionId = scope.sessionId;
  const location = wanted && reach != null && sessionId
    ? savedChatLocation(scope.pin, sessionId, () => false) ?? savedChatLocationForSession(sessionId)
    : null;
  const readProof = window.ade?.cloud?.savedChats?.readProof;
  const machineKey = location?.readMachineKey ?? null;
  const chatId = location?.chatId ?? null;
  const key = machineKey && chatId && readProof ? `${machineKey}\0${chatId}\0${artifactId}` : null;
  const [answer, setAnswer] = useState<{ key: string; proof: CloudSavedChatProofResult | null } | null>(null);

  useEffect(() => {
    if (!key || !machineKey || !chatId || !readProof) return;
    const known = cached(key);
    if (known) {
      setAnswer({ key, proof: known.proof });
      return;
    }
    let cancelled = false;
    let request = pending.get(key);
    if (!request) {
      // Only an answer is remembered ("none saved" included); a failed read shows
      // nothing now and is asked again the next time the citation shows.
      request = readProof({ machineKey, chatId, artifactId })
        .then((proof) => {
          remember(key, proof);
          return proof;
        }, (error: unknown) => {
          console.warn("[cloud] reading a saved proof failed", error instanceof Error ? error.message : String(error));
          return null;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
    }
    void request.then((proof) => {
      if (!cancelled) setAnswer({ key, proof });
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId, chatId, key, machineKey, readProof]);

  if (!key) return { status: "off" };
  const known = answer?.key === key ? answer : cached(key);
  if (!known) return { status: "loading" };
  return known.proof ? { status: "ready", proof: known.proof } : { status: "none" };
}

/**
 * The saved picture where the live proof would be. A video shows its still
 * with "Wake to play" while the computer sleeps; the video itself plays only
 * from the computer. Spans only: it sits inside a paragraph.
 */
export function SavedProofPicture({ proof, label, compact = false, onWake }: {
  proof: CloudSavedChatProofResult;
  label: string;
  compact?: boolean;
  /** Wakes the chat's computer, then shows the live proof. Null when it can't wake (deleted). */
  onWake: (() => void) | null;
}) {
  const scope = useChatRuntimeScope();
  const machine = useChatMachineWake();
  const reach = chatMachineReach(machine);
  const video = proof.source === "video";
  const mediaHeight = compact ? "max-h-[300px]" : "max-h-[440px]";
  const note = video
    ? reach === "gone"
      ? `A still from the video. The video was on ${scope.machineName}, which was deleted.`
      : `A still from the video, saved while ${scope.machineName} rests.`
    : reach === "gone"
      ? `Saved copy. ${scope.machineName} was deleted.`
      : `Saved copy, shown while ${scope.machineName} rests.`;
  return (
    <span data-saved-proof="" className="block min-w-0">
      <span className="relative block w-fit max-w-full overflow-hidden rounded-xl border border-fg/[0.07] bg-black/25">
        <img src={proof.dataUrl} alt={label} className={cn("m-0 block h-auto max-w-full object-contain", mediaHeight)} />
        {video && onWake && reach !== "gone" ? (
          <span className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Button type="button" variant="outline" size="sm" casing="sentence" disabled={reach === "waking"} onClick={onWake}>
              {reach === "waking" ? <SpinnerGap size={14} className="animate-spin" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
              {reach === "waking" ? "Waking…" : "Wake to play"}
            </Button>
          </span>
        ) : null}
      </span>
      <span className="mt-1 block font-sans text-[length:calc(var(--chat-font-size)*10/14)] not-italic text-muted-fg/55">
        {note}
        {machine.error && reach === "asleep" ? ` ${machine.error}` : ""}
      </span>
    </span>
  );
}
