import { BRAND } from "../../../../shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, GithubLogo, LockSimple } from "@phosphor-icons/react";
import type { CloudFreeModelsState } from "../../../../shared/adeCloud";
import { refreshCloudAccount, useCloudAccount } from "../../../state/cloudAccountStore";
import {
  CloudFreeGithubHold,
  freeModelsLockHold,
  openGithubSettings,
  useCloudFreeUnlock,
} from "../../settings/cloudDashboard/CloudFreeGithubNotice";
import { Banner } from "../../ui/notice";
import { Dialog, openDialog, type DialogAction } from "../../ui/dialog";

/**
 * The one sheet for a locked ADE Free Model (`CloudFreeModelsState.locked`):
 * the account server holds them under the free plan's GitHub rule
 * (`freePlanGithub.ts`) until a GitHub account at least 30 days old is
 * connected, or a card is saved with no charge. The rows stay listed; picking
 * one opens this, never the model.
 *
 * "Add a card (no charge)" opens Stripe's page in the browser
 * (`openFreeUnlock`, account level, no pin) and the sheet waits for the card
 * in place: it reads the account again when the window comes back to the
 * front, every few seconds for a few minutes, and on "Check again". Once the
 * account reads unlocked it resolves, and the picker goes on to the consent
 * sheet (if the account hasn't said yes) and then picks the model.
 */

/** While a card page is open: one account read this often, for at most this long. "Check again" stays after. */
const WAIT_POLL_MS = 5_000;
const WAIT_POLL_FOR_MS = 3 * 60_000;

function AdeFreeModelsUnlockDialog({ onDone }: { onDone: (state: CloudFreeModelsState | null) => void }) {
  const account = useCloudAccount(true);
  const freeModels = account?.freeModels ?? null;
  const lock = freeModels?.locked ?? null;
  const [waiting, setWaiting] = useState(false);
  const doneRef = useRef(false);
  const finish = useCallback((state: CloudFreeModelsState | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(state);
  }, [onDone]);

  // The copy the picker read may be old (a card saved on another device): read it once on open.
  useEffect(() => {
    refreshCloudAccount();
  }, []);

  // Unlocked (here, in the browser, on another device, or the GitHub check came through): go on.
  useEffect(() => {
    if (freeModels && !freeModels.locked) finish(freeModels);
  }, [finish, freeModels]);

  // Waiting on the browser: the window coming back is the likely moment, and a light poll covers the rest.
  useEffect(() => {
    if (!waiting && lock?.reason !== "checking") return undefined;
    const onFocus = () => refreshCloudAccount();
    window.addEventListener("focus", onFocus);
    let timer: number | null = null;
    if (waiting) {
      const startedAt = Date.now();
      timer = window.setInterval(() => {
        if (Date.now() - startedAt > WAIT_POLL_FOR_MS) {
          if (timer != null) window.clearInterval(timer);
          timer = null;
          return;
        }
        if (document.visibilityState === "visible") refreshCloudAccount();
      }, WAIT_POLL_MS);
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer != null) window.clearInterval(timer);
    };
  }, [lock?.reason, waiting]);

  const { busy, addCard } = useCloudFreeUnlock({ purpose: "free-models", toast: false });
  const startCard = () => {
    void addCard().then((outcome) => {
      if (outcome === "opened") setWaiting(true);
    });
  };
  const connectGithub = () => {
    finish(null);
    openGithubSettings();
  };

  const hold = lock ? freeModelsLockHold(lock) : null;
  const checking = hold?.reason === "checking";
  const notNow: DialogAction = { label: "Not now", variant: "secondary", onClick: () => finish(null) };
  const checkAgain: DialogAction = { label: "Check again", variant: "secondary", onClick: refreshCloudAccount };
  let actions: DialogAction[];
  if (!hold) {
    actions = [notNow];
  } else if (waiting) {
    actions = [
      { label: "Open the card page again", variant: "link", busy, onClick: startCard },
      checkAgain,
      notNow,
    ];
  } else if (checking) {
    actions = [checkAgain, notNow];
  } else {
    actions = [
      ...(hold.canUnlockWithCard
        ? [{ label: "Add a card (no charge)", variant: "primary" as const, icon: <CreditCard />, busy, autoFocus: true, onClick: startCard }]
        : []),
      ...(hold.reason === "no_github"
        ? [{ label: "Connect GitHub", variant: "secondary" as const, icon: <GithubLogo />, onClick: connectGithub }]
        : []),
      notNow,
    ];
  }

  return (
    <Dialog
      open
      size="md"
      icon={<LockSimple size={16} weight="duotone" />}
      title={`Unlock ${BRAND.NAME} Free Models`}
      description={`They're free to use. ${BRAND.NAME} asks for GitHub or a payment card so each person gets one free account.`}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
      actions={actions}
      testId="ade-free-models-unlock"
    >
      {/* One box whatever the state, so the sheet doesn't jump between them. */}
      <div className="min-h-[76px]" aria-live="polite">
        {!hold ? (
          <Banner layout="inline" announce={false} model={{ id: "ade-free-models-unlock-reading", tone: "info", busy: true, title: "Checking your account…", report: false }} />
        ) : waiting ? (
          <Banner
            layout="inline"
            announce={false}
            testId="ade-free-models-unlock-waiting"
            model={{
              id: "ade-free-models-unlock-waiting",
              tone: "info",
              icon: <CreditCard />,
              busy: true,
              title: "Waiting for your card…",
              detail: "Save a card on the page that opened in your browser. You won't be charged. This moves on by itself once it's saved.",
              report: false,
            }}
          />
        ) : (
          <CloudFreeGithubHold hold={hold} purpose="free-models" testId="ade-free-models-unlock-reason" />
        )}
      </div>
    </Dialog>
  );
}

let asking: Promise<CloudFreeModelsState | null> | null = null;

/**
 * Opens the sheet; resolves the account's unlocked ADE Free Models state once
 * a card or GitHub unlocked them, or null when the person stopped (Not now,
 * closed, or went to connect GitHub). One sheet at a time.
 */
export function askAdeFreeModelsUnlock(): Promise<CloudFreeModelsState | null> {
  if (asking) return asking;
  asking = new Promise<CloudFreeModelsState | null>((resolve) => {
    openDialog((close) => (
      <AdeFreeModelsUnlockDialog
        onDone={(state) => {
          asking = null;
          resolve(state);
          close();
        }}
      />
    ), { key: "ade-free-models-unlock" });
  });
  return asking;
}
