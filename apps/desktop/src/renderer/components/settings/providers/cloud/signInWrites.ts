/**
 * The account's sign-in changes that more than one page makes: "Use on ADE
 * Cloud" (confirm, write, toast with Undo) and Remove (confirm, then the held
 * write). The ADE Cloud page and a cloud computer's own page run the same
 * flow with the same words.
 *
 * Each flow keeps the pin it starts with: the write, its Undo and its held
 * Remove reach the same brain, even if the page's machine changes meanwhile.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { OpenProjectBinding } from "../../../../../shared/types";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { confirmDialog } from "../../../ui/dialog/confirm";
import { showToast } from "../../../app/toast/toastStore";
import { COPILOT_REPO_LINE } from "./adeCloudSignInModel";
import type { HeldWrites } from "./useHeldWrites";

/** One write: a busy id (a second press waits), the call, and the error toast's words. True when it went through. */
export type RunWrite = (id: string, write: () => Promise<ProviderLoginStatus | undefined> | undefined, failure: string) => Promise<boolean>;

/**
 * The writes of one page: `runWrite` and the busy ids. A second press of a
 * busy id starts nothing. `onStatus` gets a write's answer only while the
 * page is open and `keyRef` still holds the key the write started with.
 * Leaving the page while a write waits leaves nothing behind.
 */
export function useSignInWrites({
  keyRef,
  onStatus,
  warning,
}: {
  /** The pin key the page shows now. */
  keyRef: RefObject<string | null>;
  /** A write went through: `status` is its answer (undefined when it gave none), for the key it started with. */
  onStatus: (status: ProviderLoginStatus | undefined, keyAtStart: string | null) => void;
  /** The console line when a write fails. */
  warning: string;
}): { busy: ReadonlySet<string>; runWrite: RunWrite } {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const runWrite = useCallback<RunWrite>(async (id, write, failure) => {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    const keyAtStart = keyRef.current;
    try {
      const status = await write();
      if (mountedRef.current && keyRef.current === keyAtStart) onStatusRef.current(status ?? undefined, keyAtStart);
      return true;
    } catch (error) {
      console.warn(warning, error);
      if (mountedRef.current) showToast({ tone: "error", title: failure });
      return false;
    } finally {
      busyRef.current.delete(id);
      if (mountedRef.current) setBusy(new Set(busyRef.current));
    }
  }, [keyRef, warning]);
  return { busy, runWrite };
}

/** "Use on ADE Cloud": the confirm, the write, and a toast with Undo back to the pick before it. */
export async function confirmUseOnCloud(args: {
  provider: ProviderLoginProvider;
  key: string;
  slot: string | null;
  /** How the confirm and the toast name it: the email, "the sign-in from Mac Studio", or "your saved key". */
  name: string;
  /** The one in use now, for "a turn that runs now finishes on …". */
  current: { key: string; name: string } | null;
  /** The account's pick before this one (`cloud.inUse[place]`), or null for "the newest". */
  previous: string | null;
  /** The ADE Cloud place, for the toast's id. */
  place: string;
  busyId: string;
  pin: OpenProjectBinding | null;
  runWrite: RunWrite;
}): Promise<void> {
  const { provider, key, slot, name, current, previous, pin, runWrite } = args;
  const repo = provider === "copilot" ? ` ${COPILOT_REPO_LINE}` : "";
  const ok = await confirmDialog({
    title: `Use ${name} on ADE Cloud?`,
    message: current && current.key !== key
      ? `A turn that runs now finishes on ${current.name}. The next message in each cloud chat uses ${name}.${repo}`
      : `The next message in each cloud chat uses ${name}.${repo}`,
    confirmLabel: "Use it",
  });
  if (!ok) return;
  const done = await runWrite(
    args.busyId,
    () => window.ade?.providerLogins?.use?.({ provider, key, slot }, pin),
    "ADE couldn't change the sign-in for ADE Cloud. Try again.",
  );
  if (!done) return;
  showToast({
    id: `ade-cloud-use-${args.place}`,
    tone: "success",
    title: `ADE Cloud now uses ${name}`,
    actions: previous === key ? [] : [{
      label: "Undo",
      onClick: () => {
        void runWrite(
          `${args.busyId}:undo`,
          () => window.ade?.providerLogins?.use?.({ provider, key: previous, slot }, pin),
          "ADE couldn't change it back. Try again.",
        );
      },
    }],
  });
}

/**
 * Remove one sign-in from the account: the confirm, then the held write (the
 * card hides, the toast offers Undo, the write runs when the toast ends).
 * An account copied from several computers goes whole: every copy in `keys`.
 */
export async function confirmRemoveSignIn(args: {
  /** Every copy of the account the card stands for, the card's own key first (the hold and busy id). */
  keys: readonly string[];
  /** The account's name on the card (its email), for a card of several copies. */
  name?: string;
  providerLabel: string;
  /** The computer it came from, and whether that is this one. */
  origin: string;
  originIsThisComputer: boolean;
  pin: OpenProjectBinding | null;
  hold: HeldWrites["hold"];
  runWrite: RunWrite;
}): Promise<void> {
  const { keys, providerLabel, pin, runWrite } = args;
  const key = keys[0];
  if (!key) return;
  const several = keys.length > 1;
  const from = several
    ? `${keys.length} computers`
    : args.originIsThisComputer ? "this computer" : args.origin;
  const keeps = several
    ? "Each computer keeps its own sign-in."
    : args.originIsThisComputer ? "This computer keeps its own sign-in." : `${args.origin} keeps its own sign-in.`;
  const what = several && args.name ? `${providerLabel} sign-in for ${args.name}` : `${providerLabel} sign-in`;
  const ok = await confirmDialog({
    title: `Remove the ${what} from ${several ? "your ADE account" : from}?`,
    message: several
      ? `ADE removes its copies from all ${keys.length} computers. ADE Cloud stops using it, and each cloud computer drops it. ${keeps}`
      : `ADE Cloud stops using it, and each cloud computer drops it. ${keeps}`,
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return;
  args.hold({
    id: key,
    title: `Removed the ${what} from ${several ? "your ADE account" : from}.`,
    write: () => {
      void runWrite(
        `remove:${key}`,
        async () => {
          // One at a time: each write saves the account setting, and the last answer is the page's.
          // A copy that fails doesn't stop the others; the ones left are said.
          let status: ProviderLoginStatus | undefined;
          let lastError: unknown = null;
          let left = 0;
          for (const each of keys) {
            try {
              status = await window.ade?.providerLogins?.remove?.({ key: each }, pin);
            } catch (error) {
              lastError = error;
              left += 1;
            }
          }
          // None went: the page's own failure toast says it is back.
          if (left === keys.length) throw lastError;
          if (left > 0) {
            console.warn("[providers] removing a sign-in's copies failed for some", lastError);
            showToast({
              tone: "warning",
              title: `ADE removed ${keys.length - left} of ${keys.length} copies of the ${what}.`,
              message: `${left === 1 ? "One copy is" : `${left} copies are`} still in your ADE account and back on the page. Remove it again to take ${left === 1 ? "it" : "them"} out.`,
            });
          }
          return status;
        },
        `ADE couldn't remove the ${providerLabel} sign-in. It is back on the page.`,
      );
    },
  });
}
