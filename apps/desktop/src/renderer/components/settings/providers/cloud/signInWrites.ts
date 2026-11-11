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
export type RunWrite = (id: string, write: () => Promise<ProviderLoginStatus> | undefined, failure: string) => Promise<boolean>;

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
 */
export async function confirmRemoveSignIn(args: {
  key: string;
  providerLabel: string;
  /** The computer it came from, and whether that is this one. */
  origin: string;
  originIsThisComputer: boolean;
  pin: OpenProjectBinding | null;
  hold: HeldWrites["hold"];
  runWrite: RunWrite;
}): Promise<void> {
  const { key, providerLabel, pin, runWrite } = args;
  const from = args.originIsThisComputer ? "this computer" : args.origin;
  const keeps = args.originIsThisComputer ? "This computer keeps its own sign-in." : `${args.origin} keeps its own sign-in.`;
  const ok = await confirmDialog({
    title: `Remove the ${providerLabel} sign-in from ${from}?`,
    message: `ADE Cloud stops using it, and each cloud computer drops it. ${keeps}`,
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return;
  args.hold({
    id: key,
    title: `Removed the ${providerLabel} sign-in from ${from}.`,
    write: () => {
      void runWrite(
        `remove:${key}`,
        () => window.ade?.providerLogins?.remove?.({ key }, pin),
        `ADE couldn't remove the ${providerLabel} sign-in. It is back on the page.`,
      );
    },
  });
}
